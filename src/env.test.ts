import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * Runtime configuration: a self-hoster sets a handful of variables and the rest falls back to safe
 * defaults; `.env` blanks mean "unset"; a misconfigured instance refuses to start with a readable
 * list of what is wrong instead of running with a weak owner token or a broken database URL.
 * `env` is parsed once at import, so each case re-imports the module with `process.env` stubbed.
 */

const OPTIONAL = [
    'NODE_ENV',
    'HOST',
    'PORT',
    'LOG_LEVEL',
    'PUBLIC_URL',
    'DOCS_URL',
    'PRIVACY_URL',
    'TERMS_URL',
    'SWEEP_INTERVAL_SECONDS',
    'FIRE_RETENTION_DAYS',
    'OWNER_EMAIL',
    'EMAIL_DEV_MODE',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASS',
    'MAIL_FROM',
];

let exit: MockInstance<typeof process.exit>;
let error: MockInstance<typeof console.error>;

beforeEach(() => {
    for (const name of OPTIONAL) vi.stubEnv(name, undefined);
    vi.stubEnv('DATABASE_URL', 'postgres://core:core@db:5432/core');
    vi.stubEnv('OWNER_TOKEN', 'a-strong-owner-token-0123456789');
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

async function loadEnv(vars: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
    vi.resetModules();
    return (await import('./env.js')).env;
}

describe('defaults', () => {
    it('runs a production instance on 0.0.0.0:8080 with console mail when only the required values are set', async () => {
        const env = await loadEnv();
        expect(env).toEqual({
            NODE_ENV: 'production',
            HOST: '0.0.0.0',
            PORT: 8080,
            LOG_LEVEL: 'info',
            DATABASE_URL: 'postgres://core:core@db:5432/core',
            OWNER_TOKEN: 'a-strong-owner-token-0123456789',
            PUBLIC_URL: 'http://localhost:8080',
            DOCS_URL: 'https://docs.burakov.net/quietletter',
            PRIVACY_URL: 'https://burakov.net/projects/quietletter/privacy',
            TERMS_URL: 'https://burakov.net/projects/quietletter/terms',
            SWEEP_INTERVAL_SECONDS: 60,
            FIRE_RETENTION_DAYS: 90,
            EMAIL_DEV_MODE: false,
            SMTP_PORT: 587,
            SMTP_SECURE: false,
            MAIL_FROM: 'Quietletter <no-reply@quietletter.local>',
        });
        expect(exit).not.toHaveBeenCalled();
    });

    it('coerces numbers and takes the operator values', async () => {
        const env = await loadEnv({
            NODE_ENV: 'development',
            PORT: '3000',
            SWEEP_INTERVAL_SECONDS: '0',
            FIRE_RETENTION_DAYS: '30',
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: '465',
            TERMS_URL: 'https://example.org/terms',
        });
        expect(env).toMatchObject({
            NODE_ENV: 'development',
            PORT: 3000,
            SWEEP_INTERVAL_SECONDS: 0,
            FIRE_RETENTION_DAYS: 30,
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: 465,
            TERMS_URL: 'https://example.org/terms',
        });
    });
});

describe('normalization', () => {
    it('reads "true" / "1" / "yes" / "on" as true, in any case and with spaces', async () => {
        for (const value of ['true', '1', ' YES ', 'On']) {
            const env = await loadEnv({ EMAIL_DEV_MODE: value, SMTP_SECURE: value });
            expect([env.EMAIL_DEV_MODE, env.SMTP_SECURE], value).toEqual([true, true]);
        }
    });

    it('reads anything else as false, and a blank as the default', async () => {
        for (const value of ['false', '0', 'no', 'off', 'enabled', '']) {
            const env = await loadEnv({ EMAIL_DEV_MODE: value, SMTP_SECURE: value });
            expect([env.EMAIL_DEV_MODE, env.SMTP_SECURE], value).toEqual([false, false]);
        }
    });

    it('treats a blank OWNER_EMAIL as unset and keeps a real one', async () => {
        expect((await loadEnv({ OWNER_EMAIL: '' })).OWNER_EMAIL).toBeUndefined();
        expect((await loadEnv({ OWNER_EMAIL: 'owner@example.com' })).OWNER_EMAIL).toBe('owner@example.com');
        expect(exit).not.toHaveBeenCalled();
    });

    it('trims trailing slashes off PUBLIC_URL so release links never get a double slash', async () => {
        expect((await loadEnv({ PUBLIC_URL: 'https://core.example.com///' })).PUBLIC_URL).toBe(
            'https://core.example.com',
        );
        expect((await loadEnv({ PUBLIC_URL: 'https://example.com/ql/' })).PUBLIC_URL).toBe('https://example.com/ql');
    });
});

describe('invalid configuration', () => {
    it('refuses to start, listing every problem by variable', async () => {
        await loadEnv({
            DATABASE_URL: '',
            OWNER_TOKEN: 'short',
            PORT: 'eighty',
            OWNER_EMAIL: 'not-an-email',
            LOG_LEVEL: 'loud',
        });
        expect(exit).toHaveBeenCalledWith(1);
        const message = String(error.mock.calls[0]?.[0]);
        expect(message.split('\n')[0]).toBe('[env] invalid configuration:');
        expect(message).toContain('  - DATABASE_URL: DATABASE_URL is required');
        expect(message).toContain('  - OWNER_TOKEN: OWNER_TOKEN must be at least 16 characters');
        expect(message).toMatch(/ {2}- PORT: /);
        expect(message).toMatch(/ {2}- OWNER_EMAIL: /);
        expect(message).toMatch(/ {2}- LOG_LEVEL: /);
    });

    it('refuses a missing owner token and an out-of-range port', async () => {
        vi.stubEnv('OWNER_TOKEN', undefined);
        await loadEnv({ PORT: '70000' });
        expect(exit).toHaveBeenCalledWith(1);
        const message = String(error.mock.calls[0]?.[0]);
        expect(message).toMatch(/ {2}- OWNER_TOKEN: /);
        expect(message).toMatch(/ {2}- PORT: /);
    });
});
