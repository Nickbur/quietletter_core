import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ConflictError } from '../src/shared/errors.js';

/**
 * The server's error contract: every failure leaves as the flat `{ code, message }` the Quietletter
 * client switches on, a 5xx never leaks internals, a burst is cut off with 429 `rate_limited`, and
 * the JSON parser tolerates the empty body kit clients send on body-less requests. Probe routes are
 * added to the real app (`buildApp()`) before it is readied; nothing here touches the database.
 */

let app: FastifyInstance;

function fail(statusCode: number | undefined, message: string, extra: Record<string, unknown> = {}): Error {
    return Object.assign(new Error(message), statusCode === undefined ? {} : { statusCode }, extra);
}

beforeAll(async () => {
    app = await buildApp();
    app.get('/t/api', async () => {
        throw new ConflictError('already_fired', 'a fired switch cannot be edited');
    });
    app.get('/t/429', async () => {
        throw fail(429, '');
    });
    app.get('/t/rate-code', async () => {
        throw fail(undefined, 'slow down', { code: 'rate_limited' });
    });
    app.post('/t/schema', { schema: { body: { type: 'object', required: ['a'] } } }, async () => ({ ok: true }));
    app.get('/t/crash', async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432 (password=hunter2)');
    });
    app.get('/t/503', async () => {
        throw fail(503, 'upstream down');
    });
    app.get('/t/418', async () => {
        throw fail(418, "I'm a teapot");
    });
    app.get('/t/418-blank', async () => {
        throw fail(418, '');
    });
    app.post('/t/echo', async (request) => ({ body: request.body ?? null }));
    await app.ready();
});

afterAll(async () => {
    await app.close();
});

describe('error contract', () => {
    it('sends an ApiError as its own status and { code, message }', async () => {
        const res = await app.inject({ method: 'GET', url: '/t/api' });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ code: 'already_fired', message: 'a fired switch cannot be edited' });
    });

    it('maps a 429 (or a rate_limited code) to 429 rate_limited, with a default message', async () => {
        const bare = await app.inject({ method: 'GET', url: '/t/429' });
        expect(bare.statusCode).toBe(429);
        expect(bare.json()).toEqual({ code: 'rate_limited', message: 'too many requests' });

        const coded = await app.inject({ method: 'GET', url: '/t/rate-code' });
        expect(coded.statusCode).toBe(429);
        expect(coded.json()).toEqual({ code: 'rate_limited', message: 'slow down' });
    });

    it('maps a schema validation failure to 400 invalid_request without the validator detail', async () => {
        const res = await app.inject({ method: 'POST', url: '/t/schema', payload: { b: 1 } });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ code: 'invalid_request', message: 'invalid request' });
    });

    it('never leaks a 5xx: any unexpected error is 500 internal_error', async () => {
        for (const url of ['/t/crash', '/t/503']) {
            const res = await app.inject({ method: 'GET', url });
            expect(res.statusCode).toBe(500);
            expect(res.json()).toEqual({ code: 'internal_error', message: 'internal server error' });
            expect(res.body).not.toContain('hunter2');
        }
    });

    it('passes another 4xx through with its status and message, or a default message', async () => {
        const res = await app.inject({ method: 'GET', url: '/t/418' });
        expect(res.statusCode).toBe(418);
        expect(res.json()).toEqual({ code: 'error', message: "I'm a teapot" });

        const blank = await app.inject({ method: 'GET', url: '/t/418-blank' });
        expect(blank.json()).toEqual({ code: 'error', message: 'error' });
    });

    it('answers an unknown route with 404 not_found', async () => {
        const res = await app.inject({ method: 'DELETE', url: '/v2/anything' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ code: 'not_found', message: 'not found' });
    });
});

describe('JSON body parser', () => {
    const post = (payload: string) =>
        app.inject({ method: 'POST', url: '/t/echo', headers: { 'content-type': 'application/json' }, payload });

    it('treats an empty or blank JSON body as no body', async () => {
        for (const payload of ['', '   \n']) {
            const res = await post(payload);
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ body: null });
        }
    });

    it('parses a JSON body', async () => {
        expect((await post(' {"a":[1,2]} ')).json()).toEqual({ body: { a: [1, 2] } });
    });

    it('refuses malformed JSON with 400 in the flat error shape', async () => {
        const res = await post('{"a":');
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 'error', message: expect.any(String) });
    });

    it('refuses a body over the 8 MB default cap with 413', async () => {
        const res = await post(JSON.stringify({ blob: 'a'.repeat(8 * 1024 * 1024) }));
        expect(res.statusCode).toBe(413);
        expect(res.json().code).toBe('error');
    });
});

describe('rate limit', () => {
    /** 300 requests a minute per client; the 301st is refused in the flat contract, with retry advice. */
    it('answers the 301st request in a minute with 429 rate_limited', async () => {
        const limited = await buildApp();
        await limited.ready();
        try {
            for (let i = 0; i < 300; i++) {
                const ok = await limited.inject({ method: 'GET', url: '/health' });
                expect(ok.statusCode).toBe(200);
            }
            const res = await limited.inject({ method: 'GET', url: '/health' });
            expect(res.statusCode).toBe(429);
            expect(res.json()).toEqual({ code: 'rate_limited', message: 'Rate limit exceeded, retry in 1 minute' });
            expect(res.headers['retry-after']).toBe('60');
            expect(res.headers['x-ratelimit-limit']).toBe('300');
        } finally {
            await limited.close();
        }
    });
});
