import { afterAll, describe, expect, it, vi } from 'vitest';

// `env` is parsed once at import: run this file as a development instance.
vi.hoisted(() => {
    process.env.NODE_ENV = 'development';
});

import { buildApp } from '../src/app.js';
import { env } from '../src/env.js';

/**
 * A development instance asks for the pretty console logger only when the optional `pino-pretty`
 * package is installed. The core does not depend on it, so a plain checkout must still boot with
 * the default JSON logger instead of crashing on a missing transport.
 */

const app = await buildApp();

afterAll(async () => {
    await app.close();
});

describe('development logger', () => {
    it('boots whether or not the optional pino-pretty is installed, and serves requests', async () => {
        expect(env.NODE_ENV).toBe('development');
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'ok' });
    });
});
