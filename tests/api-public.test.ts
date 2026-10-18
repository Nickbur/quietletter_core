import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/client.js', () => import('./helpers/db.js').then((m) => m.pgliteClient()));

import { db } from '../src/db/client.js';
import { releaseTokens } from '../src/db/schema.js';
import { getOrCreateReleaseToken, publishPublicPage } from '../src/service.js';
import { buildTestApp } from './helpers/app.js';
import { resetDb } from './helpers/db.js';
import { ZK_FIELDS, at, seedSwitch } from './helpers/switches.js';

/**
 * The unauthenticated surfaces a recipient (or the public) reaches: the content-blind release
 * bundle and its HTML page, the libsodium scripts that page loads from this instance, and the
 * self-host-only public page. None needs a token; none leaks whether an unknown link ever existed.
 */

let app: FastifyInstance;

beforeAll(async () => {
    app = await buildTestApp();
});

afterAll(async () => {
    await app.close();
});

beforeEach(async () => {
    await resetDb(db);
});

const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');
const FOOTER_DOCS = '<a href="https://docs.burakov.net/quietletter">Docs</a>';

async function firedSwitchWithToken(over: { firedAt?: Date | null; recipientName?: string | null } = {}) {
    const seeded = await seedSwitch({
        title: 'For my family',
        state: 'fired',
        firedAt: over.firedAt === undefined ? at(72) : over.firedAt,
        recipients: [
            { email: 'heir@example.com', name: over.recipientName === undefined ? 'Heir' : over.recipientName },
        ],
        actions: [
            { type: 'message', payload: 'readable', subject: 'To my family', content: 'I love you all.' },
            { type: 'secret', payload: 'zk' },
            { type: 'file', payload: 'none' },
        ],
    });
    const token = await getOrCreateReleaseToken(seeded.id, seeded.recipientIds[0]!, FAR_FUTURE);
    return { ...seeded, token };
}

describe('GET /v1/release/:token', () => {
    /** The recipient's bundle: ciphertext verbatim (the server never decrypts), readable text in the clear. */
    it('returns the content-blind bundle of a fired switch without any auth', async () => {
        const { token, actionIds } = await firedSwitchWithToken();
        const res = await app.inject({ method: 'GET', url: `/v1/release/${token}` });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            switchTitle: 'For my family',
            firedAt: at(72).toISOString(),
            recipientName: 'Heir',
            actions: [
                {
                    id: actionIds[0],
                    type: 'message',
                    config: { mode: 'readable', subject: 'To my family' },
                    payload: {
                        mode: 'readable',
                        ciphertext: null,
                        wrappedKey: null,
                        salt: null,
                        nonce: null,
                        algo: null,
                        blobRef: null,
                        readableContent: 'I love you all.',
                    },
                },
                {
                    id: actionIds[1],
                    type: 'secret',
                    config: { mode: 'zk' },
                    payload: { mode: 'zk', ...ZK_FIELDS, blobRef: null, readableContent: null },
                },
                { id: actionIds[2], type: 'file', config: { mode: 'zk' }, payload: null },
            ],
        });
    });

    it('sends null for an unknown fire time and an unnamed recipient', async () => {
        const { token } = await firedSwitchWithToken({ firedAt: null, recipientName: null });
        const res = await app.inject({ method: 'GET', url: `/v1/release/${token}` });
        expect(res.json()).toMatchObject({ firedAt: null, recipientName: null });
    });

    it('answers 404 for a token of the wrong length before looking it up', async () => {
        for (const token of ['short', 'x'.repeat(65)]) {
            const res = await app.inject({ method: 'GET', url: `/v1/release/${token}` });
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ code: 'not_found', message: 'invalid release link' });
        }
    });

    it('answers the same 404 for an unknown token, an expired one and a switch that has not fired', async () => {
        const fired = await firedSwitchWithToken();
        await db.insert(releaseTokens).values({
            token: 'expired-token-0123456789',
            switchId: fired.id,
            recipientId: fired.recipientIds[0]!,
            expiresAt: new Date('2020-01-01T00:00:00.000Z'),
        });
        const live = await seedSwitch({ state: 'grace' });
        const early = await getOrCreateReleaseToken(live.id, live.recipientIds[0]!, FAR_FUTURE);

        for (const token of ['unknown-token-0123456789', 'expired-token-0123456789', early]) {
            const res = await app.inject({ method: 'GET', url: `/v1/release/${token}` });
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ code: 'not_found', message: 'this release link is not valid' });
        }
    });
});

