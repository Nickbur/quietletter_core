import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { db } from './db/client.js';
import {
    defaultCadence,
    defaultGrace,
    defaultWarnings,
    publicPages,
    releaseTokens,
    switchActions,
    switchPayloads,
    switchRecipients,
    switches,
    type PublicPageRow,
    type SwitchActionRow,
    type SwitchPayloadRow,
    type SwitchRecipientRow,
    type SwitchRow,
} from './db/schema.js';
import { ConflictError, NotFoundError } from './shared/errors.js';
import { uuidv7 } from './shared/id.js';
import { isUniqueViolation } from './shared/pgErrors.js';
import { computeNextDeadline } from './logic.js';
import type { CreateSwitchInput, PutPayloadInput, RegionalInput } from './schemas.js';
import {
    buildExportFile,
    candidateIds,
    checkImportSwitches,
    importReport,
    parseExportFile,
    planImport,
    type ExportFile,
    type ImportPlan,
    type ImportReport,
} from './transfer.js';

/**
 * SINGLE-TENANT service: every switch belongs to the one bootstrapped owner, so
 * there is no per-(user,project) scoping — only the switch id. Switch STATE +
 * `nextDeadline` are server-authoritative: only `checkin` and the sweep move a
 * switch toward firing; editing config never resets the timer.
 */

export interface SwitchWithChildren extends SwitchRow {
    recipients: SwitchRecipientRow[];
    actions: SwitchActionRow[];
}

/** Attach recipients + actions to a set of switch rows in two batched queries. */
async function withChildren(rows: SwitchRow[]): Promise<SwitchWithChildren[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [recips, acts] = await Promise.all([
        db.query.switchRecipients.findMany({ where: inArray(switchRecipients.switchId, ids) }),
        db.query.switchActions.findMany({
            where: inArray(switchActions.switchId, ids),
            orderBy: [asc(switchActions.sortOrder)],
        }),
    ]);
    const byRecip = new Map<string, SwitchRecipientRow[]>();
    for (const r of recips) {
        const list = byRecip.get(r.switchId) ?? [];
        list.push(r);
        byRecip.set(r.switchId, list);
    }
    const byAct = new Map<string, SwitchActionRow[]>();
    for (const a of acts) {
        const list = byAct.get(a.switchId) ?? [];
        list.push(a);
        byAct.set(a.switchId, list);
    }
    return rows.map((r) => ({
        ...r,
        recipients: byRecip.get(r.id) ?? [],
        actions: byAct.get(r.id) ?? [],
    }));
}

/** All switches, oldest first, with recipients + actions. */
export async function listSwitches(): Promise<SwitchWithChildren[]> {
    const rows = await db.query.switches.findMany({ orderBy: [asc(switches.createdAt)] });
    return withChildren(rows);
}

