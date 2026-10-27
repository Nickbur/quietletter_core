import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { env } from '../env.js';

/**
 * The real server (`buildApp()`), ready for `app.inject()`. Use it from a test file that mocks the
 * database with the helper next to this one — nothing here opens a socket.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
    const app = await buildApp();
    await app.ready();
    return app;
}

/** `Authorization` header carrying the owner token, for the bearer-gated `/v1/switches*` routes. */
export function ownerHeaders(): { authorization: string } {
    return { authorization: `Bearer ${env.OWNER_TOKEN}` };
}
