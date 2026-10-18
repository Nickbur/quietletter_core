import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/client.js', () => import('./helpers/db.js').then((m) => m.pgliteClient()));

import { db } from '../src/db/client.js';
import {
    publicPages,
    releaseTokens,
    switchActions,
    switchPayloads,
    switchRecipients,
    switches,
    type SwitchActionRow,
} from '../src/db/schema.js';
import { createSwitchSchema } from '../src/schemas.js';
import {
    applySwitchImport,
    checkinSwitch,
    disarmSwitch,
    fillSwitchRegional,
    getOrCreateReleaseToken,
    planSwitchImport,
    publishPublicPage,
    upsertSwitch,
} from '../src/service.js';
import { ApiError } from '../src/shared/errors.js';
import { uuidv7 } from '../src/shared/id.js';
import type { ImportCandidate, ImportPlan } from '../src/transfer.js';
import { resetDb } from './helpers/db.js';
import { T0, at, seedSwitch, switchRow } from './helpers/switches.js';

/**
 * Service rules that are awkward to reach over HTTP: an import file that leaves config out gets
 * the same defaults as a regular save, a write that loses a race is reported (never silently
 * half-applied), and a public page is published once under a unique, readable slug — even when
 * two sweeps publish at the same moment.
 */

const NOW = new Date('2026-10-17T09:30:00.000Z');

