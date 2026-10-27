import { describe, expect, it } from 'vitest';
import type { SwitchRecipientRow, SwitchRow } from './db/schema.js';
import { createSwitchSchema } from './schemas.js';
import { ApiError } from './shared/errors.js';
import {
    MAX_IMPORT_SWITCHES,
    buildExportFile,
    candidateIds,
    checkImportSwitches,
    parseExportFile,
    planImport,
    type ImportCandidate,
} from './transfer.js';

/**
 * Import validation, branch by branch (transfer.test.ts covers the round trip). An uploaded
 * file is untrusted input: anything malformed is reported per switch with a readable reason and
 * never sinks the valid switches next to it; the hosted service (allowPublicPage: false) skips a
 * switch carrying the self-host-only public page whole; a file timestamp that cannot be read is
 * dropped rather than written.
 */

const SW = '01890a5d-ac96-774b-bcce-b302099a8057';
const RC = '01890a5d-ac96-774b-bcce-b302099a8058';
const AC = '01890a5d-ac96-774b-bcce-b302099a8059';
const ENVELOPE = { format: 'quietletter-export', schemaVersion: 1 };

function fileSwitch(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: SW,
        title: 'For my family',
        state: 'active',
        createdAt: '2026-10-09T12:00:00.000Z',
        recipients: [{ id: RC, email: 'heir@example.com' }],
        actions: [
            {
                id: AC,
                type: 'message',
                config: { mode: 'readable' },
                payload: { mode: 'readable', readableContent: 'Hello.', schemaVersion: 1 },
            },
        ],
        ...over,
    };
}

const check = (raw: unknown, allowPublicPage = true) => checkImportSwitches([raw], { allowPublicPage })[0]!;

function code(fn: () => unknown): { code: string; message: string } | undefined {
    try {
        fn();
    } catch (err) {
        if (err instanceof ApiError) return { code: err.code, message: err.message };
        throw err;
    }
    return undefined;
}

describe('parseExportFile', () => {
    it('names the field when a current-version file has the wrong shape', () => {
        expect(code(() => parseExportFile({ ...ENVELOPE, switches: 'all of them' }))).toEqual({
            code: 'invalid_export_file',
            message: expect.stringMatching(/^switches: /),
        });
        expect(code(() => parseExportFile({ ...ENVELOPE, exportedAt: 'x'.repeat(65), switches: [] }))?.message).toMatch(
            /^exportedAt: /,
        );
        expect(code(() => parseExportFile({ ...ENVELOPE, source: 42, switches: [] }))?.message).toMatch(/^source: /);
    });

    it(`refuses a file with more than ${MAX_IMPORT_SWITCHES} switches`, () => {
        const switches = Array.from({ length: MAX_IMPORT_SWITCHES + 1 }, () => ({}));
        expect(code(() => parseExportFile({ ...ENVELOPE, switches }))).toMatchObject({ code: 'invalid_export_file' });
        expect(parseExportFile({ ...ENVELOPE, switches: switches.slice(1) }).switches).toHaveLength(
            MAX_IMPORT_SWITCHES,
        );
    });

    it('refuses a fractional or zero schema version as not an export file', () => {
        for (const schemaVersion of [0, 1.5, '1']) {
            expect(code(() => parseExportFile({ format: ENVELOPE.format, schemaVersion, switches: [] }))?.code).toBe(
                'invalid_export_file',
            );
        }
    });
});

