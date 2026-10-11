import 'dotenv/config';
import { z } from 'zod';

/**
 * Validated runtime configuration for the Quietletter continuity core.
 *
 * This is a SINGLE-TENANT, self-hostable server: there are no users, projects,
 * client ids, or entitlements — the one bootstrapped owner authenticates with a
 * static bearer token (`OWNER_TOKEN`) and everything is "pro"/unlimited. The
 * public release + public-page routes are unauthenticated (token/slug scoped).
 *
 * Email is optional: without an SMTP host (or with EMAIL_DEV_MODE=true) mail is
 * printed to the console, and push/SMS warnings are always console-only here —
 * the core ships no OneSignal/Twilio integration by design (see README).
 */

/** Parse a boolean-ish env string ("true"/"1"/"yes" ⇒ true), defaulting when absent. */
function boolEnv(def: boolean) {
    return z
        .preprocess((v) => {
            if (v === undefined || v === '') return def;
            if (typeof v === 'boolean') return v;
            const s = String(v).trim().toLowerCase();
            return s === 'true' || s === '1' || s === 'yes' || s === 'on';
        }, z.boolean())
        .default(def);
}

const schema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    /** PostgreSQL connection string. Required. */
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    /**
     * The single owner's bearer token. Every `/v1/switches*` call must send
     * `Authorization: Bearer <OWNER_TOKEN>`. Generate a strong one, e.g.
     * `openssl rand -hex 32`. Minimum 16 chars — a weak token here means anyone
     * can disarm or reconfigure a dead man's switch.
     */
    OWNER_TOKEN: z.string().min(16, 'OWNER_TOKEN must be at least 16 characters'),

    /**
     * Public base URL of this instance (no trailing slash), used to build the
     * release links in fire emails and the public-page URLs.
     */
    PUBLIC_URL: z
        .string()
        .url()
        .default('http://localhost:8080')
        .transform((u) => u.replace(/\/+$/, '')),

    /**
     * Footer links on the public pages (release, public page, not-found): the user guide
     * and the legal documents. They default to Quietletter's own; an operator running an
     * instance for other people points PRIVACY_URL / TERMS_URL at their own documents.
     */
    DOCS_URL: z.string().url().default('https://docs.burakov.net/quietletter'),
    PRIVACY_URL: z.string().url().default('https://burakov.net/projects/quietletter/privacy'),
    TERMS_URL: z.string().url().default('https://burakov.net/projects/quietletter/terms'),

    /** In-process sweep cadence in seconds. 0 disables the interval (use cron instead). */
    SWEEP_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().max(86_400).default(60),

    /**
     * How long after firing the server keeps encrypted payloads + release tokens
     * before the retention purge deletes them. Also the release-link lifetime.
     */
    FIRE_RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(90),

    // --- Email (optional) ------------------------------------------------------
    /**
     * Where owner check-in warning emails go. Empty or unset ⇒ warnings are
     * console-only. `.env` files carry an empty string rather than `undefined`
     * (the documented "leave it blank" case), so an empty value is normalized to
     * unset before the email check runs.
     */
    OWNER_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().optional()),
    /** When true (or when SMTP_HOST is unset), email is printed to the console. */
    EMAIL_DEV_MODE: boolEnv(false),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
    SMTP_SECURE: boolEnv(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    MAIL_FROM: z.string().default('Quietletter <no-reply@quietletter.local>'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    // eslint-disable-next-line no-console
    console.error(`[env] invalid configuration:\n${lines.join('\n')}`);
    process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
