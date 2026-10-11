import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../shared/id.js';

/**
 * Quietletter continuity core — the AGPL, self-hostable implementation of the
 * zero-knowledge digital dead man's switch. A `switch` fires composable actions
 * (deliver a message, release an encrypted file/secret, publish a private or a
 * truly-public page) when the owner stops "checking in" within a safeguarded
 * grace window.
 *
 * SINGLE-TENANT: unlike the multi-app cloud backend, there are no `user_id` /
 * `project_id` columns — every switch belongs to the one bootstrapped owner who
 * authenticates with `OWNER_TOKEN`. The wire protocol (field names, JSON shapes,
 * timing math, release-token flow) is otherwise identical, so what a user set up
 * on the cloud can be reproduced here and outlive any single company.
 *
 * SERVER-AUTHORITATIVE: the switch STATE + `nextDeadline` are decided here (the
 * sweep fires from server truth — a device may be offline through the whole grace
 * window). The client sends config; firing is decided server-side.
 *
 * ZERO-KNOWLEDGE boundary: the server stores payload CIPHERTEXT + a passphrase-
 * wrapped content key and NEVER the passphrase or plaintext — except content an
 * action explicitly marks "readable" (a message, or a `public_page` body, which is
 * public plaintext by definition). Metadata the sweep needs — cadence, deadline,
 * recipient address, action type, state — IS server-readable.
 */

// --- Config value types (stored as jsonb, mirror the client model verbatim) ---

export type CadenceUnit = 'day' | 'week' | 'month';
export type GraceUnit = 'hour' | 'day';
export type WarnChannel = 'push' | 'email' | 'sms';

/** How often the owner must check in. */
export interface CheckinCadence {
    value: number;
    unit: CadenceUnit;
}

/** After the deadline passes, how long before the switch fires. Floor: 48h (enforced). */
export interface GraceConfig {
    value: number;
    unit: GraceUnit;
}

/** One escalation step, `offsetHours` AFTER the deadline (0 = at the deadline). */
export interface WarningStep {
    offsetHours: number;
    channels: WarnChannel[];
}

/** active = before deadline; grace = deadline passed, warnings running; then fired. */
export type SwitchState = 'active' | 'grace' | 'fired' | 'disarmed';

/**
 * The composable action types. The continuity core ACCEPTS `public_page` — the
 * truly-public "leak" action the cloud refuses (it is incompatible with ZK and
 * its publishing liability sits with the self-hoster). This is the whole point of
 * the self-host build.
 */
export type ActionType = 'message' | 'file' | 'secret' | 'private_page' | 'public_page';

/** Per-action config (server-readable metadata only; never the ZK plaintext). */
export interface ActionConfig {
    /** 'zk' = end-to-end encrypted (server blind); 'readable' = server-composed plaintext. */
    mode: 'zk' | 'readable';
    /** Optional display metadata (subject/title, original filename, mime) — no secret content. */
    subject?: string;
    filename?: string;
    mimeType?: string;
    /** For `public_page`: the desired public slug (`/p/:slug`). Auto-generated when absent. */
    slug?: string;
}

/** The defaults a new switch gets (the "Balanced" preset). */
export function defaultCadence(): CheckinCadence {
    return { value: 30, unit: 'day' };
}
export function defaultGrace(): GraceConfig {
    return { value: 14, unit: 'day' };
}
export function defaultWarnings(): WarningStep[] {
    return [
        { offsetHours: 0, channels: ['push', 'email'] },
        { offsetHours: 72, channels: ['push', 'email'] },
        { offsetHours: 168, channels: ['push', 'email'] },
    ];
}

// --- Tables ------------------------------------------------------------------

