import { describe, expect, it } from 'vitest';
import { computeNextDeadline } from '../logic.js';
import { createSwitchSchema } from '../schemas.js';
import { formatZonedTime, isValidTimeZone } from './timezone.js';

/**
 * A switch's own IANA zone: validated on the way in, the cadence steps on its
 * calendar (a legacy switch without one keeps the process zone), and the warning
 * email prints the fire time on its clock.
 */

const KYIV = 'Europe/Kyiv';

describe('switch zone', () => {
    it('accepts IANA names only, and treats an absent / null zone as "keep"', () => {
        expect(isValidTimeZone(KYIV)).toBe(true);
        expect(isValidTimeZone('+03:00')).toBe(false);
        const withZone = createSwitchSchema.safeParse({ title: 'x', timezone: KYIV });
        expect(withZone.success && withZone.data.timezone).toBe(KYIV);
        const omitted = createSwitchSchema.safeParse({ title: 'x' });
        expect(omitted.success && omitted.data.timezone).toBeUndefined();
        expect(createSwitchSchema.safeParse({ title: 'x', timezone: null }).success).toBe(true);
        expect(createSwitchSchema.safeParse({ title: 'x', timezone: 'Mars/Olympus' }).success).toBe(false);
    });

    it('steps the cadence on the switch calendar across a DST change', () => {
        // 10:00 Kyiv summer time (07:00Z) + 1 week = 10:00 winter time (08:00Z).
        const checkin = new Date('2026-10-20T07:00:00.000Z');
        expect(computeNextDeadline(checkin, { value: 1, unit: 'week' }, KYIV).toISOString()).toBe(
            '2026-10-27T08:00:00.000Z',
        );
        // Legacy switch: the process zone (UTC in tests), as before.
        expect(computeNextDeadline(checkin, { value: 1, unit: 'week' }).toISOString()).toBe('2026-10-27T07:00:00.000Z');
    });

    it('prints the fire time on the switch clock, or UTC for a legacy switch', () => {
        const at = new Date('2026-08-05T06:00:00.000Z');
        expect(formatZonedTime(at, KYIV)).toMatch(/^Wednesday, August 5, 2026 at 9:00\sAM \(Europe\/Kyiv\)$/);
        expect(formatZonedTime(at, null)).toMatch(/at 6:00\sAM \(UTC\)$/);
        expect(formatZonedTime(at, 'Mars/Olympus')).toMatch(/at 6:00\sAM \(UTC\)$/);
    });
});
