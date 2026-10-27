import { describe, expect, it } from 'vitest';
import type { SwitchActionRow, SwitchPayloadRow, SwitchRecipientRow, SwitchRow } from './db/schema.js';
import { ApiError } from './shared/errors.js';
import {
    EXPORT_FORMAT,
    EXPORT_SCHEMA_VERSION,
    buildExportFile,
    checkImportSwitches,
    exportFileName,
    importReport,
    parseExportFile,
    planImport,
    type ImportCheck,
    type ImportLookup,
} from './transfer.js';

/**
 * Switch export / import. These lock in the promises the public docs make: payloads
 * travel exactly as stored (ZK stays ciphertext), fired switches never travel, a file
 * from a newer version fails clearly, every safety floor still applies on the way in,
 * this core accepts the self-host-only public page, and a repeated import skips
 * instead of duplicating.
 */

const T0 = new Date('2026-10-09T12:00:00.000Z');
const SW = '01890a5d-ac96-774b-bcce-b302099a8057';
const RC = '01890a5d-ac96-774b-bcce-b302099a8058';
const AC = '01890a5d-ac96-774b-bcce-b302099a8059';
const AC2 = '01890a5d-ac96-774b-bcce-b302099a805a';

type Full = SwitchRow & { recipients: SwitchRecipientRow[]; actions: SwitchActionRow[] };

function switchRow(over: Partial<Full> = {}): Full {
    return {
        id: SW,
        title: 'For my family',
        state: 'active',
        cadence: { value: 30, unit: 'day' },
        grace: { value: 14, unit: 'day' },
        warnings: [{ offsetHours: 0, channels: ['push', 'email'] }],
        warningPhone: null,
        timezone: 'Europe/Kyiv',
        locale: null,
        lastCheckinAt: T0,
        nextDeadline: T0,
        armedAt: T0,
        firedAt: null,
        disarmedAt: null,
        createdAt: T0,
        updatedAt: T0,
        recipients: [{ id: RC, switchId: SW, email: 'heir@example.com', phone: null, name: 'Heir', createdAt: T0 }],
        actions: [
            {
                id: AC,
                switchId: SW,
                type: 'secret',
                sortOrder: 0,
                config: { mode: 'zk' },
                createdAt: T0,
                updatedAt: T0,
            },
            {
                id: AC2,
                switchId: SW,
                type: 'message',
                sortOrder: 1,
                config: { mode: 'readable', subject: 'Hello' },
                createdAt: T0,
                updatedAt: T0,
            },
        ],
        ...over,
    };
}

const zkPayload: SwitchPayloadRow = {
    id: 'pay-1',
    switchId: SW,
    actionId: AC,
    mode: 'zk',
    ciphertext: 'Y2lwaGVydGV4dA',
    wrappedKey: 'd3JhcHBlZA',
    salt: 'c2FsdA',
    nonce: 'bm9uY2U',
    algo: 'xchacha20poly1305-argon2id-v1',
    blobRef: null,
    size: 42,
    readableContent: null,
    schemaVersion: 1,
    createdAt: T0,
    updatedAt: T0,
};

/** A file as it arrives over the wire (JSON round-trip). */
function exported(rows: Full[] = [switchRow()], payloads: SwitchPayloadRow[] = [zkPayload]): Record<string, unknown> {
    return JSON.parse(JSON.stringify(buildExportFile(rows, payloads, 'self-host', T0))) as Record<string, unknown>;
}

function rawSwitches(file: Record<string, unknown>): Record<string, unknown>[] {
    return file.switches as Record<string, unknown>[];
}

function publicPageSwitch(mode: 'zk' | 'readable'): Full {
    return switchRow({
        actions: [
            {
                id: AC,
                switchId: SW,
                type: 'public_page',
                sortOrder: 0,
                config: { mode, slug: 'my-statement' },
                createdAt: T0,
                updatedAt: T0,
            },
        ],
    });
}

