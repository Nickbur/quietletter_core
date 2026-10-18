import { eq } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import {
    switchActions,
    switchPayloads,
    switchRecipients,
    switches,
    type ActionType,
    type CheckinCadence,
    type GraceConfig,
    type SwitchRow,
    type SwitchState,
    type WarningStep,
} from '../../src/db/schema.js';
import { uuidv7 } from '../../src/shared/id.js';

/**
 * Switch fixtures written straight into the database (bypassing the API), for tests that need a
 * switch in a given state — fired, in grace, legacy (no zone / language). Use it from a test file
 * that mocks `src/db/client.js` with `tests/helpers/db.ts`: the import below then resolves to that
 * in-process Postgres.
 */

export const HOUR = 3_600_000;
/** Last check-in of a seeded switch. */
export const T0 = new Date('2026-10-01T00:00:00.000Z');
/** Its deadline: T0 + the 7-day cadence. */
export const DEADLINE = new Date('2026-10-08T00:00:00.000Z');
/** An instant relative to the seeded deadline. */
export const at = (hoursAfterDeadline: number): Date => new Date(DEADLINE.getTime() + hoursAfterDeadline * HOUR);

/** A complete zero-knowledge envelope (opaque base64 strings — the server never reads them). */
export const ZK_FIELDS = {
    ciphertext: 'Y2lwaGVydGV4dA',
    wrappedKey: 'd3JhcHBlZA',
    salt: 'c2FsdA',
    nonce: 'bm9uY2U',
    algo: 'xchacha20poly1305-argon2id-v1',
} as const;

export interface SeedAction {
    type: ActionType;
    /** `zk` / `readable` = an uploaded payload of that mode; `none` (default for zk types) = never uploaded. */
    payload?: 'zk' | 'readable' | 'none';
    subject?: string;
    slug?: string;
    content?: string;
}

export interface SeedOptions {
    title?: string;
    state?: SwitchState;
    cadence?: CheckinCadence;
    grace?: GraceConfig;
    warnings?: WarningStep[];
    warningPhone?: string | null;
    timezone?: string | null;
    locale?: string | null;
    firedAt?: Date | null;
    recipients?: Array<{ email: string; name?: string | null }>;
    actions?: SeedAction[];
}

export interface Seeded {
    id: string;
    recipientIds: string[];
    actionIds: string[];
}

export async function seedSwitch(o: SeedOptions = {}): Promise<Seeded> {
    const id = uuidv7();
    await db.insert(switches).values({
        id,
        title: o.title ?? 'For my family',
        state: o.state ?? 'active',
        cadence: o.cadence ?? { value: 7, unit: 'day' },
        grace: o.grace ?? { value: 3, unit: 'day' },
        warnings: o.warnings ?? [{ offsetHours: 0, channels: ['push', 'email'] }],
        warningPhone: o.warningPhone ?? null,
        timezone: o.timezone ?? null,
        locale: o.locale ?? null,
        lastCheckinAt: T0,
        nextDeadline: DEADLINE,
        armedAt: T0,
        firedAt: o.firedAt ?? null,
        createdAt: T0,
        updatedAt: T0,
    });
    const recipientIds: string[] = [];
    for (const r of o.recipients ?? [{ email: 'heir@example.com', name: 'Heir' }]) {
        const [row] = await db
            .insert(switchRecipients)
            .values({ switchId: id, email: r.email, name: r.name ?? null })
            .returning({ id: switchRecipients.id });
        recipientIds.push(row!.id);
    }
    const actionIds: string[] = [];
    for (const [i, a] of (o.actions ?? []).entries()) {
        const mode = a.type === 'public_page' || a.payload === 'readable' ? 'readable' : 'zk';
        const [row] = await db
            .insert(switchActions)
            .values({
                switchId: id,
                type: a.type,
                sortOrder: i,
                config: {
                    mode,
                    ...(a.subject ? { subject: a.subject } : {}),
                    ...(a.slug ? { slug: a.slug } : {}),
                },
            })
            .returning({ id: switchActions.id });
        actionIds.push(row!.id);
        if (!a.payload || a.payload === 'none') continue;
        const payload =
            a.payload === 'zk'
                ? { switchId: id, actionId: row!.id, mode: 'zk' as const, size: 10, ...ZK_FIELDS }
                : {
                      switchId: id,
                      actionId: row!.id,
                      mode: 'readable' as const,
                      readableContent: a.content ?? 'I love you all.',
                  };
        await db.insert(switchPayloads).values(payload);
    }
    return { id, recipientIds, actionIds };
}

/** The stored switch row (throws when it is gone). */
export async function switchRow(id: string): Promise<SwitchRow> {
    const row = await db.query.switches.findFirst({ where: eq(switches.id, id) });
    if (!row) throw new Error(`switch ${id} missing`);
    return row;
}

/** A valid `PUT /v1/switches/:id` body: every safety floor met, one recipient, no actions. */
export function switchBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        title: 'For my family',
        cadence: { value: 7, unit: 'day' },
        grace: { value: 3, unit: 'day' },
        warnings: [
            { offsetHours: 0, channels: ['push', 'email'] },
            { offsetHours: 24, channels: ['email', 'sms'] },
        ],
        warningPhone: '+380 44 123 4567',
        timezone: 'Europe/Kyiv',
        locale: 'en',
        recipients: [{ email: 'heir@example.com', name: 'Heir' }],
        actions: [],
        ...over,
    };
}