beforeEach(async () => {
    await resetDb(db);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const exportEnvelope = (switchList: unknown[]) => ({
    format: 'quietletter-export',
    schemaVersion: 1,
    switches: switchList,
});

describe('upsertSwitch', () => {
    it('clears a recipient phone that an edit leaves out', async () => {
        const id = uuidv7();
        const rid = uuidv7();
        await upsertSwitch(
            id,
            createSwitchSchema.parse({
                title: 'x',
                recipients: [{ id: rid, email: 'heir@example.com', phone: '+1 555 0100', name: 'Heir' }],
            }),
        );
        const { row } = await upsertSwitch(
            id,
            createSwitchSchema.parse({ title: 'x', recipients: [{ id: rid, email: 'heir@example.com' }] }),
        );
        expect(row.recipients).toEqual([expect.objectContaining({ id: rid, phone: null, name: null })]);
    });
});

describe('importing', () => {
    /** An import is the owner's proof of life: fresh timer, defaults for what the file leaves out. */
    it('gives a switch the file leaves bare the regular defaults, and a fresh creation time', async () => {
        const id = uuidv7();
        const rid = uuidv7();
        const plan = await planSwitchImport(
            exportEnvelope([{ id, title: 'Bare', recipients: [{ id: rid, email: 'heir@example.com' }], actions: [] }]),
        );
        expect(await applySwitchImport(plan, NOW)).toMatchObject({ imported: 1, skipped: 0 });
        const row = await switchRow(id);
        expect(row).toMatchObject({
            state: 'active',
            cadence: { value: 30, unit: 'day' },
            grace: { value: 14, unit: 'day' },
            timezone: null,
            locale: null,
            warningPhone: null,
            createdAt: NOW,
            lastCheckinAt: NOW,
            nextDeadline: new Date('2026-11-16T09:30:00.000Z'),
        });
        expect(row.warnings).toHaveLength(3);
        const [recipient] = await db.select().from(switchRecipients);
        expect(recipient).toMatchObject({ id: rid, name: null, phone: null });
    });

    it('mints ids for recipients and actions a plan carries without one', async () => {
        const id = uuidv7();
        const candidate: ImportCandidate = {
            id,
            title: 'Hand-built',
            disarmed: false,
            createdAt: null,
            input: {
                ...createSwitchSchema.parse({ title: 'Hand-built' }),
                recipients: [{ email: 'heir@example.com', phone: null, name: null }],
                actions: [{ type: 'message', config: { mode: 'readable' } } as ImportCandidate['input']['actions'][0]],
            },
            payloads: [],
        };
        await applySwitchImport({ toCreate: [candidate], results: [{ id, title: 'Hand-built', status: 'imported' }] });
        const [recipient] = await db.select().from(switchRecipients);
        const [action] = await db.select().from(switchActions);
        expect(recipient?.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(action).toMatchObject({ switchId: id, sortOrder: 0 });
    });

    it('re-arms a switch imported disarmed on its first check-in', async () => {
        const id = uuidv7();
        const plan = await planSwitchImport(
            exportEnvelope([{ id, title: 'Paused', state: 'disarmed', recipients: [], actions: [] }]),
        );
        await applySwitchImport(plan, NOW);
        expect(await switchRow(id)).toMatchObject({ state: 'disarmed', armedAt: null });

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(at(0));
        const row = await checkinSwitch(id);
        expect(row).toMatchObject({ state: 'active', armedAt: at(0), disarmedAt: null });
    });

    it('answers 409 import_conflict when a switch appears between the plan and the write, writing nothing', async () => {
        const id = uuidv7();
        const plan = await planSwitchImport(
            exportEnvelope([
                { id: uuidv7(), title: 'Innocent', recipients: [], actions: [] },
                { id, title: 'Raced', recipients: [], actions: [] },
            ]),
        );
        await db.insert(switches).values({ id, title: 'Created meanwhile', nextDeadline: at(0) });
        const err = await applySwitchImport(plan, NOW).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect(err).toMatchObject({ statusCode: 409, code: 'import_conflict' });
        expect((await db.select().from(switches)).map((s) => s.title)).toEqual(['Created meanwhile']);
    });

    it('lets any other write failure through unchanged, rolling the whole import back', async () => {
        const plan = await planSwitchImport(
            exportEnvelope([{ id: uuidv7(), title: 'Ok', recipients: [], actions: [] }]),
        );
        const broken: ImportPlan = {
            ...plan,
            toCreate: [
                ...plan.toCreate,
                {
                    ...plan.toCreate[0]!,
                    id: uuidv7(),
                    // A payload for an action this switch does not have: a foreign-key violation, not a conflict.
                    payloads: [{ actionId: uuidv7(), schemaVersion: 1, payload: { mode: 'readable' } as never }],
                },
            ],
        };
        const err = await applySwitchImport(broken, NOW).catch((e: unknown) => e);
        expect(err).not.toBeInstanceOf(ApiError);
        expect(err).toBeInstanceOf(Error);
        expect(await db.select().from(switches)).toHaveLength(0);
    });
});

describe('a write that loses a race with a delete', () => {
    /** If the switch vanishes between the write and the read-back, the call fails instead of answering half. */
    function vanishOnSecondRead() {
        const real = db.query.switches.findFirst.bind(db.query.switches);
        let calls = 0;
        return vi.spyOn(db.query.switches, 'findFirst').mockImplementation(((...args: Parameters<typeof real>) => {
            calls++;
            return calls === 1 ? real(...args) : Promise.resolve(undefined);
        }) as typeof real);
    }

    it('fails a check-in, a disarm, an edit and a zone fill with an internal error', async () => {
        const { id } = await seedSwitch({ timezone: null });
        const writes: Array<[() => Promise<unknown>, string]> = [
            [() => checkinSwitch(id), 'checkin_failed'],
            [() => disarmSwitch(id), 'disarm_failed'],
            [() => upsertSwitch(id, createSwitchSchema.parse({ title: 'Edited' })), 'switch_upsert_failed'],
            [() => fillSwitchRegional(id, { timezone: 'Europe/Kyiv' }), 'regional_fill_failed'],
        ];
        for (const [write, message] of writes) {
            const spy = vanishOnSecondRead();
            await expect(write()).rejects.toThrow(message);
            spy.mockRestore();
        }
    });
});

describe('getOrCreateReleaseToken', () => {
    /** A recipient keeps one stable link across fire-email retries, and gets a new one once it expired. */
    it('reuses a live token and replaces an expired one', async () => {
        const { id, recipientIds } = await seedSwitch({ state: 'fired', firedAt: at(72) });
        const rid = recipientIds[0]!;
        const first = await getOrCreateReleaseToken(id, rid, at(72 + 90 * 24), at(72));
        expect(first).toMatch(/^[\w-]{43}$/);
        expect(await getOrCreateReleaseToken(id, rid, at(72 + 90 * 24), at(73))).toBe(first);

        const later = await getOrCreateReleaseToken(id, rid, at(72 + 200 * 24), at(72 + 91 * 24));
        expect(later).not.toBe(first);
        expect(await db.select().from(releaseTokens)).toHaveLength(2);
    });
});

describe('publishPublicPage', () => {
    /** One page per action, under a unique readable slug; nothing is published without content. */
    async function publicAction(config: SwitchActionRow['config'], title = 'For my family') {
        const { id } = await seedSwitch({ title, state: 'fired', firedAt: at(72) });
        const [action] = await db
            .insert(switchActions)
            .values({ switchId: id, type: 'public_page', config })
            .returning();
        return { switchId: id, action: action! };
    }

    it('takes the slug from the config, else the subject, else the title, else "page"', async () => {
        const cases: Array<[SwitchActionRow['config'], string, string]> = [
            [{ mode: 'readable', slug: 'my-statement', subject: 'Ignored' }, 'T', 'my-statement'],
            [{ mode: 'readable', subject: '  The Whole Truth!  ' }, 'T', 'the-whole-truth'],
            [{ mode: 'readable' }, 'Für Alle — 2026', 'f-r-alle-2026'],
            [{ mode: 'readable' }, '!!!', 'page'],
        ];
        for (const [config, title, slug] of cases) {
            const { switchId, action } = await publicAction(config);
            expect(await publishPublicPage(switchId, action, 'Body', title, at(72))).toBe(slug);
        }
        const page = await db.query.publicPages.findFirst({ where: eq(publicPages.slug, 'page') });
        expect(page).toMatchObject({ title: '!!!', content: 'Body', publishedAt: at(72) });
    });

    it('caps a long slug at 96 characters', async () => {
        const { switchId, action } = await publicAction({ mode: 'readable' });
        const slug = await publishPublicPage(switchId, action, 'Body', 'word '.repeat(40), at(72));
        expect(slug).toHaveLength(96);
        expect(slug).not.toMatch(/-$/);
    });

    it('adds a random suffix when the slug is taken by another action', async () => {
        const a = await publicAction({ mode: 'readable', slug: 'statement' });
        const b = await publicAction({ mode: 'readable', slug: 'statement' });
        expect(await publishPublicPage(a.switchId, a.action, 'First', 'A', at(72))).toBe('statement');
        expect(await publishPublicPage(b.switchId, b.action, 'Second', 'B', at(72))).toMatch(/^statement-[0-9a-f]{6}$/);
        expect(await db.select().from(publicPages)).toHaveLength(2);
    });

    it('reuses the page already published for the action, and publishes nothing without content', async () => {
        const { switchId, action } = await publicAction({ mode: 'readable', slug: 'once' });
        expect(await publishPublicPage(switchId, action, null, 'T', at(72))).toBeNull();
        expect(await publishPublicPage(switchId, action, 'Body', 'T', at(72))).toBe('once');
        expect(await publishPublicPage(switchId, action, 'Changed', 'T', at(73))).toBe('once');
        const pages = await db.select().from(publicPages);
        expect(pages).toEqual([expect.objectContaining({ slug: 'once', content: 'Body' })]);
    });

    it('returns the slug a concurrent sweep published first, without publishing twice', async () => {
        const { switchId, action } = await publicAction({ mode: 'readable', slug: 'raced' });
        await db
            .insert(publicPages)
            .values({ slug: 'raced-by-other', switchId, actionId: action.id, title: 'T', content: 'Theirs' });
        // This sweep read "not published yet" just before the other one wrote.
        vi.spyOn(db.query.publicPages, 'findFirst').mockResolvedValueOnce(undefined);
        expect(await publishPublicPage(switchId, action, 'Ours', 'T', at(72))).toBe('raced-by-other');
        expect(await db.select().from(publicPages)).toHaveLength(1);
    });
});

describe('payload rows', () => {
    it('keeps the payload of a kept action and drops the payload of a removed one', async () => {
        const { id, actionIds } = await seedSwitch({
            actions: [
                { type: 'message', payload: 'readable' },
                { type: 'secret', payload: 'zk' },
            ],
        });
        const actions = await db.query.switchActions.findMany({ where: eq(switchActions.switchId, id) });
        const kept = actions.find((a) => a.id === actionIds[0])!;
        await upsertSwitch(
            id,
            createSwitchSchema.parse({
                title: 'x',
                actions: [{ id: kept.id, type: kept.type, config: kept.config }],
            }),
        );
        const payloads = await db.select().from(switchPayloads);
        expect(payloads.map((p) => p.actionId)).toEqual([actionIds[0]]);
        expect((await switchRow(id)).lastCheckinAt).toEqual(T0);
    });
});
