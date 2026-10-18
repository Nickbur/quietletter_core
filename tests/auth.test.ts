import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { requireOwner } from '../src/auth.js';
import { AuthError } from '../src/shared/errors.js';

/**
 * The owner gate is the only thing between the internet and disarming or rewriting a dead man's
 * switch: exactly `Authorization: Bearer <OWNER_TOKEN>` passes, and every near miss is a 401
 * `unauthenticated` (compared in constant time, so a wrong length or a wrong byte look the same).
 */

const TOKEN = 'test-owner-token-0123456789'; // pinned in vitest.config.ts

function request(authorization?: string): FastifyRequest {
    return { headers: authorization === undefined ? {} : { authorization } } as FastifyRequest;
}

async function refusal(authorization?: string): Promise<{ status: number; code: string; message: string } | null> {
    try {
        await requireOwner(request(authorization));
        return null;
    } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        return { status: err.statusCode, code: err.code, message: err.message };
    }
}

describe('requireOwner', () => {
    it('lets the owner token through', async () => {
        expect(await refusal(`Bearer ${TOKEN}`)).toBeNull();
        expect(await refusal(`Bearer   ${TOKEN}  `)).toBeNull(); // surrounding spaces are trimmed
    });

    it('refuses a missing header or another scheme as a missing bearer token', async () => {
        const missing = { status: 401, code: 'unauthenticated', message: 'missing bearer token' };
        expect(await refusal()).toEqual(missing);
        expect(await refusal('')).toEqual(missing);
        expect(await refusal(`Basic ${TOKEN}`)).toEqual(missing);
        expect(await refusal(`bearer ${TOKEN}`)).toEqual(missing);
        expect(await refusal(TOKEN)).toEqual(missing);
    });

    it('refuses an empty, garbled, wrong-length or wrong token as invalid', async () => {
        const invalid = { status: 401, code: 'unauthenticated', message: 'invalid owner token' };
        expect(await refusal('Bearer ')).toEqual(invalid);
        expect(await refusal('Bearer    ')).toEqual(invalid);
        expect(await refusal(`Bearer ${TOKEN.slice(0, -1)}`)).toEqual(invalid); // one char short
        expect(await refusal(`Bearer ${TOKEN}0`)).toEqual(invalid); // one char long
        expect(await refusal(`Bearer ${TOKEN.slice(0, -1)}8`)).toEqual(invalid); // same length, last byte differs
        expect(await refusal(`Bearer ${TOKEN.toUpperCase()}`)).toEqual(invalid);
        expect(await refusal('Bearer tést-owner-token-012345678')).toEqual(invalid); // multi-byte, byte length differs
    });
});
