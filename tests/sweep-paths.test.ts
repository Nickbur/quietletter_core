import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('../src/db/client.js', () => import('./helpers/db.js').then((m) => m.pgliteClient()));

const h = vi.hoisted(() => ({
    env: {
        PUBLIC_URL: 'https://core.example.com',
        FIRE_RETENTION_DAYS: 90,
        OWNER_EMAIL: undefined as string | undefined,
    },
    warningEmail: vi.fn(async (..._args: unknown[]) => {}),
    fireEmail: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('../src/env.js', () => ({ env: h.env }));
vi.mock('../src/shared/email.service.js', () => ({ sendWarningEmail: h.warningEmail, sendFireEmail: h.fireEmail }));

import { db } from '../src/db/client.js';
import { publicPages, switches } from '../src/db/schema.js';
import { checkinSwitch } from '../src/service.js';
import { runSweep } from '../src/sweep.js';
import { resetDb } from './helpers/db.js';
import { at, seedSwitch, switchRow } from './helpers/switches.js';

/**
 * The sweep's owner-warning channels and its race handling, beyond tests/sweep.test.ts: without
 * OWNER_EMAIL the warning is still logged (never silently dropped), push and SMS are console-only
 * in the core, a failing channel never stops the sweep, and a switch the owner touched after the
 * sweep read it is skipped — never moved to grace, never fired.
 */

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;

beforeEach(async () => {
    await resetDb(db);
    h.env.OWNER_EMAIL = undefined;
    h.warningEmail.mockReset().mockResolvedValue(undefined);
    h.fireEmail.mockReset().mockResolvedValue(undefined);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

const logged = (spy: MockInstance<typeof console.log>): string[] => spy.mock.calls.map((c) => String(c[0]));

describe('owner warning channels', () => {
    it('logs the email warning when OWNER_EMAIL is unset, and logs push', async () => {
        await seedSwitch({ title: 'Kids', warnings: [{ offsetHours: 0, channels: ['push', 'email'] }] });
        expect((await runSweep(at(1))).warned).toBe(1);
        expect(h.warningEmail).not.toHaveBeenCalled();
        expect(logged(log)).toContain('[sweep:email] owner warning for "Kids" — set OWNER_EMAIL to deliver it');
        expect(logged(log).some((l) => l.startsWith('[sweep:push] owner nudge — switch "Kids"'))).toBe(true);
    });

    it('logs an SMS nudge with the warning phone, or says there is none', async () => {
        await seedSwitch({
            title: 'With phone',
            warningPhone: '+380441234567',
            warnings: [{ offsetHours: 0, channels: ['sms'] }],
        });
        await seedSwitch({ title: 'No phone', warnings: [{ offsetHours: 0, channels: ['sms'] }] });
        expect((await runSweep(at(1))).warned).toBe(2);
        expect(logged(log)).toEqual(
            expect.arrayContaining([
                '[sweep:sms] owner nudge to +380441234567 — check in on "With phone"',
                '[sweep:sms] owner nudge to (no number) — check in on "No phone"',
            ]),
        );
        expect(h.warningEmail).not.toHaveBeenCalled();
    });

    it('logs a failing warning email and carries on — the warning step stays claimed', async () => {
        h.env.OWNER_EMAIL = 'owner@example.com';
        h.warningEmail.mockRejectedValue(new Error('smtp down'));
        const { id } = await seedSwitch({ warnings: [{ offsetHours: 0, channels: ['email'] }] });
        expect((await runSweep(at(1))).warned).toBe(1);
        expect(h.warningEmail).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledWith(
            `[sweep] warning channel failed for switch ${id}:`,
            expect.objectContaining({ message: 'smtp down' }),
        );
        expect((await runSweep(at(2))).warned).toBe(0);
        expect((await switchRow(id)).state).toBe('grace');
    });
});

describe('firing details', () => {
    it('stamps armedAt on a switch that reaches grace and fires without one', async () => {
        const { id } = await seedSwitch();
        await db.update(switches).set({ armedAt: null }).where(eq(switches.id, id));
        await runSweep(at(1));
        expect((await switchRow(id)).armedAt).toEqual(at(1));

        const second = await seedSwitch({ state: 'grace' });
        await db.update(switches).set({ armedAt: null }).where(eq(switches.id, second.id));
        await runSweep(at(72));
        expect(await switchRow(second.id)).toMatchObject({ state: 'fired', armedAt: at(72), firedAt: at(72) });
    });

    it('publishes a public page under its subject, even for a switch with no recipients', async () => {
        await seedSwitch({
            recipients: [],
            actions: [{ type: 'public_page', payload: 'readable', subject: '  Open letter  ' }],
        });
        expect(await runSweep(at(72))).toMatchObject({ fired: 1, published: 1, delivered: 0 });
        expect(await db.select().from(publicPages)).toEqual([
            expect.objectContaining({ slug: 'open-letter', title: 'Open letter', content: 'I love you all.' }),
        ]);
        expect(h.fireEmail).not.toHaveBeenCalled();
    });

    it('publishes nothing for a public page whose content was never uploaded', async () => {
        await seedSwitch({ actions: [{ type: 'public_page', payload: 'none' }] });
        expect(await runSweep(at(72))).toMatchObject({ fired: 1, published: 0, delivered: 1 });
        expect(h.fireEmail.mock.calls[0]?.[1]).toMatchObject({ publicUrls: [], releaseUrl: null });
    });
});

describe('a switch the owner touched after the sweep read it', () => {
    /** The compare-and-set loses: the sweep counts a skip and the next sweep decides from fresh state. */
    it('is not moved to grace', async () => {
        const { id } = await seedSwitch();
        const stale = await switchRow(id);
        await checkinSwitch(id);
        vi.spyOn(db.query.switches, 'findMany').mockResolvedValueOnce([stale]);
        expect(await runSweep(at(1))).toMatchObject({ scanned: 1, skipped: 1, warned: 0 });
        expect((await switchRow(id)).state).toBe('active');
    });

    it('is not fired', async () => {
        const { id } = await seedSwitch({ state: 'grace' });
        const stale = await switchRow(id);
        await checkinSwitch(id);
        vi.spyOn(db.query.switches, 'findMany').mockResolvedValueOnce([stale]);
        expect(await runSweep(at(72))).toMatchObject({ scanned: 1, skipped: 1, fired: 0, delivered: 0 });
        expect((await switchRow(id)).state).toBe('active');
        expect(h.fireEmail).not.toHaveBeenCalled();
    });
});