/** One switch, with children, or null. */
export async function getSwitch(id: string): Promise<SwitchWithChildren | null> {
    const row = await db.query.switches.findFirst({ where: eq(switches.id, id) });
    if (!row) return null;
    return (await withChildren([row]))[0] ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Upsert a switch by client id (offline-friendly). Full body: replaces the
 * recipient + action sets atomically. On create the timer starts now; on update
 * the timer is recomputed from the LAST CHECK-IN + the (possibly new) cadence —
 * editing config must never be a backdoor that silently extends the deadline.
 */
export async function upsertSwitch(
    id: string,
    input: CreateSwitchInput,
): Promise<{ row: SwitchWithChildren; created: boolean }> {
    const cadence = input.cadence ?? defaultCadence();
    const grace = input.grace ?? defaultGrace();
    const warnings = input.warnings ?? defaultWarnings();

    const existing = await db.query.switches.findFirst({ where: eq(switches.id, id) });
    const created = !existing;
    // A sent zone / language replaces the stored one; an older app build omits them and keeps them.
    const timezone = input.timezone || existing?.timezone || null;
    const locale = input.locale || existing?.locale || null;

    await db.transaction(async (tx) => {
        if (existing) {
            await tx
                .update(switches)
                .set({
                    title: input.title,
                    cadence,
                    grace,
                    warnings,
                    warningPhone: input.warningPhone ?? null,
                    timezone,
                    locale,
                    nextDeadline: computeNextDeadline(existing.lastCheckinAt, cadence, timezone),
                    updatedAt: new Date(),
                })
                .where(eq(switches.id, id));
        } else {
            const now = new Date();
            await tx.insert(switches).values({
                id,
                title: input.title,
                state: 'active',
                cadence,
                grace,
                warnings,
                warningPhone: input.warningPhone ?? null,
                timezone,
                locale,
                lastCheckinAt: now,
                nextDeadline: computeNextDeadline(now, cadence, timezone),
                armedAt: now,
                createdAt: now,
                updatedAt: now,
            });
        }

        await replaceRecipients(tx, id, input.recipients);
        await replaceActions(tx, id, input.actions);
    });

    const row = await getSwitch(id);
    if (!row) throw new Error('switch_upsert_failed');
    return { row, created };
}

async function replaceRecipients(tx: Tx, switchId: string, incoming: CreateSwitchInput['recipients']): Promise<void> {
    const existing = await tx.query.switchRecipients.findMany({
        where: eq(switchRecipients.switchId, switchId),
        columns: { id: true },
    });
    const keep = new Set<string>();
    for (const r of incoming) {
        const rid = r.id ?? uuidv7();
        keep.add(rid);
        const found = existing.find((e) => e.id === rid);
        if (found) {
            await tx
                .update(switchRecipients)
                .set({ email: r.email, phone: r.phone ?? null, name: r.name ?? null })
                .where(eq(switchRecipients.id, rid));
        } else {
            await tx
                .insert(switchRecipients)
                .values({ id: rid, switchId, email: r.email, phone: r.phone ?? null, name: r.name ?? null });
        }
    }
    const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (toDelete.length) await tx.delete(switchRecipients).where(inArray(switchRecipients.id, toDelete));
}

async function replaceActions(tx: Tx, switchId: string, incoming: CreateSwitchInput['actions']): Promise<void> {
    const existing = await tx.query.switchActions.findMany({
        where: eq(switchActions.switchId, switchId),
        columns: { id: true },
    });
    const keep = new Set<string>();
    for (const a of incoming) {
        const aid = a.id ?? uuidv7();
        keep.add(aid);
        const found = existing.find((e) => e.id === aid);
        if (found) {
            await tx
                .update(switchActions)
                .set({ type: a.type, sortOrder: a.sortOrder ?? 0, config: a.config, updatedAt: new Date() })
                .where(eq(switchActions.id, aid));
        } else {
            await tx
                .insert(switchActions)
                .values({ id: aid, switchId, type: a.type, sortOrder: a.sortOrder ?? 0, config: a.config });
        }
    }
    // Deleting an action cascades its payload row (FK onDelete cascade).
    const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (toDelete.length) await tx.delete(switchActions).where(inArray(switchActions.id, toDelete));
}

/**
 * Proof of life. Resets the deadline from now and re-activates the switch. A switch
 * that has already fired cannot be checked in (its payloads may be out); the owner
 * must create a new one.
 */
export async function checkinSwitch(id: string): Promise<SwitchWithChildren> {
    const row = await db.query.switches.findFirst({ where: eq(switches.id, id) });
    if (!row) throw new NotFoundError('switch_not_found');
    if (row.state === 'fired') throw new ConflictError('already_fired', 'a fired switch cannot be checked in');

    const now = new Date();
    await db
        .update(switches)
        .set({
            lastCheckinAt: now,
            nextDeadline: computeNextDeadline(now, row.cadence, row.timezone),
            state: 'active',
            armedAt: row.armedAt ?? now,
            disarmedAt: null,
            updatedAt: now,
        })
        .where(eq(switches.id, id));

    const updated = await getSwitch(id);
    if (!updated) throw new Error('checkin_failed');
    return updated;
}

/** Turn a switch off (won't fire). Reversible via check-in. A fired switch is terminal. */
export async function disarmSwitch(id: string): Promise<SwitchWithChildren> {
    const row = await db.query.switches.findFirst({ where: eq(switches.id, id) });
    if (!row) throw new NotFoundError('switch_not_found');
    if (row.state === 'fired') throw new ConflictError('already_fired', 'a fired switch cannot be disarmed');

    const now = new Date();
    await db.update(switches).set({ state: 'disarmed', disarmedAt: now, updatedAt: now }).where(eq(switches.id, id));

    const updated = await getSwitch(id);
    if (!updated) throw new Error('disarm_failed');
    return updated;
}

/**
 * Fills in the zone and language of a switch saved before switches carried them (the
 * app sends its device's once, after loading the list). Only missing values are
 * written — what a switch already has stays — and nothing else moves: the current
 * cycle keeps its deadline (the zone applies from the next check-in or edit) and a
 * fired switch is left alone. Idempotent.
 */
export async function fillSwitchRegional(id: string, input: RegionalInput): Promise<SwitchWithChildren> {
    const row = await db.query.switches.findFirst({ where: eq(switches.id, id) });
    if (!row) throw new NotFoundError('switch_not_found');
    if (row.state !== 'fired') {
        if (!row.timezone) {
            await db
                .update(switches)
                .set({ timezone: input.timezone })
                .where(and(eq(switches.id, id), isNull(switches.timezone)));
        }
        if (!row.locale && input.locale) {
            await db
                .update(switches)
                .set({ locale: input.locale })
                .where(and(eq(switches.id, id), isNull(switches.locale)));
        }
    }
    const updated = await getSwitch(id);
    if (!updated) throw new Error('regional_fill_failed');
    return updated;
}

/** Idempotent delete — a missing id is a no-op. Cascades children. */
export async function deleteSwitch(id: string): Promise<void> {
    await db.delete(switches).where(eq(switches.id, id));
}

/** Upsert the encrypted (or readable) payload for one action of a switch. */
export async function putPayload(
    switchId: string,
    actionId: string,
    input: PutPayloadInput,
): Promise<SwitchPayloadRow> {
    const owner = await db.query.switches.findFirst({
        where: eq(switches.id, switchId),
        columns: { id: true },
    });
    if (!owner) throw new NotFoundError('switch_not_found');
    const action = await db.query.switchActions.findFirst({
        where: and(eq(switchActions.id, actionId), eq(switchActions.switchId, switchId)),
        columns: { id: true },
    });
    if (!action) throw new NotFoundError('action_not_found');

    const fields = {
        mode: input.mode,
        ciphertext: input.ciphertext ?? null,
        wrappedKey: input.wrappedKey ?? null,
        salt: input.salt ?? null,
        nonce: input.nonce ?? null,
        algo: input.algo ?? null,
        blobRef: input.blobRef ?? null,
        size: input.size ?? null,
        readableContent: input.readableContent ?? null,
    };

    const existing = await db.query.switchPayloads.findFirst({ where: eq(switchPayloads.actionId, actionId) });
    if (existing) {
        const [row] = await db
            .update(switchPayloads)
            .set({ ...fields, updatedAt: new Date() })
            .where(eq(switchPayloads.actionId, actionId))
            .returning();
        return row ?? existing;
    }
    const [row] = await db
        .insert(switchPayloads)
        .values({ switchId, actionId, ...fields })
        .returning();
    if (!row) throw new Error('payload_upsert_failed');
    return row;
}

// --- Export / import (see transfer.ts) ----------------------------------------

/** All live (non-fired) switches as a portable export file, payloads included. */
export async function exportSwitches(now: Date = new Date()): Promise<ExportFile> {
    const rows = await db.query.switches.findMany({
        where: ne(switches.state, 'fired'),
        orderBy: [asc(switches.createdAt)],
    });
    const full = await withChildren(rows);
    const payloads = rows.length
        ? await db.query.switchPayloads.findMany({
              where: inArray(
                  switchPayloads.switchId,
                  rows.map((r) => r.id),
              ),
          })
        : [];
    return buildExportFile(full, payloads, 'self-host', now);
}

/**
 * Validate an uploaded export file and decide, per switch, what an import would do.
 * Read-only. Self-host is unlimited and accepts the `public_page` action, so the only
 * skips are ids already here and invalid switches.
 */
export async function planSwitchImport(body: unknown): Promise<ImportPlan> {
    const file = parseExportFile(body);
    const checks = checkImportSwitches(file.switches, { allowPublicPage: true });

    const switchIds: string[] = [];
    const childIds: string[] = [];
    for (const check of checks) {
        if (!check.ok) continue;
        const ids = candidateIds(check.candidate);
        switchIds.push(ids.switchId);
        childIds.push(...ids.childIds);
    }

    const [existing, takenRecipients, takenActions] = await Promise.all([
        switchIds.length
            ? db.query.switches.findMany({ where: inArray(switches.id, switchIds), columns: { id: true } })
            : [],
        childIds.length
            ? db.query.switchRecipients.findMany({
                  where: inArray(switchRecipients.id, childIds),
                  columns: { id: true },
              })
            : [],
        childIds.length
            ? db.query.switchActions.findMany({ where: inArray(switchActions.id, childIds), columns: { id: true } })
            : [],
    ]);

    // Single-tenant: every existing switch is the owner's, so there is no "foreign" id.
    return planImport(checks, {
        ownSwitchIds: new Set(existing.map((s) => s.id)),
        foreignSwitchIds: new Set(),
        takenChildIds: new Set([...takenRecipients, ...takenActions].map((r) => r.id)),
    });
}

/**
 * Write a planned import in ONE transaction (all of `plan.toCreate` or nothing). Each
 * switch starts a fresh timer from `now` — the import itself is the owner's proof of
 * life, so nothing can fire early — and a switch exported disarmed stays disarmed.
 */
export async function applySwitchImport(plan: ImportPlan, now: Date = new Date()): Promise<ImportReport> {
    if (plan.toCreate.length > 0) {
        try {
            await db.transaction(async (tx) => {
                for (const c of plan.toCreate) {
                    const cadence = c.input.cadence ?? defaultCadence();
                    await tx.insert(switches).values({
                        id: c.id,
                        title: c.input.title,
                        state: c.disarmed ? 'disarmed' : 'active',
                        cadence,
                        grace: c.input.grace ?? defaultGrace(),
                        warnings: c.input.warnings ?? defaultWarnings(),
                        warningPhone: c.input.warningPhone ?? null,
                        timezone: c.input.timezone ?? null,
                        locale: c.input.locale ?? null,
                        lastCheckinAt: now,
                        nextDeadline: computeNextDeadline(now, cadence, c.input.timezone),
                        armedAt: c.disarmed ? null : now,
                        disarmedAt: c.disarmed ? now : null,
                        createdAt: c.createdAt ?? now,
                        updatedAt: now,
                    });
                    if (c.input.recipients.length) {
                        await tx.insert(switchRecipients).values(
                            c.input.recipients.map((r) => ({
                                id: r.id ?? uuidv7(),
                                switchId: c.id,
                                email: r.email,
                                phone: r.phone ?? null,
                                name: r.name ?? null,
                            })),
                        );
                    }
                    if (c.input.actions.length) {
                        await tx.insert(switchActions).values(
                            c.input.actions.map((a) => ({
                                id: a.id ?? uuidv7(),
                                switchId: c.id,
                                type: a.type,
                                sortOrder: a.sortOrder ?? 0,
                                config: a.config,
                            })),
                        );
                    }
                    if (c.payloads.length) {
                        await tx.insert(switchPayloads).values(
                            c.payloads.map(({ actionId, payload, schemaVersion }) => ({
                                switchId: c.id,
                                actionId,
                                mode: payload.mode,
                                ciphertext: payload.ciphertext ?? null,
                                wrappedKey: payload.wrappedKey ?? null,
                                salt: payload.salt ?? null,
                                nonce: payload.nonce ?? null,
                                algo: payload.algo ?? null,
                                blobRef: payload.blobRef ?? null,
                                size: payload.size ?? null,
                                readableContent: payload.readableContent ?? null,
                                schemaVersion,
                            })),
                        );
                    }
                }
            });
        } catch (err) {
            // Another request created one of these ids between the plan and the write.
            if (isUniqueViolation(err)) {
                throw new ConflictError(
                    'import_conflict',
                    'a switch in this file changed concurrently; retry the import',
                );
            }
            throw err;
        }
    }
    return importReport(plan.results);
}

// --- Release tokens (public recipient access after fire) ---------------------

const RELEASE_TOKEN_BYTES = 32;

/** Mint a URL-safe single-recipient release token. */
export async function issueReleaseToken(switchId: string, recipientId: string, expiresAt: Date): Promise<string> {
    const token = randomBytes(RELEASE_TOKEN_BYTES).toString('base64url');
    await db.insert(releaseTokens).values({ token, switchId, recipientId, expiresAt });
    return token;
}

/**
 * Reuse a recipient's existing unexpired release token, or mint one. Keeps the
 * link stable across fire-email retries so a recipient never gets two live links.
 */
export async function getOrCreateReleaseToken(
    switchId: string,
    recipientId: string,
    expiresAt: Date,
    now: Date = new Date(),
): Promise<string> {
    const existing = await db.query.releaseTokens.findFirst({
        where: and(eq(releaseTokens.switchId, switchId), eq(releaseTokens.recipientId, recipientId)),
    });
    if (existing && existing.expiresAt > now) return existing.token;
    return issueReleaseToken(switchId, recipientId, expiresAt);
}

export interface ReleaseBundle {
    switchTitle: string;
    firedAt: Date | null;
    recipientName: string | null;
    actions: Array<{
        id: string;
        type: SwitchActionRow['type'];
        config: SwitchActionRow['config'];
        payload: {
            mode: 'zk' | 'readable';
            ciphertext: string | null;
            wrappedKey: string | null;
            salt: string | null;
            nonce: string | null;
            algo: string | null;
            blobRef: string | null;
            readableContent: string | null;
        } | null;
    }>;
}

/**
 * Resolve a release token to the content-blind bundle a recipient decrypts in the
 * browser. Returns null when the token is unknown/expired or the switch has not
 * fired. The server returns ciphertext verbatim — it never decrypts.
 */
export async function getReleaseBundle(token: string, now: Date = new Date()): Promise<ReleaseBundle | null> {
    const tok = await db.query.releaseTokens.findFirst({ where: eq(releaseTokens.token, token) });
    if (!tok || tok.expiresAt <= now) return null;

    const sw = await db.query.switches.findFirst({ where: eq(switches.id, tok.switchId) });
    if (!sw || sw.state !== 'fired') return null;

    const recipient = await db.query.switchRecipients.findFirst({
        where: eq(switchRecipients.id, tok.recipientId),
        columns: { name: true },
    });

    const [acts, pays] = await Promise.all([
        db.query.switchActions.findMany({
            where: eq(switchActions.switchId, sw.id),
            orderBy: [asc(switchActions.sortOrder)],
        }),
        db.query.switchPayloads.findMany({ where: eq(switchPayloads.switchId, sw.id) }),
    ]);
    const payByAction = new Map(pays.map((p) => [p.actionId, p]));

    return {
        switchTitle: sw.title,
        firedAt: sw.firedAt,
        recipientName: recipient?.name ?? null,
        actions: acts.map((a) => {
            const p = payByAction.get(a.id);
            return {
                id: a.id,
                type: a.type,
                config: a.config,
                payload: p
                    ? {
                          mode: p.mode,
                          ciphertext: p.ciphertext,
                          wrappedKey: p.wrappedKey,
                          salt: p.salt,
                          nonce: p.nonce,
                          algo: p.algo,
                          blobRef: p.blobRef,
                          readableContent: p.readableContent,
                      }
                    : null,
            };
        }),
    };
}

// --- Public pages (self-host-only "leak" surface) ----------------------------

/** Fetch a published public page by slug, or null. */
export async function getPublicPage(slug: string): Promise<PublicPageRow | null> {
    const row = await db.query.publicPages.findFirst({ where: eq(publicPages.slug, slug) });
    return row ?? null;
}

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96);
}