describe('checkImportSwitches', () => {
    it('reports an entry that is not an object at all, with no id or title', () => {
        for (const raw of [null, 'switch', 7]) {
            const result = check(raw);
            expect(result).toMatchObject({ ok: false, result: { id: null, title: null, reason: 'invalid' } });
            expect(!result.ok && result.result.detail).toMatch(/^switch: /);
        }
    });

    it('keeps a readable id and title on the report, trimmed and capped', () => {
        const result = check({ id: 'x'.repeat(100), title: `  ${'t'.repeat(400)}  `, recipients: [], actions: [] });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.result.id).toHaveLength(64);
        expect(result.result.title).toHaveLength(300);
        expect(result.result.detail).toMatch(/^id: /);
        expect(check({ id: 12, title: { en: 'x' } })).toMatchObject({ result: { id: null, title: null } });
    });

    it('skips a switch with a public page whole on a backend that does not host them', () => {
        const raw = fileSwitch({
            actions: [{ id: AC, type: 'public_page', config: { mode: 'readable', slug: 'leak' } }],
        });
        expect(check(raw, false)).toEqual({
            ok: false,
            result: { id: SW, title: 'For my family', status: 'skipped', reason: 'self_host_only' },
        });
        expect(check(raw, true).ok).toBe(true);
    });

    it('refuses a switch reusing one of its own ids', () => {
        const raw = fileSwitch({ recipients: [{ id: AC, email: 'heir@example.com' }] });
        expect(check(raw)).toMatchObject({ ok: false, result: { detail: 'duplicate id in file' } });
    });

    it('re-validates the config with the regular write rules', () => {
        const result = check(fileSwitch({ title: '' }));
        expect(result).toMatchObject({ ok: false, result: { reason: 'invalid' } });
        expect(!result.ok && result.result.detail).toMatch(/^title: /);
    });

    it('refuses an unreadable payload schema version', () => {
        for (const schemaVersion of [0, 'one', 1001]) {
            const raw = fileSwitch({
                actions: [
                    {
                        id: AC,
                        type: 'message',
                        config: { mode: 'readable' },
                        payload: { mode: 'readable', readableContent: 'Hi', schemaVersion },
                    },
                ],
            });
            expect(check(raw)).toMatchObject({
                ok: false,
                result: { detail: `actions.${AC}.payload: invalid schemaVersion` },
            });
        }
    });

    it('defaults an absent payload schema version to 1 and skips a null payload', () => {
        const raw = fileSwitch({
            actions: [
                {
                    id: AC,
                    type: 'message',
                    config: { mode: 'readable' },
                    payload: { mode: 'readable', readableContent: 'Hi' },
                },
                { id: RC.replace('58', '5a'), type: 'secret', config: { mode: 'zk' }, payload: null },
            ],
        });
        const result = check(raw);
        expect(result.ok && result.candidate.payloads).toEqual([
            { actionId: AC, schemaVersion: 1, payload: expect.objectContaining({ readableContent: 'Hi' }) },
        ]);
    });

    it('drops a creation time that is absent or unreadable', () => {
        for (const createdAt of [undefined, 'last tuesday']) {
            const result = check(fileSwitch({ createdAt }));
            expect(result.ok && result.candidate.createdAt).toBeNull();
        }
        const ok = check(fileSwitch());
        expect(ok.ok && ok.candidate.createdAt?.toISOString()).toBe('2026-10-09T12:00:00.000Z');
    });
});

describe('planning', () => {
    const candidate = (): ImportCandidate => {
        const result = check(fileSwitch());
        if (!result.ok) throw new Error('fixture must be valid');
        return result.candidate;
    };

    it('lists the ids a candidate would insert, ignoring children without one', () => {
        expect(candidateIds(candidate())).toEqual({ switchId: SW, childIds: [RC, AC] });
        const bare = {
            ...candidate(),
            input: {
                ...createSwitchSchema.parse({ title: 'x' }),
                recipients: [{ email: 'a@b.co', phone: null, name: null }],
                actions: [{ type: 'message' as const, sortOrder: 0, config: { mode: 'readable' as const } }],
            },
        };
        expect(candidateIds(bare)).toEqual({ switchId: SW, childIds: [] });
    });

    it('passes an invalid switch through in file order, creating only the valid one', () => {
        const checks = checkImportSwitches([{ id: 'broken' }, fileSwitch()], { allowPublicPage: true });
        const plan = planImport(checks, {
            ownSwitchIds: new Set(),
            foreignSwitchIds: new Set(),
            takenChildIds: new Set(),
        });
        expect(plan.toCreate.map((c) => c.id)).toEqual([SW]);
        expect(plan.results.map((r) => [r.id, r.status])).toEqual([
            ['broken', 'skipped'],
            [SW, 'imported'],
        ]);
    });

    it('reports a switch id held by another owner as a conflict', () => {
        const plan = planImport([{ ok: true, candidate: candidate() }], {
            ownSwitchIds: new Set(),
            foreignSwitchIds: new Set([SW]),
            takenChildIds: new Set(),
        });
        expect(plan).toEqual({
            toCreate: [],
            results: [{ id: SW, title: 'For my family', status: 'skipped', reason: 'conflict' }],
        });
    });
});

describe('buildExportFile', () => {
    // A stored switch always has a check-in time (NOT NULL, set on create): only the optional fields can be missing.
    it('writes null for a missing phone, zone, language or name', () => {
        const T = new Date('2026-10-09T12:00:00.000Z');
        const row = {
            id: SW,
            title: 't',
            state: 'disarmed',
            cadence: { value: 7, unit: 'day' },
            grace: { value: 3, unit: 'day' },
            warnings: [],
            warningPhone: undefined,
            timezone: undefined,
            locale: undefined,
            lastCheckinAt: T,
            createdAt: T,
            recipients: [
                { id: RC, email: 'a@b.co', phone: undefined, name: undefined } as unknown as SwitchRecipientRow,
            ],
            actions: [],
        } as unknown as SwitchRow & { recipients: SwitchRecipientRow[]; actions: [] };
        const [sw] = buildExportFile([row], [], 'cloud', T).switches;
        expect(sw).toMatchObject({
            state: 'disarmed',
            warningPhone: null,
            timezone: null,
            locale: null,
            lastCheckinAt: T.toISOString(),
            recipients: [{ id: RC, email: 'a@b.co', phone: null, name: null }],
        });
    });
});
