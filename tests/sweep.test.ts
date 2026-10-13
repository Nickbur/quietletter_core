import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A real Postgres (PGlite, in-process) with the core's migrations applied, so the
 * sweep's SQL — the delivery ledger's unique index, `ON CONFLICT DO NOTHING`, the
 * compare-and-set transitions, the retention deletes — runs exactly as in production.
 */
vi.mock('../src/db/client.js', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const schema = await import('../src/db/schema.js');
    const client = new PGlite();
    return { db: drizzle(client, { schema }), pool: { end: async () => {} }, schema, pglite: client };
});

const h = vi.hoisted(() => ({
    warningEmail: vi.fn(async (..._args: unknown[]) => {}),
    fireEmail: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('../src/env.js', () => ({
    env: { PUBLIC_URL: 'https://core.example.com', FIRE_RETENTION_DAYS: 90, OWNER_EMAIL: 'owner@example.com' },
}));
vi.mock('../src/shared/email.service.js', () => ({ sendWarningEmail: h.warningEmail, sendFireEmail: h.fireEmail }));

import { db } from '../src/db/client.js';
import {
    publicPages,
    releaseTokens,
    switchActions,
    switchPayloads,
    switchRecipients,
    switches,
    type GraceConfig,
    type WarningStep,
} from '../src/db/schema.js';
import { createSwitchSchema } from '../src/schemas.js';
import { checkinSwitch, disarmSwitch, fillSwitchRegional, upsertSwitch } from '../src/service.js';
import { ApiError } from '../src/shared/errors.js';
import { uuidv7 } from '../src/shared/id.js';
import { runSweep, transitionSwitch } from '../src/sweep.js';

/**
 * The fire engine of a dead man's switch: it must warn on time, never fire early (the
 * 48h grace floor, a check-in racing the sweep, a disarmed switch), fire exactly once,
 * deliver to every recipient exactly once (retrying failures for a bounded window),
 * publish a public page once and keep it, and purge on schedule.
 */

const HOUR = 3_600_000;
const T0 = new Date('2026-10-01T00:00:00.000Z'); // last check-in
const DEADLINE = new Date('2026-10-08T00:00:00.000Z'); // T0 + 7 days
const at = (hoursAfterDeadline: number): Date => new Date(DEADLINE.getTime() + hoursAfterDeadline * HOUR);

const GRACE_3D: GraceConfig = { value: 3, unit: 'day' };
const WARNINGS: WarningStep[] = [
    { offsetHours: 0, channels: ['push', 'email'] },
    { offsetHours: 24, channels: ['email'] },
    { offsetHours: 100, channels: ['email'] }, // lands after the 72h grace end → never sent
];

interface SeedOptions {
    state?: 'active' | 'grace' | 'disarmed' | 'fired';
    grace?: GraceConfig;
    timezone?: string | null;
    locale?: string | null;
    firedAt?: Date | null;
    recipients?: string[];
    /** `zk` / `readable` = an uploaded payload of that mode; `none` = configured, never uploaded. */
    actions?: Array<{
        type: 'message' | 'secret' | 'public_page';
        payload: 'zk' | 'readable' | 'none';
        subject?: string;
    }>;
}

async function seedSwitch(o: SeedOptions = {}): Promise<string> {
    const id = uuidv7();
    await db.insert(switches).values({
        id,
        title: 'For my family',
        state: o.state ?? 'active',
        cadence: { value: 7, unit: 'day' },
        grace: o.grace ?? GRACE_3D,
        warnings: WARNINGS,
        timezone: o.timezone ?? null,
        locale: o.locale ?? null,
        lastCheckinAt: T0,
        nextDeadline: DEADLINE,
        armedAt: T0,
        firedAt: o.firedAt ?? null,
    });
    for (const email of o.recipients ?? ['heir@example.com']) {
        await db.insert(switchRecipients).values({ switchId: id, email });
    }
    for (const [i, a] of (o.actions ?? [{ type: 'message', payload: 'readable' }]).entries()) {
        const [action] = await db
            .insert(switchActions)
            .values({
                switchId: id,
                type: a.type,
                sortOrder: i,
                config:
                    a.type === 'public_page'
                        ? { mode: 'readable', slug: 'my-statement' }
                        : {
                              mode: a.payload === 'zk' ? 'zk' : 'readable',
                              ...(a.subject ? { subject: a.subject } : {}),
                          },
            })
            .returning();
        if (!action || a.payload === 'none') continue;
        await db.insert(switchPayloads).values(
            a.payload === 'zk'
                ? {
                      switchId: id,
                      actionId: action.id,
                      mode: 'zk',
                      ciphertext: 'Y2lwaGVy',
                      wrappedKey: 'd3JhcA',
                      salt: 'c2FsdA',
                      nonce: 'bm9uY2U',
                      algo: 'xchacha20poly1305-argon2id-v1',
                  }
                : { switchId: id, actionId: action.id, mode: 'readable', readableContent: 'I love you all.' },
        );
    }
    return id;
}

async function stateOf(id: string) {
    const row = await db.query.switches.findFirst({ where: eq(switches.id, id) });
    if (!row) throw new Error('switch missing');
    return row;
}

async function apiCode(fn: () => Promise<unknown>): Promise<string | undefined> {
    try {
        await fn();
    } catch (err) {
        return err instanceof ApiError ? `${err.statusCode} ${err.code}` : 'not_api_error';
    }
    return undefined;
}

beforeAll(async () => {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle/migrations', import.meta.url)) });
}, 60_000);

afterAll(async () => {
    const mod = (await import('../src/db/client.js')) as unknown as { pglite: { close: () => Promise<void> } };
    await mod.pglite.close();
});

beforeEach(async () => {
    await db.execute(sql`TRUNCATE quietletter_switches CASCADE`);
    vi.clearAllMocks();
    h.fireEmail.mockImplementation(async () => {});
});

describe('before the deadline', () => {
    it('leaves the switch alone', async () => {
        const id = await seedSwitch();
        const r = await runSweep(at(-1));
        expect(r.scanned).toBe(0);
        expect((await stateOf(id)).state).toBe('active');
    });

    it('never touches a disarmed switch, however overdue', async () => {
        const id = await seedSwitch({ state: 'disarmed' });
        await runSweep(at(500));
        expect((await stateOf(id)).state).toBe('disarmed');
        expect(h.fireEmail).not.toHaveBeenCalled();
    });
});

describe('grace and warnings', () => {
    it('moves to grace and emails the owner exactly once per step', async () => {
        const id = await seedSwitch();
        expect((await runSweep(at(1))).warned).toBe(1);
        expect((await stateOf(id)).state).toBe('grace');
        expect(h.warningEmail).toHaveBeenCalledOnce();
        expect(h.warningEmail.mock.calls[0]?.[0]).toBe('owner@example.com');

        expect((await runSweep(at(2))).warned).toBe(0);
        expect(h.warningEmail).toHaveBeenCalledOnce();
    });

    it("hands the switch's own zone to the warning email (null on a legacy switch)", async () => {
        await seedSwitch({ timezone: 'Europe/Kyiv' });
        await runSweep(at(1));
        expect(h.warningEmail.mock.calls[0]?.[1]).toMatchObject({ timeZone: 'Europe/Kyiv' });

        await seedSwitch({ timezone: null });
        await runSweep(at(1));
        expect(h.warningEmail.mock.calls[1]?.[1]).toMatchObject({ timeZone: null });
    });

    it("writes the warning and the recipients' emails in the switch's language", async () => {
        await seedSwitch({ locale: 'ru' });
        await runSweep(at(1));
        expect(h.warningEmail.mock.calls[0]?.[1]).toMatchObject({ locale: 'ru' });
        await runSweep(at(72));
        expect(h.fireEmail.mock.calls[0]?.[1]).toMatchObject({ locale: 'ru' });
    });

    it('escalates on schedule and never warns past the grace end', async () => {
        await seedSwitch();
        await runSweep(at(25));
        expect(h.warningEmail).toHaveBeenCalledTimes(2); // 0h + 24h steps
        await runSweep(at(71));
        expect(h.warningEmail).toHaveBeenCalledTimes(2); // the 100h step is past the 72h grace end
    });
});

describe('firing', () => {
    it('never fires before the 48h floor, even if a smaller grace reached the database', async () => {
        const id = await seedSwitch({ grace: { value: 1, unit: 'hour' } });
        await runSweep(at(47));
        expect((await stateOf(id)).state).toBe('grace');
        await runSweep(at(48));
        expect((await stateOf(id)).state).toBe('fired');
    });

    it('fires once and delivers to every recipient once', async () => {
        const id = await seedSwitch({
            recipients: ['a@example.com', 'b@example.com'],
            actions: [
                { type: 'message', payload: 'readable', subject: 'To my family' },
                { type: 'secret', payload: 'zk' },
            ],
        });
        const r = await runSweep(at(72));
        expect(r).toMatchObject({ fired: 1, delivered: 2, failed: 0 });
        const row = await stateOf(id);
        expect(row.state).toBe('fired');
        expect(row.firedAt?.toISOString()).toBe(at(72).toISOString());

        const [to, opts] = h.fireEmail.mock.calls[0] as [
            string,
            { readableMessages: Array<{ subject: string | null; body: string }>; releaseUrl: string },
        ];
        expect(to).toBe('a@example.com');
        expect(opts.readableMessages).toEqual([{ subject: 'To my family', body: 'I love you all.' }]);
        expect(opts.releaseUrl).toMatch(/^https:\/\/core\.example\.com\/release\/[\w-]{20,}$/);
        expect(await db.select().from(releaseTokens)).toHaveLength(2);

        expect((await runSweep(at(73))).fired).toBe(0);
        expect(h.fireEmail).toHaveBeenCalledTimes(2);
    });

    it('retries a failed delivery on a later sweep, with the same release link', async () => {
        await seedSwitch({ actions: [{ type: 'secret', payload: 'zk' }] });
        h.fireEmail.mockRejectedValueOnce(new Error('smtp down'));
        expect(await runSweep(at(72))).toMatchObject({ fired: 1, delivered: 0, failed: 1 });
        expect(await runSweep(at(73))).toMatchObject({ delivered: 1, failed: 0 });
        const urls = h.fireEmail.mock.calls.map((c) => (c[1] as { releaseUrl: string }).releaseUrl);
        expect(urls[0]).toBe(urls[1]);
    });

    it('stops retrying a day after firing', async () => {
        await seedSwitch();
        h.fireEmail.mockRejectedValue(new Error('mailbox gone'));
        await runSweep(at(72));
        await runSweep(at(72 + 23));
        expect(h.fireEmail).toHaveBeenCalledTimes(2);
        expect((await runSweep(at(72 + 25))).scanned).toBe(0);
        expect(h.fireEmail).toHaveBeenCalledTimes(2);
    });

    it('publishes a public page once, links it to recipients, and keeps it through retention', async () => {
        const id = await seedSwitch({ actions: [{ type: 'public_page', payload: 'readable' }] });
        expect((await runSweep(at(72))).published).toBe(1);
        const opts = h.fireEmail.mock.calls[0]?.[1] as { publicUrls: string[] };
        expect(opts.publicUrls).toEqual(['https://core.example.com/p/my-statement']);

        expect((await runSweep(at(73))).published).toBe(0);
        expect(await db.select().from(publicPages)).toHaveLength(1);

        await runSweep(at(72 + 91 * 24)); // long past retention
        expect(await db.select().from(switchPayloads).where(eq(switchPayloads.switchId, id))).toHaveLength(0);
        expect(await db.select().from(publicPages)).toHaveLength(1);
    });
});

describe('the owner always wins a race with the sweep', () => {
    it('does not fire a switch checked in after the sweep read it', async () => {
        const id = await seedSwitch();
        const stale = await stateOf(id); // what the sweep read
        await checkinSwitch(id); // the owner checks in before the write
        expect(await transitionSwitch(stale, ['active', 'grace'], { state: 'fired', firedAt: at(72) })).toBe(false);
        expect((await stateOf(id)).state).toBe('active');
    });

    it('does not fire a switch disarmed after the sweep read it', async () => {
        const id = await seedSwitch();
        const stale = await stateOf(id);
        await disarmSwitch(id);
        expect(await transitionSwitch(stale, ['active', 'grace'], { state: 'fired', firedAt: at(72) })).toBe(false);
        expect((await stateOf(id)).state).toBe('disarmed');
    });

    it('lets only one of two overlapping sweeps fire', async () => {
        const row = await stateOf(await seedSwitch());
        expect(await transitionSwitch(row, ['active', 'grace'], { state: 'fired', firedAt: at(72) })).toBe(true);
        expect(await transitionSwitch(row, ['active', 'grace'], { state: 'fired', firedAt: at(73) })).toBe(false);
    });

    it('matches a deadline stored with microseconds (written by SQL, not the app)', async () => {
        const id = await seedSwitch();
        await db.execute(
            sql`UPDATE quietletter_switches SET next_deadline = '2026-10-08 00:00:00.123456+00' WHERE id = ${id}`,
        );
        expect(await transitionSwitch(await stateOf(id), ['active'], { state: 'grace' })).toBe(true);
    });

    it("never revives a switch the sweep fired between the owner's read and write", async () => {
        const id = await seedSwitch({ state: 'grace' });
        const stale = await stateOf(id); // what the owner's request read
        expect(await transitionSwitch(stale, ['grace'], { state: 'fired', firedAt: at(72) })).toBe(true);
        const read = vi.spyOn(db.query.switches, 'findFirst');
        const writes = [
            () => checkinSwitch(id),
            () => disarmSwitch(id),
            () => upsertSwitch(id, createSwitchSchema.parse({ title: 'Edited' })),
        ];
        for (const write of writes) {
            read.mockResolvedValueOnce(stale);
            expect(await apiCode(write)).toBe('409 already_fired');
        }
        read.mockRestore();
        const row = await stateOf(id);
        expect(row.state).toBe('fired');
        expect(row.title).toBe('For my family');
    });

    it("answers 404 for a switch deleted between the owner's read and write", async () => {
        const id = await seedSwitch();
        const stale = await stateOf(id);
        await db.delete(switches).where(eq(switches.id, id));
        const read = vi.spyOn(db.query.switches, 'findFirst').mockResolvedValueOnce(stale);
        expect(await apiCode(() => checkinSwitch(id))).toBe('404 switch_not_found');
        read.mockRestore();
    });
});

describe('a fired switch is terminal', () => {
    it('refuses a check-in, a disarm and an edit with 409 already_fired, like the hosted service', async () => {
        const id = await seedSwitch({ state: 'fired', firedAt: at(72) });
        expect(await apiCode(() => checkinSwitch(id))).toBe('409 already_fired');
        expect(await apiCode(() => disarmSwitch(id))).toBe('409 already_fired');
        expect(await apiCode(() => upsertSwitch(id, createSwitchSchema.parse({ title: 'Edited' })))).toBe(
            '409 already_fired',
        );
        const row = await stateOf(id);
        expect(row.state).toBe('fired');
        expect(row.title).toBe('For my family');
    });
});

describe('editing a switch', () => {
    const edit = (cadenceDays: number, grace: GraceConfig = GRACE_3D) =>
        createSwitchSchema.parse({
            title: 'For my family',
            cadence: { value: cadenceDays, unit: 'day' },
            grace,
            warnings: [
                { offsetHours: 0, channels: ['push', 'email'] },
                { offsetHours: 24, channels: ['email'] },
            ],
            recipients: [{ email: 'heir@example.com' }],
            actions: [],
        });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('never fires without warnings when a shorter cadence lands in the past', async () => {
        const id = await seedSwitch();
        const now = new Date(T0.getTime() + 5 * 24 * HOUR); // 2 days before the 7-day deadline
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now);
        // A 2-day cadence from the last check-in would have passed 3 days ago.
        const { row } = await upsertSwitch(id, edit(2));
        expect(row.nextDeadline.toISOString()).toBe(now.toISOString());
        expect(row.state).toBe('active');
        vi.useRealTimers();

        const first = await runSweep(now);
        expect(first).toMatchObject({ fired: 0, warned: 1 });
        expect((await stateOf(id)).state).toBe('grace');
        expect(h.warningEmail).toHaveBeenCalledOnce();

        expect((await runSweep(new Date(now.getTime() + 71 * HOUR))).fired).toBe(0);
        expect(h.warningEmail).toHaveBeenCalledTimes(2); // the 24h step went out too
        expect((await runSweep(new Date(now.getTime() + 72 * HOUR))).fired).toBe(1);
    });

    it('keeps a running grace window where it is', async () => {
        const id = await seedSwitch({ state: 'grace' });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(at(10));
        for (const days of [7, 2]) {
            const { row } = await upsertSwitch(id, edit(days));
            expect(row.nextDeadline.toISOString()).toBe(DEADLINE.toISOString());
            expect(row.state).toBe('grace');
        }
    });

    it('ends the grace window when a longer cadence moves the deadline into the future', async () => {
        const id = await seedSwitch({ state: 'grace' });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(at(10));
        const { row } = await upsertSwitch(id, edit(30));
        expect(row.nextDeadline.toISOString()).toBe('2026-10-31T00:00:00.000Z'); // last check-in + 30 days
        expect(row.state).toBe('active');
    });

    it('never brings the fire time closer when a shorter grace is saved during the grace window', async () => {
        const id = await seedSwitch({ state: 'grace', grace: { value: 7, unit: 'day' } }); // fires at +168h
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(at(60));
        // A 2-day grace from the passed deadline would have fired 12 hours ago.
        const { row } = await upsertSwitch(id, edit(7, { value: 2, unit: 'day' }));
        expect(row.nextDeadline.toISOString()).toBe(at(120).toISOString()); // 168h − 48h
        expect(row.state).toBe('active');
        vi.useRealTimers();

        expect((await runSweep(at(60))).fired).toBe(0);
        expect(await runSweep(at(120))).toMatchObject({ fired: 0, warned: 1 });
        expect((await runSweep(at(167))).fired).toBe(0);
        expect(h.warningEmail).toHaveBeenCalledTimes(2); // both steps of the new window went out
        expect((await runSweep(at(168))).fired).toBe(1);
    });
});

describe('retention', () => {
    it('purges expired release links and the payloads of switches fired past the window', async () => {
        const old = await seedSwitch({
            state: 'fired',
            firedAt: at(-91 * 24),
            actions: [{ type: 'secret', payload: 'zk' }],
        });
        const recent = await seedSwitch({
            state: 'fired',
            firedAt: at(-24),
            actions: [{ type: 'secret', payload: 'zk' }],
        });
        const [recipient] = await db.select().from(switchRecipients).where(eq(switchRecipients.switchId, recent));
        await db.insert(releaseTokens).values({
            token: 'expired-token-0123456789',
            switchId: recent,
            recipientId: recipient!.id,
            expiresAt: at(-1),
        });

        await runSweep(at(0));

        expect(await db.select().from(switchPayloads).where(eq(switchPayloads.switchId, old))).toHaveLength(0);
        expect(await db.select().from(switchPayloads).where(eq(switchPayloads.switchId, recent))).toHaveLength(1);
        expect(await db.select().from(releaseTokens)).toHaveLength(0);
    });
});

describe('filling in a legacy switch zone + language', () => {
    it('sets what is missing without moving the deadline', async () => {
        const id = await seedSwitch({ timezone: null, locale: null });
        const before = await stateOf(id);
        const filled = await fillSwitchRegional(id, { timezone: 'Europe/Kyiv', locale: 'ru' });
        expect(filled).toMatchObject({ timezone: 'Europe/Kyiv', locale: 'ru' });
        const after = await stateOf(id);
        expect(after.nextDeadline.toISOString()).toBe(before.nextDeadline.toISOString());
        expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    });

    it('keeps what a switch already has, and leaves a fired switch alone', async () => {
        const set = await seedSwitch({ timezone: 'America/New_York', locale: 'en' });
        await fillSwitchRegional(set, { timezone: 'Europe/Kyiv', locale: 'ru' });
        expect(await stateOf(set)).toMatchObject({ timezone: 'America/New_York', locale: 'en' });

        const fired = await seedSwitch({ state: 'fired', firedAt: at(72) });
        await fillSwitchRegional(fired, { timezone: 'Europe/Kyiv', locale: 'ru' });
        expect(await stateOf(fired)).toMatchObject({ timezone: null, locale: null });
    });

    it('refuses an unknown switch', async () => {
        await expect(fillSwitchRegional(uuidv7(), { timezone: 'Europe/Kyiv' })).rejects.toThrow();
    });
});