describe('GET /release/:token', () => {
    /** The page the fire email links to: private (noindex), it fetches the bundle and decrypts in the browser. */
    it('serves the release page for the token, noindex, with the footer links', async () => {
        const res = await app.inject({ method: 'GET', url: '/release/token-0123456789abcdef' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('var TOKEN = "token-0123456789abcdef";');
        expect(res.body).toContain('<meta name="robots" content="noindex,nofollow">');
        expect(res.body).toContain("fetch('/v1/release/' + encodeURIComponent(TOKEN))");
        expect(res.body).toContain(FOOTER_DOCS);
        expect(res.body).toContain('<a href="https://burakov.net/projects/quietletter/privacy">Privacy</a>');
        expect(res.body).toContain('<a href="https://burakov.net/projects/quietletter/terms">Terms</a>');
    });

    // Regression: the token went into the inline script as plain JSON, so a link carrying
    // `</script>` closed the script and ran its own on the page where recipients type passphrases.
    it('never lets a release-link token break out of the page script', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/release/%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain('<script>alert(1)</script>');
        expect(res.body).toContain('var TOKEN = "\\u003c/script>\\u003cscript>alert(1)\\u003c/script>";');
    });

    it('serves an HTML 404 page for a token of the wrong length', async () => {
        const res = await app.inject({ method: 'GET', url: '/release/short' });
        expect(res.statusCode).toBe(404);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('<h1>Not found</h1><p class="muted">Invalid release link.</p>');
        expect(res.body).toContain('noindex');
        expect(res.body).toContain(FOOTER_DOCS);
    });
});

describe('GET /vendor/:file', () => {
    /** The decryptor's libsodium comes from this instance, cacheable, and nothing else is served. */
    it('serves the vendored libsodium scripts as cacheable JavaScript', async () => {
        for (const file of ['libsodium-sumo.js', 'libsodium-wrappers.js']) {
            const res = await app.inject({ method: 'GET', url: `/vendor/${file}` });
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
            expect(res.headers['cache-control']).toBe('public, max-age=86400');
            expect(res.body).toContain('libsodium');
        }
    });

    it('answers 404 not_found for any other file, path tricks included', async () => {
        for (const file of ['sodium.js', '..%2Fpackage.json', 'constructor']) {
            const res = await app.inject({ method: 'GET', url: `/vendor/${file}` });
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ code: 'not_found', message: 'not found' });
        }
    });
});

describe('GET /p/:slug', () => {
    /** The self-host-only public page: indexable plaintext once the switch fired, escaped, and it stays up. */
    it('serves a published page as indexable, escaped HTML', async () => {
        const fired = await seedSwitch({
            state: 'fired',
            firedAt: at(72),
            actions: [{ type: 'public_page', payload: 'readable', slug: 'my-statement' }],
        });
        const action = await db.query.switchActions.findFirst();
        const slug = await publishPublicPage(
            fired.id,
            action!,
            'The truth <b>was</b> "hidden" & now it is not.',
            'My <statement>',
            at(72),
        );
        expect(slug).toBe('my-statement');

        const res = await app.inject({ method: 'GET', url: '/p/my-statement' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).not.toContain('noindex');
        expect(res.body).toContain('<title>My &lt;statement&gt;</title>');
        expect(res.body).toContain('<h1>My &lt;statement&gt;</h1>');
        expect(res.body).toContain(
            '<div class="content">The truth &lt;b&gt;was&lt;/b&gt; &quot;hidden&quot; &amp; now it is not.</div>',
        );
        expect(res.body).toContain('<time datetime="2026-10-11T00:00:00.000Z">');
        expect(res.body).toContain(FOOTER_DOCS);
    });

    it('serves an HTML 404 page, noindex, for an unknown slug', async () => {
        const res = await app.inject({ method: 'GET', url: '/p/nothing-here' });
        expect(res.statusCode).toBe(404);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(res.body).toContain('No public page is published at this address.');
        expect(res.body).toContain('noindex');
    });
});

describe('health, CORS and unknown routes', () => {
    /** Liveness for the container, browser access for the web client, and the flat error contract. */
    it('answers the health check at the root and under /v1, trailing slash or not', async () => {
        for (const url of ['/health', '/v1/health', '/health/']) {
            const res = await app.inject({ method: 'GET', url });
            expect(res.statusCode).toBe(200);
            expect(res.json()).toEqual({ status: 'ok' });
        }
    });

    it('lets a browser client preflight the owner API with PUT / DELETE and its custom headers', async () => {
        const res = await app.inject({
            method: 'OPTIONS',
            url: '/v1/switches/0190a5d0-ac96-774b-bcce-b302099a8057',
            headers: {
                origin: 'https://app.example.com',
                'access-control-request-method': 'DELETE',
                'access-control-request-headers': 'authorization,content-type,x-client-id,x-app-version',
            },
        });
        expect(res.statusCode).toBe(204);
        expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
        expect(res.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PUT, DELETE, OPTIONS');
        expect(res.headers['access-control-allow-headers']).toBe(
            'Content-Type, Authorization, X-Client-Id, X-App-Version',
        );
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('reflects the origin on a plain cross-origin request', async () => {
        const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://app.example.com' } });
        expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    });

    it('answers an unknown route with 404 { code: not_found }', async () => {
        for (const url of ['/nope', '/v1/nope', '/p/']) {
            const res = await app.inject({ method: 'GET', url });
            expect(res.statusCode).toBe(404);
            expect(res.json()).toEqual({ code: 'not_found', message: 'not found' });
        }
    });
});
