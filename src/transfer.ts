import { z } from 'zod';
import type {
    ActionConfig,
    ActionType,
    CheckinCadence,
    GraceConfig,
    SwitchActionRow,
    SwitchPayloadRow,
    SwitchRecipientRow,
    SwitchRow,
    WarningStep,
} from './db/schema.js';
import { ValidationError } from './shared/errors.js';
import { createSwitchSchema, putPayloadSchema, type CreateSwitchInput, type PutPayloadInput } from './schemas.js';

/**
 * Switch export / import — one portable, versioned JSON file that moves an owner's
 * switches between this self-hosted core and the hosted Quietletter service, in either
 * direction. Both backends produce and accept the SAME format (the hosted service keeps
 * a verbatim twin of this file), so a file from one imports into the other.
 *
 * ZERO-KNOWLEDGE is preserved by construction: payloads travel exactly as stored, so a
 * ZK payload stays ciphertext + passphrase-wrapped key + salt + nonce + algo and is
 * unreadable without the owner's passphrase. The file itself is NOT encrypted: titles,
 * recipient addresses and any `readable` message are plaintext in it.
 *
 * Only live switches travel (active / grace / disarmed). A fired switch is terminal and
 * its payloads get purged, and release tokens, the delivery ledger and published public
 * pages are server history, not setup — none of them are exported.
 *
 * Import never makes anything fire early: an imported switch starts a fresh timer from
 * the moment of import (an authenticated owner action is proof of life) and a disarmed
 * switch stays disarmed. Ids are stable, so importing the same file twice skips what is
 * already there instead of duplicating it — recipients would otherwise get every
 * message twice.
 *
 * Everything here is pure (no I/O); the service does the lookups and the writes.
 */

export const EXPORT_FORMAT = 'quietletter-export';
export const EXPORT_SCHEMA_VERSION = 1;
export const MAX_IMPORT_SWITCHES = 200;
/** A file can carry many inline ciphertext payloads, so the import route gets its own cap. */
export const IMPORT_BODY_LIMIT = 50 * 1024 * 1024;

export type ExportSource = 'cloud' | 'self-host';

/** One action's stored payload, verbatim. ZK fields stay ciphertext. */
export interface ExportPayload {
    mode: 'zk' | 'readable';
    ciphertext: string | null;
    wrappedKey: string | null;
    salt: string | null;
    nonce: string | null;
    algo: string | null;
    blobRef: string | null;
    size: number | null;
    readableContent: string | null;
    schemaVersion: number;
}

export interface ExportAction {
    id: string;
    type: ActionType;
    sortOrder: number;
    config: ActionConfig;
    /** Null when the action was configured but its content was never uploaded. */
    payload: ExportPayload | null;
}

export interface ExportRecipient {
    id: string;
    email: string;
    phone: string | null;
    name: string | null;
}

export interface ExportSwitch {
    id: string;
    title: string;
    /** Informational, except `disarmed`, which an import keeps. */
    state: string;
    cadence: CheckinCadence;
    grace: GraceConfig;
    warnings: WarningStep[];
    warningPhone: string | null;
    /** IANA zone the cadence steps in; null / absent (older files) = the server's legacy behaviour. */
    timezone?: string | null;
    /** UI language the emails are written in; null / absent (older or cloud files) = English. */
    locale?: string | null;
    /** Informational — an import restarts the timer from the moment of import. */
    lastCheckinAt: string | null;
    createdAt: string;
    recipients: ExportRecipient[];
    actions: ExportAction[];
}

export interface ExportFile {
    format: typeof EXPORT_FORMAT;
    schemaVersion: typeof EXPORT_SCHEMA_VERSION;
    exportedAt: string;
    source: ExportSource;
    switches: ExportSwitch[];
}

type SwitchWithChildren = SwitchRow & { recipients: SwitchRecipientRow[]; actions: SwitchActionRow[] };

/** `quietletter-export-YYYY-MM-DD.json` (UTC date). */
export function exportFileName(at: Date): string {
    return `quietletter-export-${at.toISOString().slice(0, 10)}.json`;
}

