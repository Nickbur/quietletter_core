import { describe, expect, it } from 'vitest';
import { MIN_GRACE_HOURS, editedDeadline, effectiveGraceHours, graceEndsAt } from './logic.js';
import { createSwitchSchema } from './schemas.js';

/**
 * The schedule rules that keep a switch from firing without its warnings: an edit
 * never moves the deadline into the past (nor buys more time than a check-in), never
 * brings a running grace window's fire time closer, and every warning step must fall
 * before the fire time.
 */

const HOUR = 3_600_000;
const T0 = new Date('2026-09-15T12:00:00.000Z'); // last check-in

describe('editedDeadline', () => {
    const deadline30d = new Date('2026-10-15T12:00:00.000Z'); // T0 + 30 days
    const grace3d = { value: 3, unit: 'day' as const };
    const grace7d = { value: 7, unit: 'day' as const };

    it('recomputes from the last check-in when that is still in the future', () => {
        const now = new Date(T0.getTime() + 2 * 24 * HOUR);
        const previous = { lastCheckinAt: T0, nextDeadline: deadline30d, grace: grace3d };
        const next = editedDeadline(previous, { value: 7, unit: 'day' }, grace3d, null, now);
        expect(next.toISOString()).toBe('2026-09-22T12:00:00.000Z');
    });

    it('never moves a future deadline into the past — the grace window starts now instead', () => {
        const now = new Date(T0.getTime() + 10 * 24 * HOUR);
        const previous = { lastCheckinAt: T0, nextDeadline: deadline30d, grace: grace3d };
        const next = editedDeadline(previous, { value: 7, unit: 'day' }, grace3d, null, now);
        expect(next.toISOString()).toBe(now.toISOString());
    });

    it('never extends beyond a real check-in, and never restarts a passed deadline', () => {
        const passed = new Date('2026-09-22T12:00:00.000Z'); // T0 + 7 days, already behind us
        const now = new Date(T0.getTime() + 8 * 24 * HOUR);
        const previous = { lastCheckinAt: T0, nextDeadline: passed, grace: grace3d };
        expect(editedDeadline(previous, { value: 7, unit: 'day' }, grace3d, null, now).toISOString()).toBe(
            passed.toISOString(),
        );
        expect(editedDeadline(previous, { value: 2, unit: 'day' }, grace3d, null, now).toISOString()).toBe(
            passed.toISOString(),
        );
        expect(editedDeadline(previous, { value: 30, unit: 'day' }, grace3d, null, now).toISOString()).toBe(
            deadline30d.toISOString(),
        );
    });

    it('never brings the fire time closer once the grace window is running', () => {
        const passed = new Date('2026-09-22T12:00:00.000Z'); // T0 + 7 days
        const now = new Date(passed.getTime() + 60 * HOUR); // 60h into a 7-day grace
        const previous = { lastCheckinAt: T0, nextDeadline: passed, grace: grace7d };
        // A 3-day grace from the passed deadline would have fired 12 hours ago.
        const next = editedDeadline(previous, { value: 7, unit: 'day' }, grace3d, null, now);
        expect(graceEndsAt(next, grace3d).toISOString()).toBe(graceEndsAt(passed, grace7d).toISOString());
        expect(next.toISOString()).toBe('2026-09-26T12:00:00.000Z'); // the deadline moves 4 days later
        // A longer grace keeps the running deadline (the switch fires later, never sooner).
        expect(editedDeadline(previous, { value: 7, unit: 'day' }, { value: 14, unit: 'day' }, null, now)).toEqual(
            passed,
        );
    });

    it('lets a shorter grace bring the fire time closer while the deadline is still ahead', () => {
        const now = new Date(T0.getTime() + 2 * 24 * HOUR);
        const deadline7d = new Date('2026-09-22T12:00:00.000Z');
        const previous = { lastCheckinAt: T0, nextDeadline: deadline7d, grace: grace7d };
        // Every warning still goes out: they all run from a deadline that is in the future.
        expect(editedDeadline(previous, { value: 7, unit: 'day' }, grace3d, null, now)).toEqual(deadline7d);
    });
});

describe('warning offsets', () => {
    it('floors the effective grace at 48h', () => {
        expect(effectiveGraceHours({ value: 1, unit: 'hour' })).toBe(MIN_GRACE_HOURS);
        expect(effectiveGraceHours({ value: 3, unit: 'day' })).toBe(72);
    });

    it('requires every warning to fall before the fire time', () => {
        const at = (offsetHours: number) =>
            createSwitchSchema.safeParse({
                title: 'x',
                grace: { value: 3, unit: 'day' },
                warnings: [
                    { offsetHours: 0, channels: ['push', 'email'] },
                    { offsetHours, channels: ['email'] },
                ],
            });
        expect(at(71).success).toBe(true);
        const atFire = at(72);
        expect(atFire.success).toBe(false);
        expect(atFire.error?.issues[0]?.path).toEqual(['warnings', 1, 'offsetHours']);
        // An omitted grace is the default 14 days.
        const withDefault = (offsetHours: number) =>
            createSwitchSchema.safeParse({ title: 'x', warnings: [{ offsetHours, channels: ['push', 'email'] }] })
                .success;
        expect(withDefault(335)).toBe(true);
        expect(withDefault(336)).toBe(false);
    });
});
