import { createRequire } from 'node:module';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './env.js';
import { ApiError } from './shared/errors.js';
import { ownerRoutes, publicApiRoutes, publicPageRoutes } from './routes.js';

function prettyTransport(): { target: string; options: object } | undefined {
    if (env.NODE_ENV !== 'development') return undefined;
    try {
        createRequire(import.meta.url).resolve('pino-pretty');
        return { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
    } catch {
        return undefined;
    }
}

/** Every error leaves as the flat contract { code, message }; 5xx never leaks internals. */
function registerErrorHandler(app: FastifyInstance): void {
    app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
        if (error instanceof ApiError) {
            return reply.code(error.statusCode).send(error.body);
        }
        if (error.statusCode === 429 || (error as { code?: string }).code === 'rate_limited') {
            return reply.code(429).send({ code: 'rate_limited', message: error.message || 'too many requests' });
        }
        if ((error as { validation?: unknown }).validation) {
            return reply.code(400).send({ code: 'invalid_request', message: 'invalid request' });
        }
        const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
        if (status >= 500) {
            request.log.error(error);
            return reply.code(500).send({ code: 'internal_error', message: 'internal server error' });
        }
        return reply.code(status).send({ code: 'error', message: error.message || 'error' });
    });

    app.setNotFoundHandler((_request, reply) => {
        reply.code(404).send({ code: 'not_found', message: 'not found' });
    });
}

/** Single global version prefix for the JSON API — `/v1/...`. */
const V1 = '/v1';

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: { level: env.LOG_LEVEL, transport: prettyTransport() },
        routerOptions: { ignoreTrailingSlash: true },
        trustProxy: true,
        // ciphertext payloads can be large; keep the cap generous but bounded.
        bodyLimit: 8 * 1024 * 1024,
    });

    // Tolerate an empty body sent with `Content-Type: application/json` (kit clients
    // send this header on body-less DELETEs). Treat empty as "no body"; a non-empty
    // body still parses and still 400s on malformed JSON.
    app.addContentTypeParser(
        'application/json',
        { parseAs: 'string', bodyLimit: 8 * 1024 * 1024 },
        (_req, body, done) => {
            const text = typeof body === 'string' ? body.trim() : '';
            if (text.length === 0) {
                done(null, undefined);
                return;
            }
            try {
                done(null, JSON.parse(text));
            } catch (err) {
                (err as Error & { statusCode?: number }).statusCode = 400;
                done(err as Error, undefined);
            }
        },
    );

    registerErrorHandler(app);

    // Browser clients (the Quietletter app in self-host mode, or any web client) call
    // the owner API with PUT/DELETE + custom headers, so CORS must allow the full
    // method set explicitly — the default only covers the "simple" GET/HEAD/POST.
    await app.register(cors, {
        origin: true,
        credentials: false,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Id', 'X-App-Version'],
    });
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

    app.get('/health', async () => ({ status: 'ok' }));
    app.get(`${V1}/health`, async () => ({ status: 'ok' }));

    // Owner API (bearer-gated) and the public JSON release route share the `/v1`
    // prefix but are SEPARATE encapsulated plugins, so the owner auth hook applies
    // only to the owner routes.
    await app.register(ownerRoutes, { prefix: V1 });
    await app.register(publicApiRoutes, { prefix: V1 });
    // Public HTML surfaces at the root: the recipient release page and the
    // self-host-only public "leak" page.
    await app.register(publicPageRoutes);

    return app;
}
