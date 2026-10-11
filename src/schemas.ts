import { z } from 'zod';
import { MIN_GRACE_HOURS } from './logic.js';
import { ValidationError } from './shared/errors.js';
import { isValidTimeZone } from './shared/timezone.js';

/** Parse a body against a schema, throwing a 400 ValidationError on failure. */
export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) {
        const first = result.error.issues[0];
        const detail = first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid request';
        throw new ValidationError('invalid_request', detail);
    }
    return result.data;
}

/**
 * Request validation. The wire shape mirrors the Quietletter client's `Switch` model
 * (camelCase) so the same client can talk to this core or the cloud. Safety floors
 * are enforced here as well as in the sweep: grace ≥ 48h, and every switch must
 * warn on at least push + email before it can fire.
 *
 * SELF-HOST DIVERGENCE: this build ACCEPTS the `public_page` action (the cloud
 * refuses it). A `public_page` is public plaintext, so it must be `readable`
 * mode; `file`/`secret`/`private_page` are always zero-knowledge; `message` may
 * be either.
 */

const emailStr = z
    .string()
    .trim()
    .min(3)
    .max(320)
    .refine((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), { message: 'invalid email' });

const phoneStr = z
    .string()
    .trim()
    .max(32)
    .refine((v) => /^\+?[0-9 ()-]{5,}$/.test(v), { message: 'invalid phone' });

const cadence = z.object({
    value: z.number().int().positive().max(3650),
    unit: z.enum(['day', 'week', 'month']),
});

const grace = z
    .object({
        value: z.number().int().positive().max(3650),
        unit: z.enum(['hour', 'day']),
    })
    .refine((g) => (g.unit === 'day' ? g.value * 24 : g.value) >= MIN_GRACE_HOURS, {
        message: `grace must be at least ${MIN_GRACE_HOURS} hours`,
    });

const warnChannel = z.enum(['push', 'email', 'sms']);

const warningStep = z.object({
    offsetHours: z.number().int().nonnegative().max(8760),
    channels: z.array(warnChannel).min(1).max(3),
});

/** At least push + email must appear somewhere across the escalation steps. */
const warnings = z
    .array(warningStep)
    .min(1)
    .max(20)
    .refine(
        (steps) => {
            const all = new Set(steps.flatMap((s) => s.channels));
            return all.has('push') && all.has('email');
        },
        { message: 'warnings must include at least push and email' },
    );

/** A public-page slug: lowercase url-safe token, 1–128 chars. */
const slugStr = z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((v) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v), {
        message: 'slug must be lowercase alphanumeric words separated by single hyphens',
    });

const actionConfig = z.object({
    mode: z.enum(['zk', 'readable']),
    subject: z.string().max(300).optional(),
    filename: z.string().max(300).optional(),
    mimeType: z.string().max(120).optional(),
    slug: slugStr.optional(),
});

const actionType = z.enum(['message', 'file', 'secret', 'private_page', 'public_page']);

const uuid = z.string().uuid();

const recipientInput = z.object({
    id: uuid.optional(),
    email: emailStr,
    phone: phoneStr.nullable().optional().default(null),
    name: z.string().trim().max(200).nullable().optional().default(null),
});

const actionInput = z
    .object({
        id: uuid.optional(),
        type: actionType,
        sortOrder: z.number().int().nonnegative().max(1000).optional().default(0),
        config: actionConfig,
    })
    .superRefine((a, ctx) => {
        // A public page is public plaintext — it cannot be zero-knowledge.
        if (a.type === 'public_page' && a.config.mode !== 'readable') {
            ctx.addIssue({
                code: 'custom',
                path: ['config', 'mode'],
                message: 'a public_page must use readable mode (public pages are plaintext)',
            });
        }
        // `readable` is only meaningful for a message or a public page.
        if (a.config.mode === 'readable' && a.type !== 'message' && a.type !== 'public_page') {
            ctx.addIssue({
                code: 'custom',
                path: ['config', 'mode'],
                message: 'readable mode is only allowed for a message or public_page action',
            });
        }
        // A slug only applies to a public page.
        if (a.config.slug && a.type !== 'public_page') {
            ctx.addIssue({
                code: 'custom',
                path: ['config', 'slug'],
                message: 'slug is only valid for a public_page action',
            });
        }
    });