/** Build the export file from switch rows (with children) and their payload rows. Fired switches are left out. */
export function buildExportFile(
    rows: SwitchWithChildren[],
    payloads: SwitchPayloadRow[],
    source: ExportSource,
    now: Date,
): ExportFile {
    const payByAction = new Map(payloads.map((p) => [p.actionId, p]));
    return {
        format: EXPORT_FORMAT,
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAt: now.toISOString(),
        source,
        switches: rows
            .filter((s) => s.state !== 'fired')
            .map((s) => ({
                id: s.id,
                title: s.title,
                state: s.state,
                cadence: s.cadence,
                grace: s.grace,
                warnings: s.warnings,
                warningPhone: s.warningPhone ?? null,
                timezone: s.timezone ?? null,
                locale: s.locale ?? null,
                lastCheckinAt: s.lastCheckinAt.toISOString(),
                createdAt: s.createdAt.toISOString(),
                recipients: s.recipients.map((r) => ({
                    id: r.id,
                    email: r.email,
                    phone: r.phone ?? null,
                    name: r.name ?? null,
                })),
                actions: s.actions.map((a) => {
                    const p = payByAction.get(a.id);
                    return {
                        id: a.id,
                        type: a.type,
                        sortOrder: a.sortOrder,
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
                                  size: p.size,
                                  readableContent: p.readableContent,
                                  schemaVersion: p.schemaVersion,
                              }
                            : null,
                    };
                }),
            })),
    };
}

// --- Import: file validation -------------------------------------------------

/** Checked first, so a file from a newer version fails with a clear code instead of a shape error. */
const envelopeSchema = z.object({
    format: z.literal(EXPORT_FORMAT),
    schemaVersion: z.number().int().positive(),
});

const fileSchema = z.object({
    format: z.literal(EXPORT_FORMAT),
    schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
    exportedAt: z.string().max(64).optional(),
    source: z.string().max(32).optional(),
    switches: z.array(z.unknown()).max(MAX_IMPORT_SWITCHES),
});

/**
 * Parse the file envelope. 400 `invalid_export_file` for anything that isn't a
 * Quietletter export, 400 `unsupported_export_version` for a newer schema version
 * (update the server). Unknown extra fields are ignored. Per-switch content is
 * validated separately, so one bad switch never sinks the rest.
 */
export function parseExportFile(body: unknown): { switches: unknown[] } {
    const envelope = envelopeSchema.safeParse(body);
    if (!envelope.success) throw new ValidationError('invalid_export_file', 'not a Quietletter export file');
    if (envelope.data.schemaVersion > EXPORT_SCHEMA_VERSION) {
        throw new ValidationError(
            'unsupported_export_version',
            `export schemaVersion ${envelope.data.schemaVersion} is newer than this server supports (${EXPORT_SCHEMA_VERSION})`,
        );
    }
    const file = fileSchema.safeParse(body);
    if (!file.success) {
        const first = file.error.issues[0];
        throw new ValidationError(
            'invalid_export_file',
            first ? `${first.path.join('.') || 'file'}: ${first.message}` : 'invalid export file',
        );
    }
    return { switches: file.data.switches };
}

/** The identity part of one exported switch; config is re-validated by the regular write schemas. */
const fileSwitchSchema = z.object({
    id: z.string().uuid(),
    state: z.string().max(16).optional(),
    createdAt: z.string().max(64).optional(),
    recipients: z.array(z.object({ id: z.string().uuid() })).max(50),
    actions: z
        .array(
            z.object({
                id: z.string().uuid(),
                type: z.string().max(24),
                payload: z.unknown().optional(),
            }),
        )
        .max(20),
});

const payloadVersion = z.number().int().positive().max(1000).optional().default(1);

export type ImportSkipReason = 'exists' | 'conflict' | 'self_host_only' | 'invalid';

/** Per-switch outcome, reported back to the owner in file order. */
export interface ImportResult {
    id: string | null;
    title: string | null;
    status: 'imported' | 'skipped';
    reason?: ImportSkipReason;
    detail?: string;
}

/** A switch that passed validation and is ready to be written (every recipient/action carries its file id). */
export interface ImportCandidate {
    id: string;
    title: string;
    disarmed: boolean;
    createdAt: Date | null;
    input: CreateSwitchInput;
    payloads: Array<{ actionId: string; payload: PutPayloadInput; schemaVersion: number }>;
}

export type ImportCheck = { ok: true; candidate: ImportCandidate } | { ok: false; result: ImportResult };

function displayTitle(raw: unknown): string | null {
    const t = (raw as { title?: unknown } | null)?.title;
    return typeof t === 'string' ? t.trim().slice(0, 300) : null;
}

