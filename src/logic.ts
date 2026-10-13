import { addDays, addHours, addMonths, addWeeks } from 'date-fns';
import { tz } from '@date-fns/tz';
import type { CheckinCadence, GraceConfig, WarningStep } from './db/schema.js';

/**
 * Pure timing math for the dead man's switch, shared by the service (which stamps
 * `nextDeadline` on write) and the sweep (which decides warnings + firing). No I/O.
 *
 * The lifecycle from a check-in at `t`:
 *   deadline   = t + cadence
 *   grace ends = deadline + max(grace, MIN_GRACE)   ← the switch fires here
 *   warnings   fire at deadline + offsetHours, only while deadline ≤ now < graceEnd
 *
 * MIN_GRACE_HOURS is a non-lowerable SAFETY FLOOR: even if a smaller grace ever
 * reaches the DB, firing still waits at least 48h after the deadline. Zod also
 * rejects a smaller grace at write time — this is defence in depth.
 */

export const MIN_GRACE_HOURS = 48;

/**
 * The check-in deadline for a given check-in instant. Calendar-aware via date-fns:
 * "1 month" steps the calendar in the switch's own IANA `zone` (same wall-clock
 * time, month-end clamping, DST-safe); a legacy switch without a zone steps in the
 * process zone, exactly as before switches carried one. Grace and warning offsets
 * stay exact hour durations (the 48h floor is a duration, not a calendar step).
 */
export function computeNextDeadline(from: Date, cadence: CheckinCadence, zone?: string | null): Date {
    const opts = zone ? { in: tz(zone) } : undefined;
    let next: Date;
    switch (cadence.unit) {
        case 'week':
            next = addWeeks(from, cadence.value, opts);
            break;
        case 'month':
            next = addMonths(from, cadence.value, opts);
            break;
        case 'day':
        default:
            next = addDays(from, cadence.value, opts);
    }
    return new Date(next.getTime());
}

/**
 * The deadline after the owner edits a switch. Recomputed from the LAST CHECK-IN + the
 * (possibly new) cadence — an edit is not a check-in, so it never buys more time than a
 * real one would — but never moved into the past: a shortened cadence that lands before
 * `now` starts the grace window now, so every warning still gets its chance before the
 * switch can fire. Once the deadline has passed (the grace window is running), an edit
 * moves neither the deadline nor the fire time earlier: a shorter grace shifts the
 * deadline later, so the switch still fires when it would have, never sooner.
 */
export function editedDeadline(
    previous: { lastCheckinAt: Date; nextDeadline: Date; grace: GraceConfig },
    cadence: CheckinCadence,
    grace: GraceConfig,
    zone: string | null | undefined,
    now: Date,
): Date {
    const next = computeNextDeadline(previous.lastCheckinAt, cadence, zone);
    let floor = now;
    if (previous.nextDeadline < now) {
        // The deadline that keeps the running window's fire time under the new grace.
        const fireFloor = addHours(graceEndsAt(previous.nextDeadline, previous.grace), -effectiveGraceHours(grace));
        floor = fireFloor > previous.nextDeadline ? fireFloor : previous.nextDeadline;
    }
    return next < floor ? new Date(floor.getTime()) : next;
}

/** Configured grace expressed in hours (before applying the floor). */
export function graceHours(grace: GraceConfig): number {
    return grace.unit === 'day' ? grace.value * 24 : grace.value;
}

/** Hours from the deadline to the fire time: max(configured grace, 48h floor). */
export function effectiveGraceHours(grace: GraceConfig): number {
    return Math.max(graceHours(grace), MIN_GRACE_HOURS);
}

/** The instant the switch fires: deadline + max(configured grace, 48h floor). */
export function graceEndsAt(nextDeadline: Date, grace: GraceConfig): Date {
    return addHours(nextDeadline, effectiveGraceHours(grace));
}

/** Deterministic ledger key for one warning step in the current check-in cycle. */
export function warningStepKey(nextDeadline: Date, index: number): string {
    return `${nextDeadline.toISOString()}:${index}`;
}

export interface DueWarning {
    index: number;
    step: WarningStep;
    fireAt: Date;
    stepKey: string;
}

/**
 * Which warning steps are due at `now`: their fire time (deadline + offset) has
 * passed, but the switch has not yet fired (fire time < graceEnd). A warning whose
 * offset lands at/after the grace end is dropped — no point warning after firing.
 */
export function dueWarnings(nextDeadline: Date, warnings: WarningStep[], graceEnd: Date, now: Date): DueWarning[] {
    const out: DueWarning[] = [];
    warnings.forEach((step, index) => {
        const fireAt = addHours(nextDeadline, step.offsetHours);
        if (fireAt <= now && fireAt < graceEnd) {
            out.push({ index, step, fireAt, stepKey: warningStepKey(nextDeadline, index) });
        }
    });
    return out;
}

/** Whether the switch should fire now (grace window fully elapsed). */
export function shouldFire(nextDeadline: Date, grace: GraceConfig, now: Date): boolean {
    return now >= graceEndsAt(nextDeadline, grace);
}