/** A UI language code, e.g. `en`, `ru`, `pt-BR`. */
const localeStr = z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[A-Za-z]{2})?$/, 'expected a language code');

export const createSwitchSchema = z.object({
    title: z.string().trim().min(1).max(300),
    cadence: cadence.optional(),
    grace: grace.optional(),
    warnings: warnings.optional(),
    warningPhone: phoneStr.nullable().optional().default(null),
    // The saving device's IANA zone. Absent / null (older app builds) keeps the stored one.
    timezone: z.string().trim().max(64).refine(isValidTimeZone, { message: 'invalid time zone' }).nullable().optional(),
    // The saving app's UI language. Absent / null (older app builds) keeps the stored one.
    locale: localeStr.nullable().optional(),
    recipients: z.array(recipientInput).max(50).optional().default([]),
    actions: z.array(actionInput).max(20).optional().default([]),
});

export type CreateSwitchInput = z.output<typeof createSwitchSchema>;
export type RecipientInput = z.output<typeof recipientInput>;
export type ActionInput = z.output<typeof actionInput>;

/**
 * `PUT /switches/:id/regional` — the device settings a switch saved before switches
 * carried them is missing: its zone and the app's UI language. Same contract as the
 * hosted service (which keeps the language on the owner's account instead).
 */
export const regionalSchema = z.object({
    timezone: z.string().trim().max(64).refine(isValidTimeZone, { message: 'invalid time zone' }),
    locale: localeStr.optional(),
});

export type RegionalInput = z.output<typeof regionalSchema>;

/**
 * Request body cap for `PUT …/payload`. The real limit is the 2,000,000-char ciphertext
 * cap below (a ~1.12 MB file: the app base64s the file, encrypts it and base64s the
 * ciphertext); kept identical to the hosted service.
 */
export const PAYLOAD_BODY_LIMIT = 3 * 1024 * 1024;

/** Upload/replace the encrypted (or readable) payload for one action. */
export const putPayloadSchema = z
    .object({
        mode: z.enum(['zk', 'readable']),
        ciphertext: z.string().max(2_000_000).nullable().optional().default(null),
        wrappedKey: z.string().max(4096).nullable().optional().default(null),
        salt: z.string().max(512).nullable().optional().default(null),
        nonce: z.string().max(512).nullable().optional().default(null),
        algo: z.string().max(64).nullable().optional().default(null),
        blobRef: z.string().max(512).nullable().optional().default(null),
        size: z.number().int().nonnegative().nullable().optional().default(null),
        readableContent: z.string().max(200_000).nullable().optional().default(null),
    })
    .superRefine((p, ctx) => {
        if (p.mode === 'zk') {
            if (!p.ciphertext && !p.blobRef) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['ciphertext'],
                    message: 'zk payload needs ciphertext or blobRef',
                });
            }
            if (!p.wrappedKey)
                ctx.addIssue({ code: 'custom', path: ['wrappedKey'], message: 'zk payload needs wrappedKey' });
            if (!p.salt) ctx.addIssue({ code: 'custom', path: ['salt'], message: 'zk payload needs salt' });
            if (!p.nonce) ctx.addIssue({ code: 'custom', path: ['nonce'], message: 'zk payload needs nonce' });
        } else if (!p.readableContent) {
            ctx.addIssue({
                code: 'custom',
                path: ['readableContent'],
                message: 'readable payload needs readableContent',
            });
        }
    });

export type PutPayloadInput = z.output<typeof putPayloadSchema>;
