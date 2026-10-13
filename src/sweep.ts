import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, asc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { db, pool } from './db/client.js';
import {
    publicPages,
    releaseTokens,
    switchActions,
    switchDeliveries,
    switchPayloads,
    switchRecipients,
    switches,
    type SwitchRow,
    type SwitchState,
    type WarnChannel,
} from './db/schema.js';
import { env } from './env.js';
import { sendFireEmail, sendWarningEmail, type ReadableMessage } from './shared/email.service.js';
import { getOrCreateReleaseToken, publishPublicPage } from './service.js';
import { dueWarnings, graceEndsAt } from './logic.js';

/**
 * Quietletter sweep — the SERVER-AUTHORITATIVE fire engine. For every switch past its
 * check-in deadline: transition active → grace, escalate the due warnings to the
 * owner, and once the grace window elapses FIRE — publish any public pages, deliver
 * to every recipient, and mark the switch fired. Idempotent: each delivery is
 * claimed in `quietletter_switch_deliveries` (unique per switch+kind+step) before
 * acting; a failed FIRE delivery releases its claim so a later sweep retries. Also
 * purges expired release tokens and the payloads of switches fired past retention.
 *
 * CHANNELS: email is sent via nodemailer (console fallback without SMTP). Push/SMS
 * are console-only — the core ships no OneSignal/Twilio. Owner warning emails go to
 * OWNER_EMAIL when set.
 *
 * Every state change is a compare-and-set against the row the sweep READ (see
 * `transitionSwitch`): a check-in, disarm or edit that lands between the read and the
 * write wins, so a switch the owner just touched is never moved to grace or fired.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long after firing the sweep keeps retrying failed recipient deliveries. */
const FIRE_DELIVERY_RETRY_MS = DAY_MS;

export interface SweepResult {
    scanned: number;
    warned: number;
    fired: number;
    delivered: number;
    published: number;
    skipped: number;
    failed: number;
}

/** Claim one delivery step; returns the claim row id, or null if already claimed. */
async function claim(switchId: string, kind: 'warning' | 'fire', stepKey: string): Promise<string | null> {
    const res = await db
        .insert(switchDeliveries)
        .values({ switchId, kind, stepKey, sentAt: new Date() })
        .onConflictDoNothing({
            target: [switchDeliveries.switchId, switchDeliveries.kind, switchDeliveries.stepKey],
        })
        .returning({ id: switchDeliveries.id });
    return res[0]?.id ?? null;
}

/**
 * Compare-and-set a state change. It applies only while the switch is still in one of
 * `from` with the deadline and grace the sweep read — a check-in moves the deadline, a
 * disarm changes the state, an edit may change either — so the owner's latest action
 * always wins and the next sweep re-evaluates fresh state. The deadline is compared at
 * millisecond precision (what a JS `Date` holds; Postgres keeps microseconds). Returns
 * whether this call made the change (false also when an overlapping sweep got there first).
 * Exported for the sweep tests.
 */
export async function transitionSwitch(
    row: Pick<SwitchRow, 'id' | 'nextDeadline' | 'grace'>,
    from: SwitchState[],
    set: Partial<typeof switches.$inferInsert>,
): Promise<boolean> {
    const changed = await db
        .update(switches)
        .set(set)
        .where(
            and(
                eq(switches.id, row.id),
                inArray(switches.state, from),
                sql`date_trunc('milliseconds', ${switches.nextDeadline}) = ${row.nextDeadline.toISOString()}::timestamptz`,
                sql`${switches.grace} = ${JSON.stringify(row.grace)}::jsonb`,
            ),
        )
        .returning({ id: switches.id });
    return changed.length > 0;
}

/** Release a claim so a later sweep retries it (used only for failed FIRE deliveries). */
async function release(switchId: string, kind: 'warning' | 'fire', stepKey: string): Promise<void> {
    await db
        .delete(switchDeliveries)
        .where(
            and(
                eq(switchDeliveries.switchId, switchId),
                eq(switchDeliveries.kind, kind),
                eq(switchDeliveries.stepKey, stepKey),
            ),
        );
}

