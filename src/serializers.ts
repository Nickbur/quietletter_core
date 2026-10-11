import type { SwitchPayloadRow } from './db/schema.js';
import type { SwitchWithChildren } from './service.js';

/** ISO string or null for a nullable timestamp. */
function toIso(d: Date | null | undefined): string | null {
    return d ? d.toISOString() : null;
}

/**
 * A switch as the owner's client consumes it — the full editable config plus the
 * server-authoritative state/timer, with recipients and actions nested. Encrypted
 * payloads are NOT here (uploaded/fetched per action). Mirrors the cloud DTO shape
 * minus the (non-existent here) userId/projectId.
 */
export function switchDTO(s: SwitchWithChildren): Record<string, unknown> {
    return {
        id: s.id,
        title: s.title,
        state: s.state,
        cadence: s.cadence,
        grace: s.grace,
        warnings: s.warnings,
        warningPhone: s.warningPhone ?? null,
        timezone: s.timezone ?? null,
        locale: s.locale ?? null,
        lastCheckinAt: toIso(s.lastCheckinAt),
        nextDeadline: toIso(s.nextDeadline),
        armedAt: toIso(s.armedAt),
        firedAt: toIso(s.firedAt),
        disarmedAt: toIso(s.disarmedAt),
        createdAt: toIso(s.createdAt) ?? new Date(0).toISOString(),
        updatedAt: toIso(s.updatedAt) ?? new Date(0).toISOString(),
        recipients: s.recipients.map((r) => ({
            id: r.id,
            email: r.email,
            phone: r.phone ?? null,
            name: r.name ?? null,
        })),
        actions: s.actions.map((a) => ({
            id: a.id,
            type: a.type,
            sortOrder: a.sortOrder,
            config: a.config,
            createdAt: toIso(a.createdAt),
            updatedAt: toIso(a.updatedAt),
        })),
    };
}

/** Ack for a payload upload — confirms what is stored WITHOUT echoing the ciphertext. */
export function payloadAckDTO(p: SwitchPayloadRow): Record<string, unknown> {
    return {
        actionId: p.actionId,
        mode: p.mode,
        hasCiphertext: Boolean(p.ciphertext),
        hasBlob: Boolean(p.blobRef),
        hasReadable: Boolean(p.readableContent),
        size: p.size ?? null,
        updatedAt: toIso(p.updatedAt),
    };
}