const emptyLookup = (): ImportLookup => ({
    ownSwitchIds: new Set(),
    foreignSwitchIds: new Set(),
    takenChildIds: new Set(),
});

function apiCode(fn: () => unknown): string | undefined {
    try {
        fn();
    } catch (err) {
        return err instanceof ApiError ? err.code : 'not_api_error';
    }
    return undefined;
}

describe('buildExportFile', () => {
    it('writes a versioned envelope with payloads verbatim', () => {
        const file = buildExportFile([switchRow()], [zkPayload], 'self-host', T0);
        expect(file.format).toBe(EXPORT_FORMAT);
        expect(file.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
        expect(file.exportedAt).toBe(T0.toISOString());
        expect(file.source).toBe('self-host');
        const [sw] = file.switches;
        expect(sw?.timezone).toBe('Europe/Kyiv');
        expect(sw?.recipients).toEqual([{ id: RC, email: 'heir@example.com', phone: null, name: 'Heir' }]);
        expect(sw?.actions[0]?.payload).toEqual({
            mode: 'zk',
            ciphertext: 'Y2lwaGVydGV4dA',
            wrappedKey: 'd3JhcHBlZA',
            salt: 'c2FsdA',
            nonce: 'bm9uY2U',
            algo: 'xchacha20poly1305-argon2id-v1',
            blobRef: null,
            size: 42,
            readableContent: null,
            schemaVersion: 1,
        });
        // An action whose content was never uploaded travels with a null payload.
        expect(sw?.actions[1]?.payload).toBeNull();
    });

    it('never exports a fired switch', () => {
        const file = buildExportFile([switchRow({ state: 'fired', firedAt: T0 })], [zkPayload], 'self-host', T0);
        expect(file.switches).toEqual([]);
    });

    it('names the file by UTC date', () => {
        expect(exportFileName(T0)).toBe('quietletter-export-2026-10-09.json');
    });
});

describe('parseExportFile', () => {
    it('accepts a valid file and ignores unknown fields', () => {
        const parsed = parseExportFile({ ...exported(), extra: true });
        expect(parsed.switches).toHaveLength(1);
    });

    it('rejects anything that is not a Quietletter export', () => {
        expect(apiCode(() => parseExportFile({ switches: [] }))).toBe('invalid_export_file');
        expect(apiCode(() => parseExportFile({ format: 'other', schemaVersion: 1, switches: [] }))).toBe(
            'invalid_export_file',
        );
        expect(apiCode(() => parseExportFile(null))).toBe('invalid_export_file');
    });

    it('rejects a newer schema version with its own code', () => {
        expect(apiCode(() => parseExportFile({ format: EXPORT_FORMAT, schemaVersion: 2, whatever: [] }))).toBe(
            'unsupported_export_version',
        );
    });
});

describe('checkImportSwitches', () => {
    it('round-trips an exported switch into an import candidate', () => {
        const [check] = checkImportSwitches(rawSwitches(exported()), { allowPublicPage: true });
        expect(check?.ok).toBe(true);
        if (!check?.ok) return;
        const c = check.candidate;
        expect(c.id).toBe(SW);
        expect(c.disarmed).toBe(false);
        expect(c.createdAt?.toISOString()).toBe(T0.toISOString());
        expect(c.input.timezone).toBe('Europe/Kyiv');
        expect(c.input.recipients[0]?.id).toBe(RC);
        expect(c.input.actions.map((a) => a.id)).toEqual([AC, AC2]);
        expect(c.payloads).toEqual([
            {
                actionId: AC,
                schemaVersion: 1,
                payload: expect.objectContaining({
                    mode: 'zk',
                    ciphertext: 'Y2lwaGVydGV4dA',
                    wrappedKey: 'd3JhcHBlZA',
                }),
            },
        ]);
    });

    it('keeps a disarmed switch disarmed', () => {
        const file = exported([switchRow({ state: 'disarmed', disarmedAt: T0 })]);
        const [check] = checkImportSwitches(rawSwitches(file), { allowPublicPage: true });
        expect(check?.ok && check.candidate.disarmed).toBe(true);
    });

    it('accepts a readable public page with its slug, but never a zk one', () => {
        const [ok] = checkImportSwitches(rawSwitches(exported([publicPageSwitch('readable')], [])), {
            allowPublicPage: true,
        });
        expect(ok?.ok && ok.candidate.input.actions[0]?.config.slug).toBe('my-statement');

        const [bad] = checkImportSwitches(rawSwitches(exported([publicPageSwitch('zk')], [])), {
            allowPublicPage: true,
        });
        expect(bad?.ok === false && bad.result.reason).toBe('invalid');
    });

    it('still enforces the 48h grace floor on the way in', () => {
        const file = exported();
        const sw = rawSwitches(file)[0];
        if (sw) sw.grace = { value: 1, unit: 'day' };
        const [check] = checkImportSwitches(rawSwitches(file), { allowPublicPage: true });
        expect(check?.ok === false && check.result.reason).toBe('invalid');
    });

    it('rejects an incomplete zk payload and an externalized blob', () => {
        const noKey = exported([switchRow()], [{ ...zkPayload, wrappedKey: null }]);
        const [a] = checkImportSwitches(rawSwitches(noKey), { allowPublicPage: true });
        expect(a?.ok === false && a.result.reason).toBe('invalid');

        const blob = exported([switchRow()], [{ ...zkPayload, blobRef: 'upload/123' }]);
        const [b] = checkImportSwitches(rawSwitches(blob), { allowPublicPage: true });
        expect(b?.ok === false && b.result.detail).toContain('externalized');
    });

    it('rejects a switch reusing an id already used earlier in the file', () => {
        const file = exported([switchRow(), switchRow()]);
        const checks = checkImportSwitches(rawSwitches(file), { allowPublicPage: true });
        expect(checks[0]?.ok).toBe(true);
        expect(checks[1]?.ok === false && checks[1].result.detail).toBe('duplicate id in file');
    });

    it('reports an unreadable switch without sinking the others', () => {
        const file = exported();
        const checks = checkImportSwitches([{ title: 'no id' }, ...rawSwitches(file)], { allowPublicPage: true });
        expect(checks[0]).toMatchObject({ ok: false, result: { id: null, title: 'no id', reason: 'invalid' } });
        expect(checks[1]?.ok).toBe(true);
    });
});

describe('planImport', () => {
    const checks = (): ImportCheck[] => checkImportSwitches(rawSwitches(exported()), { allowPublicPage: true });

    it('creates a switch that is new here', () => {
        const plan = planImport(checks(), emptyLookup());
        expect(plan.toCreate.map((c) => c.id)).toEqual([SW]);
        expect(plan.results).toEqual([{ id: SW, title: 'For my family', status: 'imported' }]);
    });

    it('skips a switch that is already here (a repeated import never duplicates)', () => {
        const plan = planImport(checks(), { ...emptyLookup(), ownSwitchIds: new Set([SW]) });
        expect(plan.toCreate).toEqual([]);
        expect(plan.results[0]).toMatchObject({ status: 'skipped', reason: 'exists' });
    });

    it('reports a conflict for a child id already used by another switch', () => {
        const plan = planImport(checks(), { ...emptyLookup(), takenChildIds: new Set([AC2]) });
        expect(plan.toCreate).toEqual([]);
        expect(plan.results[0]).toMatchObject({ status: 'skipped', reason: 'conflict' });
    });

    it('summarizes the outcome', () => {
        const plan = planImport(checks(), { ...emptyLookup(), ownSwitchIds: new Set([SW]) });
        expect(importReport(plan.results)).toMatchObject({ imported: 0, skipped: 1 });
    });
});