export async function runSweep(now: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = {
        scanned: 0,
        warned: 0,
        fired: 0,
        delivered: 0,
        published: 0,
        skipped: 0,
        failed: 0,
    };
    const retryFloor = new Date(now.getTime() - FIRE_DELIVERY_RETRY_MS);

    const rows = await db.query.switches.findMany({
        where: or(
            and(or(eq(switches.state, 'active'), eq(switches.state, 'grace')), lte(switches.nextDeadline, now)),
            and(eq(switches.state, 'fired'), gt(switches.firedAt, retryFloor)),
        ),
    });

    result.scanned = rows.length;

    for (const row of rows) {
        const graceEnd = graceEndsAt(row.nextDeadline, row.grace);

        if (row.state === 'fired') {
            await fire(row, now, result); // retry undelivered recipients / republish
            continue;
        }

        // active → grace transition once the deadline is crossed.
        if (row.state === 'active' && now >= row.nextDeadline) {
            const moved = await transitionSwitch(row, ['active'], {
                state: 'grace',
                armedAt: row.armedAt ?? now,
                updatedAt: new Date(),
            });
            if (!moved) {
                result.skipped++; // checked in / disarmed / edited since the read — next sweep decides
                continue;
            }
            row.state = 'grace';
        }

        if (now >= graceEnd) {
            await fire(row, now, result);
        } else {
            const due = dueWarnings(row.nextDeadline, row.warnings, graceEnd, now);
            for (const w of due) {
                const claimId = await claim(row.id, 'warning', w.stepKey);
                if (!claimId) {
                    result.skipped++;
                    continue;
                }
                await sendWarning(row, w.step.channels, graceEnd);
                result.warned++;
            }
        }
    }

    await retentionPurge(now);
    return result;
}

/** Best-effort multi-channel check-in nudge to the owner. Claim is not released. */
async function sendWarning(row: SwitchRow, channels: WarnChannel[], firesAt: Date): Promise<void> {
    const jobs: Array<Promise<unknown>> = [];

    if (channels.includes('push')) {
        // No OneSignal in the core — log so a self-hoster can wire their own provider.
        // eslint-disable-next-line no-console
        console.log(`[sweep:push] owner nudge — switch "${row.title}" (${row.id}) fires at ${firesAt.toISOString()}`);
    }
    if (channels.includes('email')) {
        if (env.OWNER_EMAIL) {
            jobs.push(
                sendWarningEmail(env.OWNER_EMAIL, {
                    title: row.title,
                    firesAt,
                    timeZone: row.timezone,
                    locale: row.locale,
                    checkinUrl: env.PUBLIC_URL,
                }),
            );
        } else {
            // eslint-disable-next-line no-console
            console.log(`[sweep:email] owner warning for "${row.title}" — set OWNER_EMAIL to deliver it`);
        }
    }
    if (channels.includes('sms')) {
        // eslint-disable-next-line no-console
        console.log(`[sweep:sms] owner nudge to ${row.warningPhone ?? '(no number)'} — check in on "${row.title}"`);
    }

    const settled = await Promise.allSettled(jobs);
    for (const s of settled) {
        if (s.status === 'rejected') {
            // eslint-disable-next-line no-console
            console.error(`[sweep] warning channel failed for switch ${row.id}:`, s.reason);
        }
    }
}

/**
 * Fire the switch: mark it fired (compare-and-set — only if the owner hasn't touched it
 * since the read and no overlapping sweep fired it first), publish public pages, then
 * deliver to recipients idempotently. An already-fired row only republishes/retries.
 */