function rawId(raw: unknown): string | null {
    const id = (raw as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id.slice(0, 64) : null;
}

function issueDetail(error: z.ZodError): string {
    const first = error.issues[0];
    return first ? `${first.path.join('.') || 'switch'}: ${first.message}` : 'invalid switch';
}

function invalid(raw: unknown, detail: string): ImportCheck {
    return {
        ok: false,
        result: { id: rawId(raw), title: displayTitle(raw), status: 'skipped', reason: 'invalid', detail },
    };
}

/**
 * Validate every switch of a parsed file against the SAME write rules a regular
 * save goes through (safety floors, ZK rules, this backend's action set) plus the
 * payload rules. `allowPublicPage` is false on the cloud: a switch carrying the
 * self-host-only public page is skipped whole — dropping just that action would
 * silently change what the switch delivers.
 */
export function checkImportSwitches(rawSwitches: unknown[], opts: { allowPublicPage: boolean }): ImportCheck[] {
    const seen = new Set<string>();
    return rawSwitches.map((raw): ImportCheck => {
        const shape = fileSwitchSchema.safeParse(raw);
        if (!shape.success) return invalid(raw, issueDetail(shape.error));
        const sw = shape.data;

        if (!opts.allowPublicPage && sw.actions.some((a) => a.type === 'public_page')) {
            return {
                ok: false,
                result: { id: sw.id, title: displayTitle(raw), status: 'skipped', reason: 'self_host_only' },
            };
        }

        const ids = [sw.id, ...sw.recipients.map((r) => r.id), ...sw.actions.map((a) => a.id)];
        if (new Set(ids).size !== ids.length || ids.some((id) => seen.has(id))) {
            return invalid(raw, 'duplicate id in file');
        }

        const config = createSwitchSchema.safeParse(raw);
        if (!config.success) return invalid(raw, issueDetail(config.error));

        const payloads: ImportCandidate['payloads'] = [];
        for (const a of sw.actions) {
            if (a.payload == null) continue;
            const p = putPayloadSchema.safeParse(a.payload);
            if (!p.success) return invalid(raw, `actions.${a.id}.payload: ${issueDetail(p.error)}`);
            // Nothing writes `blobRef` today; an externalized blob would dangle on another server.
            if (p.data.blobRef) return invalid(raw, `actions.${a.id}.payload: externalized blobs cannot be imported`);
            const version = payloadVersion.safeParse((a.payload as { schemaVersion?: unknown }).schemaVersion);
            if (!version.success) return invalid(raw, `actions.${a.id}.payload: invalid schemaVersion`);
            payloads.push({ actionId: a.id, payload: p.data, schemaVersion: version.data });
        }

        for (const id of ids) seen.add(id);
        const created = sw.createdAt ? new Date(sw.createdAt) : null;
        return {
            ok: true,
            candidate: {
                id: sw.id,
                title: config.data.title,
                disarmed: sw.state === 'disarmed',
                createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
                input: config.data,
                payloads,
            },
        };
    });
}

/** What already exists on this server for the candidates' ids. */
export interface ImportLookup {
    /** Switch ids this owner already has here. */
    ownSwitchIds: Set<string>;
    /** Switch ids held by another owner (cloud only; always empty on a single-tenant core). */
    foreignSwitchIds: Set<string>;
    /** Recipient / action ids already in use by some other switch. */
    takenChildIds: Set<string>;
}

export interface ImportPlan {
    toCreate: ImportCandidate[];
    results: ImportResult[];
}

/** All ids a candidate would insert (switch, recipients, actions). */
export function candidateIds(c: ImportCandidate): { switchId: string; childIds: string[] } {
    return {
        switchId: c.id,
        childIds: [...c.input.recipients.map((r) => r.id ?? ''), ...c.input.actions.map((a) => a.id ?? '')].filter(
            Boolean,
        ),
    };
}

/**
 * Decide each switch's fate. An existing switch of this owner is left untouched
 * (never re-timed, never overwritten by an older file); an id held elsewhere is a
 * conflict; everything else is created. Results keep the file order.
 */
export function planImport(checks: ImportCheck[], lookup: ImportLookup): ImportPlan {
    const toCreate: ImportCandidate[] = [];
    const results = checks.map((check): ImportResult => {
        if (!check.ok) return check.result;
        const c = check.candidate;
        const base = { id: c.id, title: c.title };
        if (lookup.ownSwitchIds.has(c.id)) return { ...base, status: 'skipped', reason: 'exists' };
        if (lookup.foreignSwitchIds.has(c.id) || candidateIds(c).childIds.some((id) => lookup.takenChildIds.has(id))) {
            return { ...base, status: 'skipped', reason: 'conflict' };
        }
        toCreate.push(c);
        return { ...base, status: 'imported' };
    });
    return { toCreate, results };
}

export interface ImportReport {
    imported: number;
    skipped: number;
    results: ImportResult[];
}

export function importReport(results: ImportResult[]): ImportReport {
    const imported = results.filter((r) => r.status === 'imported').length;
    return { imported, skipped: results.length - imported, results };
}