export const switches = pgTable(
    'quietletter_switches',
    {
        id: uuid('id').primaryKey().$defaultFn(uuidv7),

        title: varchar('title', { length: 300 }).notNull(),

        /** Lifecycle state — SERVER-AUTHORITATIVE, advanced only by the sweep + check-in. */
        state: varchar('state', { length: 16 }).$type<SwitchState>().default('active').notNull(),

        /** Owner-editable safety config, stored verbatim from the client model. */
        cadence: jsonb('cadence').$type<CheckinCadence>().default(defaultCadence()).notNull(),
        grace: jsonb('grace').$type<GraceConfig>().default(defaultGrace()).notNull(),
        warnings: jsonb('warnings').$type<WarningStep[]>().default(defaultWarnings()).notNull(),

        /** Optional phone for SMS warnings to the OWNER (console-only in the core). */
        warningPhone: varchar('warning_phone', { length: 32 }),

        /**
         * IANA zone of the device that last saved the switch: the cadence steps on its
         * calendar and the warning email shows the fire time on its clock. Null on
         * switches saved before the column — those step in the process zone and the
         * email prints UTC.
         */
        timezone: varchar('timezone', { length: 64 }),

        /**
         * UI language of the app that last saved the switch (`en`, `ru`, …): the warning
         * and the recipients' emails are written in it (Russian for `ru`, else English).
         * Null on switches saved before the column — English until the app fills it in.
         */
        locale: varchar('locale', { length: 16 }),

        /** Proof-of-life bookkeeping. `nextDeadline` = lastCheckinAt + cadence (denormalized, indexed). */
        lastCheckinAt: timestamp('last_checkin_at', { withTimezone: true }).defaultNow().notNull(),
        nextDeadline: timestamp('next_deadline', { withTimezone: true }).notNull(),

        armedAt: timestamp('armed_at', { withTimezone: true }),
        firedAt: timestamp('fired_at', { withTimezone: true }),
        disarmedAt: timestamp('disarmed_at', { withTimezone: true }),

        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => ({
        deadlineIdx: index('quietletter_switches_deadline_idx').on(table.nextDeadline),
        stateIdx: index('quietletter_switches_state_idx').on(table.state),
    }),
);

export type SwitchRow = typeof switches.$inferSelect;
export type NewSwitch = typeof switches.$inferInsert;

/** Recipients of a switch. Server-readable (the address is needed to deliver). */
export const switchRecipients = pgTable(
    'quietletter_switch_recipients',
    {
        id: uuid('id').primaryKey().$defaultFn(uuidv7),
        switchId: uuid('switch_id')
            .references(() => switches.id, { onDelete: 'cascade' })
            .notNull(),
        email: varchar('email', { length: 320 }).notNull(),
        phone: varchar('phone', { length: 32 }),
        name: varchar('name', { length: 200 }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => ({
        switchIdx: index('quietletter_recipients_switch_idx').on(table.switchId),
    }),
);

export type SwitchRecipientRow = typeof switchRecipients.$inferSelect;

/** The composable actions of a switch (metadata only; the encrypted body is in `switch_payloads`). */
export const switchActions = pgTable(
    'quietletter_switch_actions',
    {
        id: uuid('id').primaryKey().$defaultFn(uuidv7),
        switchId: uuid('switch_id')
            .references(() => switches.id, { onDelete: 'cascade' })
            .notNull(),
        type: varchar('type', { length: 24 }).$type<ActionType>().notNull(),
        sortOrder: integer('sort_order').default(0).notNull(),
        config: jsonb('config').$type<ActionConfig>().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => ({
        switchIdx: index('quietletter_actions_switch_idx').on(table.switchId),
    }),
);

export type SwitchActionRow = typeof switchActions.$inferSelect;

/**
 * The BLIND payload store — one row per action. The server never parses these: for
 * a ZK payload it holds only `ciphertext` + the passphrase-wrapped `wrappedKey` +
 * `salt`/`nonce`; for a `readable` message or `public_page` it holds
 * `readableContent`. Large files are externalized by `blobRef`.
 */
export const switchPayloads = pgTable(
    'quietletter_switch_payloads',
    {
        id: uuid('id').primaryKey().$defaultFn(uuidv7),
        switchId: uuid('switch_id')
            .references(() => switches.id, { onDelete: 'cascade' })
            .notNull(),
        actionId: uuid('action_id')
            .references(() => switchActions.id, { onDelete: 'cascade' })
            .notNull(),
        /** 'zk' (server blind) or 'readable' (plaintext content, disclosed). */
        mode: varchar('mode', { length: 12 }).$type<'zk' | 'readable'>().notNull(),

        /** ZK envelope — opaque to the server. */
        ciphertext: varchar('ciphertext', { length: 2_000_000 }),
        wrappedKey: varchar('wrapped_key', { length: 4096 }),
        salt: varchar('salt', { length: 512 }),
        nonce: varchar('nonce', { length: 512 }),
        algo: varchar('algo', { length: 64 }),
        /** Externalized ciphertext blob (uploaded file), referenced not inlined. */
        blobRef: varchar('blob_ref', { length: 512 }),
        size: integer('size'),

        /** Readable-mode content (server-composed message or public-page body). Null for ZK. */
        readableContent: varchar('readable_content', { length: 200_000 }),

        schemaVersion: integer('schema_version').default(1).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => ({
        switchIdx: index('quietletter_payloads_switch_idx').on(table.switchId),
        actionUniq: uniqueIndex('quietletter_payloads_action_uniq').on(table.actionId),
    }),
);

export type SwitchPayloadRow = typeof switchPayloads.$inferSelect;

/**
 * A single-use, expiring token that lets ONE recipient reach a fired switch's
 * payloads on the public release page — no account required. Issued at fire time.
 */
export const releaseTokens = pgTable(
    'quietletter_release_tokens',
    {
        token: varchar('token', { length: 64 }).primaryKey(),
        switchId: uuid('switch_id')
            .references(() => switches.id, { onDelete: 'cascade' })
            .notNull(),
        recipientId: uuid('recipient_id')
            .references(() => switchRecipients.id, { onDelete: 'cascade' })
            .notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => ({
        switchIdx: index('quietletter_release_tokens_switch_idx').on(table.switchId),
    }),
);

export type ReleaseTokenRow = typeof releaseTokens.$inferSelect;

/**
 * SELF-HOST ONLY. A truly-public page published when a switch with a `public_page`
 * action fires — the "leak" the cloud refuses to host. Served in the clear at
 * `/p/:slug`; content is plaintext (public pages are incompatible with ZK). Not
 * subject to the retention purge — a published leak is meant to stay up.
 */
export const publicPages = pgTable(
    'quietletter_public_pages',
    {
        slug: varchar('slug', { length: 128 }).primaryKey(),
        switchId: uuid('switch_id')
            .references(() => switches.id, { onDelete: 'cascade' })
            .notNull(),
        /** One published page per action (idempotent publish on a sweep retry). */
        actionId: uuid('action_id')
            .references(() => switchActions.id, { onDelete: 'cascade' })
            .notNull(),
        title: varchar('title', { length: 300 }).notNull(),
        content: text('content').notNull(),
        publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => ({
        switchIdx: index('quietletter_public_pages_switch_idx').on(table.switchId),
        actionUniq: uniqueIndex('quietletter_public_pages_action_uniq').on(table.actionId),
    }),
);

export type PublicPageRow = typeof publicPages.$inferSelect;

/**
 * Idempotency ledger for the sweep. One row per delivery actually made:
 * `(switchId, kind, stepKey)` is unique, so a re-run (crash, overlap, catch-up)
 * inserts-or-skips instead of re-sending.
 *   - kind `warning` → stepKey `<nextDeadline ISO>:<warningIndex>` (a new check-in
 *     cycle gets a new deadline anchor, so next cycle's warnings can fire again).
 *   - kind `fire`    → stepKey `<recipientId>` (fire once per recipient).
 * Public pages are not in this ledger: `quietletter_public_pages` has one row per
 * action (unique `action_id`), which is what makes publishing idempotent.
 */
export const switchDeliveries = pgTable(
    'quietletter_switch_deliveries',
    {
        id: uuid('id').primaryKey().$defaultFn(uuidv7),
        switchId: uuid('switch_id')
            .references(() => switches.id, { onDelete: 'cascade' })
            .notNull(),
        kind: varchar('kind', { length: 12 }).$type<'warning' | 'fire'>().notNull(),
        stepKey: varchar('step_key', { length: 128 }).notNull(),
        sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => ({
        uniqSend: uniqueIndex('quietletter_switch_deliveries_unique_idx').on(table.switchId, table.kind, table.stepKey),
    }),
);

export type SwitchDeliveryRow = typeof switchDeliveries.$inferSelect;