async function fire(row: SwitchRow, now: Date, result: SweepResult): Promise<void> {
    if (row.state !== 'fired') {
        const won = await transitionSwitch(row, ['active', 'grace'], {
            state: 'fired',
            firedAt: now,
            armedAt: row.armedAt ?? now,
            updatedAt: new Date(),
        });
        if (!won) {
            result.skipped++;
            return;
        }
        result.fired++;
    }

    const [actions, payloads] = await Promise.all([
        db.query.switchActions.findMany({
            where: eq(switchActions.switchId, row.id),
            orderBy: [asc(switchActions.sortOrder)],
        }),
        db.query.switchPayloads.findMany({ where: eq(switchPayloads.switchId, row.id) }),
    ]);
    const payByAction = new Map(payloads.map((p) => [p.actionId, p]));

    // Publish the self-host-only public pages (regardless of recipients — a leak is
    // public). Idempotent: one published page per action.
    const publicUrls: string[] = [];
    for (const a of actions) {
        if (a.type !== 'public_page') continue;
        const payload = payByAction.get(a.id);
        const content = payload?.readableContent ?? null;
        const title = a.config.subject?.trim() || row.title;
        const existed = await db.query.publicPages.findFirst({
            where: eq(publicPages.actionId, a.id),
            columns: { slug: true },
        });
        const slug = await publishPublicPage(row.id, a, content, title, now);
        if (slug) {
            publicUrls.push(`${env.PUBLIC_URL}/p/${slug}`);
            if (!existed) result.published++;
        }
    }

    const recipients = await db.query.switchRecipients.findMany({ where: eq(switchRecipients.switchId, row.id) });
    if (recipients.length === 0) return;

    // Readable messages in the owner's order, each with its Subject.
    const readableMessages: ReadableMessage[] = [];
    for (const a of actions) {
        const p = payByAction.get(a.id);
        if (a.type !== 'message' || !p || p.mode !== 'readable' || !p.readableContent) continue;
        readableMessages.push({ subject: a.config.subject ?? null, body: p.readableContent });
    }
    const hasZk = payloads.some((p) => p.mode === 'zk');
    const expiresAt = new Date(now.getTime() + env.FIRE_RETENTION_DAYS * DAY_MS);

    for (const r of recipients) {
        const claimId = await claim(row.id, 'fire', r.id);
        if (!claimId) {
            result.skipped++;
            continue; // already delivered to this recipient
        }

        let releaseUrl: string | null = null;
        if (hasZk) {
            const token = await getOrCreateReleaseToken(row.id, r.id, expiresAt, now);
            releaseUrl = `${env.PUBLIC_URL}/release/${token}`;
        }

        let ok = false;
        try {
            await sendFireEmail(r.email, {
                switchTitle: row.title,
                recipientName: r.name,
                readableMessages,
                releaseUrl,
                publicUrls,
                locale: row.locale,
            });
            ok = true;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[sweep] fire email failed for switch ${row.id} recipient ${r.id}:`, err);
        }

        if (ok) {
            result.delivered++;
        } else {
            await release(row.id, 'fire', r.id); // retry this recipient on a later sweep
            result.failed++;
        }
    }
}

/** Expire tokens and purge the payloads of switches fired past the retention window. */
async function retentionPurge(now: Date): Promise<void> {
    await db.delete(releaseTokens).where(lte(releaseTokens.expiresAt, now));

    const cutoff = new Date(now.getTime() - env.FIRE_RETENTION_DAYS * DAY_MS);
    const old = await db
        .select({ id: switches.id })
        .from(switches)
        .where(and(eq(switches.state, 'fired'), lte(switches.firedAt, cutoff)));
    if (old.length) {
        // Public pages are intentionally NOT purged — a published leak is meant to stay.
        await db.delete(switchPayloads).where(
            inArray(
                switchPayloads.switchId,
                old.map((s) => s.id),
            ),
        );
    }
}

/** CLI entry: `npm run sweep` (dev) or `node dist/sweep.js` (prod cron). */
async function main(): Promise<void> {
    const r = await runSweep();
    // eslint-disable-next-line no-console
    console.log(
        `[sweep] scanned ${r.scanned}: warned ${r.warned}, fired ${r.fired}, published ${r.published}, ` +
            `delivered ${r.delivered}, skipped ${r.skipped}, failed ${r.failed}`,
    );
    await pool.end();
}

const invokedDirectly = (() => {
    const entry = process.argv[1];
    if (!entry) return false;
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
})();

if (invokedDirectly) {
    main().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[sweep] failed:', err);
        process.exit(1);
    });
}