/**
 * Publish (once) the public page for a fired switch's `public_page` action. The
 * desired slug comes from the action config; a collision or empty slug gets a
 * random suffix. Idempotent: a page already published for this action is reused.
 * Returns the live slug, or null if there was no readable content to publish.
 */
export async function publishPublicPage(
    switchId: string,
    action: SwitchActionRow,
    content: string | null,
    title: string,
    now: Date = new Date(),
): Promise<string | null> {
    const already = await db.query.publicPages.findFirst({ where: eq(publicPages.actionId, action.id) });
    if (already) return already.slug;
    if (content == null) return null;

    const base = slugify(action.config.slug ?? action.config.subject ?? title) || 'page';
    let slug = base;
    for (let i = 0; i < 6; i++) {
        const clash = await db.query.publicPages.findFirst({
            where: eq(publicPages.slug, slug),
            columns: { slug: true },
        });
        if (!clash) break;
        slug = `${base}-${randomBytes(3).toString('hex')}`;
    }

    const inserted = await db
        .insert(publicPages)
        .values({ slug, switchId, actionId: action.id, title, content, publishedAt: now })
        .onConflictDoNothing({ target: publicPages.actionId })
        .returning({ slug: publicPages.slug });
    // If a concurrent sweep won the race, re-read the row it published.
    if (inserted[0]) return inserted[0].slug;
    const settled = await db.query.publicPages.findFirst({ where: eq(publicPages.actionId, action.id) });
    return settled?.slug ?? null;
}
