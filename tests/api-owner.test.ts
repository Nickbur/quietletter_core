import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/client.js', () => import('./helpers/db.js').then((m) => m.pgliteClient()));

import { db } from '../src/db/client.js';
import { switchActions, switchPayloads, switchRecipients, switches } from '../src/db/schema.js';
import { uuidv7 } from '../src/shared/id.js';
import { buildTestApp, ownerHeaders } from './helpers/app.js';
import { resetDb } from './helpers/db.js';
import { T0, ZK_FIELDS, at, seedSwitch, switchBody, switchRow } from './helpers/switches.js';

/**
 * The owner API (`/v1/switches*`) end to end through the real server: the bearer gate, the wire
 * shape the Quietletter client reads, the timer rules a write must respect (create starts the
 * timer, check-in resets it, a fired switch is final), payload uploads that never echo
 * ciphertext, and export / import between instances.
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

afterEach(() => {
    vi.useRealTimers();
});

const NOW = new Date('2026-10-17T09:30:00.000Z');

function freezeClock(now: Date = NOW): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
}

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';

function call(method: Method, url: string, payload?: unknown) {
    return app.inject({
        method,
        url,
        headers: ownerHeaders(),
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
}

async function createSwitch(over: Record<string, unknown> = {}, id: string = uuidv7()) {
    const res = await call('PUT', `/v1/switches/${id}`, switchBody(over));
    expect(res.statusCode).toBe(201);
    return { id, body: res.json<Record<string, unknown>>() };
}

describe('owner gate', () => {
    /** One static bearer token guards every switch — anyone else could disarm a dead man's switch. */
    it('refuses a request without a bearer token with 401 unauthenticated', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/switches' });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ code: 'unauthenticated', message: 'missing bearer token' });
    });

    it('refuses another auth scheme and a wrong token', async () => {
        const basic = await app.inject({
            method: 'GET',
            url: '/v1/switches',
            headers: { authorization: 'Basic b3duZXI6cGFzcw==' },
        });
        expect(basic.json()).toMatchObject({ code: 'unauthenticated', message: 'missing bearer token' });

        const wrong = await app.inject({
            method: 'GET',
            url: '/v1/switches',
            headers: { authorization: 'Bearer test-owner-token-0123456780' },
        });
        expect(wrong.statusCode).toBe(401);
        expect(wrong.json()).toEqual({ code: 'unauthenticated', message: 'invalid owner token' });
    });

    it('gates every owner route, writes included, before touching the switch', async () => {
        const { id } = await createSwitch();
        const routes: Array<[Method, string]> = [
            ['GET', `/v1/switches/${id}`],
            ['PUT', `/v1/switches/${id}`],
            ['DELETE', `/v1/switches/${id}`],
            ['POST', `/v1/switches/${id}/checkin`],
            ['POST', `/v1/switches/${id}/disarm`],
            ['PUT', `/v1/switches/${id}/regional`],
            ['PUT', `/v1/switches/${id}/actions/${uuidv7()}/payload`],
            ['GET', '/v1/switches/export'],
            ['POST', '/v1/switches/import'],
        ];
        for (const [method, url] of routes) {
            const res = await app.inject({ method, url });
            expect(res.statusCode, `${method} ${url}`).toBe(401);
        }
        expect((await switchRow(id)).state).toBe('active');
    });
});

describe('PUT /v1/switches/:id', () => {
    /** Upsert by client id: create starts the timer, an edit replaces the recipient + action sets. */
    it('creates a switch with 201 and starts its timer now, on the switch calendar', async () => {
        freezeClock();
        const id = uuidv7();
        const res = await call(
            'PUT',
            `/v1/switches/${id}`,
            switchBody({
                cadence: { value: 1, unit: 'month' },
                actions: [
                    { type: 'message', config: { mode: 'readable', subject: 'Hello' } },
                    { type: 'public_page', sortOrder: 2, config: { mode: 'readable', slug: 'my-statement' } },
                    { type: 'secret', sortOrder: 1, config: { mode: 'zk' } },
                ],
            }),
        );
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body).toMatchObject({
            id,
            title: 'For my family',
            state: 'active',
            cadence: { value: 1, unit: 'month' },
            grace: { value: 3, unit: 'day' },
            warningPhone: '+380 44 123 4567',
            timezone: 'Europe/Kyiv',
            locale: 'en',
            lastCheckinAt: NOW.toISOString(),
            // 12:30 Kyiv summer time (UTC+3) a month on = 12:30 winter time (UTC+2).
            nextDeadline: '2026-11-17T10:30:00.000Z',
            armedAt: NOW.toISOString(),
            firedAt: null,
            disarmedAt: null,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            recipients: [{ email: 'heir@example.com', name: 'Heir', phone: null }],
        });
        expect(body.actions.map((a: { type: string; sortOrder: number }) => [a.type, a.sortOrder])).toEqual([
            ['message', 0],
            ['secret', 1],
            ['public_page', 2],
        ]);
        expect(body.actions[0]).toMatchObject({
            config: { mode: 'readable', subject: 'Hello' },
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
        });
    });

    it('applies the defaults (30-day cadence, 14-day grace, three warning steps) when the body omits them', async () => {
        freezeClock();
        const { body } = await createSwitch({
            cadence: undefined,
            grace: undefined,
            warnings: undefined,
            timezone: undefined,
            locale: undefined,
            warningPhone: undefined,
            recipients: undefined,
            actions: undefined,
        });
        expect(body).toMatchObject({
            cadence: { value: 30, unit: 'day' },
            grace: { value: 14, unit: 'day' },
            warningPhone: null,
            timezone: null,
            locale: null,
            nextDeadline: '2026-11-16T09:30:00.000Z',
            recipients: [],
            actions: [],
        });
        expect(body.warnings).toHaveLength(3);
    });

    it('answers 200 on an edit, replacing recipients and actions and cascading a removed payload', async () => {
        const id = uuidv7();
        const RC_KEEP = uuidv7();
        const AC_KEEP = uuidv7();
        const AC_DROP = uuidv7();
        await createSwitch(
            {
                recipients: [{ id: RC_KEEP, email: 'keep@example.com', name: 'Keep' }, { email: 'drop@example.com' }],
                actions: [
                    { id: AC_KEEP, type: 'message', config: { mode: 'readable' } },
                    { id: AC_DROP, type: 'secret', sortOrder: 1, config: { mode: 'zk' } },
                ],
            },
            id,
        );
        const upload = await call('PUT', `/v1/switches/${id}/actions/${AC_DROP}/payload`, { mode: 'zk', ...ZK_FIELDS });
        expect(upload.statusCode).toBe(200);

        const res = await call(
            'PUT',
            `/v1/switches/${id}`,
            switchBody({
                title: 'Edited',
                recipients: [
                    { id: RC_KEEP, email: 'kept@example.com', phone: '+1 555 0100', name: null },
                    { email: 'new@example.com' },
                ],
                actions: [{ id: AC_KEEP, type: 'message', sortOrder: 3, config: { mode: 'readable', subject: 'S' } }],
            }),
        );
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.title).toBe('Edited');
        expect(body.recipients).toHaveLength(2);
        expect(body.recipients).toContainEqual({
            id: RC_KEEP,
            email: 'kept@example.com',
            phone: '+1 555 0100',
            name: null,
        });
        expect(body.recipients.map((r: { email: string }) => r.email)).not.toContain('drop@example.com');
        expect(body.actions).toEqual([
            expect.objectContaining({ id: AC_KEEP, sortOrder: 3, config: { mode: 'readable', subject: 'S' } }),
        ]);
        expect(await db.select().from(switchActions).where(eq(switchActions.id, AC_DROP))).toHaveLength(0);
        expect(await db.select().from(switchPayloads)).toHaveLength(0);
    });

    it('keeps the stored zone and language when an older client omits them', async () => {
        const { id } = await createSwitch({ timezone: 'Europe/Kyiv', locale: 'ru' });
        const res = await call('PUT', `/v1/switches/${id}`, switchBody({ timezone: null, locale: undefined }));
        expect(res.json()).toMatchObject({ timezone: 'Europe/Kyiv', locale: 'ru' });
    });

    it('refuses a non-UUID id with 400 invalid_id', async () => {
        const res = await call('PUT', '/v1/switches/not-a-uuid', switchBody());
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ code: 'invalid_id', message: 'switch id must be a UUID' });
    });

    it('refuses an invalid body with 400 invalid_request naming the first bad field', async () => {
        const noTitle = await call('PUT', `/v1/switches/${uuidv7()}`, switchBody({ title: '   ' }));
        expect(noTitle.statusCode).toBe(400);
        expect(noTitle.json().code).toBe('invalid_request');
        expect(noTitle.json().message).toMatch(/^title: /);

        const shortGrace = await call(
            'PUT',
            `/v1/switches/${uuidv7()}`,
            switchBody({ grace: { value: 47, unit: 'hour' } }),
        );
        expect(shortGrace.json()).toEqual({
            code: 'invalid_request',
            message: 'grace: grace must be at least 48 hours',
        });

        const noBody = await app.inject({
            method: 'PUT',
            url: `/v1/switches/${uuidv7()}`,
            headers: { ...ownerHeaders(), 'content-type': 'application/json' },
        });
        expect(noBody.statusCode).toBe(400);
        expect(noBody.json().message).toMatch(/^body: /);
        expect(await db.select().from(switches)).toHaveLength(0);
    });

    it('refuses to edit a fired switch with 409 already_fired', async () => {
        const { id } = await seedSwitch({ state: 'fired', firedAt: at(72) });
        const res = await call('PUT', `/v1/switches/${id}`, switchBody({ title: 'Edited' }));
        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({ code: 'already_fired', message: 'a fired switch cannot be edited' });
        expect((await switchRow(id)).title).toBe('For my family');
    });
});

describe('GET /v1/switches and /v1/switches/:id', () => {
    /** The owner's client lists and opens switches in the cloud's DTO shape. */
    it('lists every switch oldest first, with its recipients and actions', async () => {
        expect((await call('GET', '/v1/switches')).json()).toEqual([]);
        freezeClock(new Date('2026-10-01T00:00:00.000Z'));
        const first = await createSwitch({ title: 'First' });
        vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
        const second = await createSwitch({
            title: 'Second',
            actions: [{ type: 'file', config: { mode: 'zk', filename: 'will.pdf', mimeType: 'application/pdf' } }],
        });
        const list = (await call('GET', '/v1/switches')).json();
        expect(list.map((s: { id: string }) => s.id)).toEqual([first.id, second.id]);
        expect(list[0].actions).toEqual([]);
        expect(list[1].actions[0].config).toEqual({ mode: 'zk', filename: 'will.pdf', mimeType: 'application/pdf' });
        expect(list[1].recipients).toHaveLength(1);
    });

    it('returns one switch, 404 switch_not_found for an unknown id, 400 invalid_id for a malformed one', async () => {
        const { id, body } = await createSwitch();
        const one = await call('GET', `/v1/switches/${id}`);
        expect(one.statusCode).toBe(200);
        expect(one.json()).toEqual(body);

        const missing = await call('GET', `/v1/switches/${uuidv7()}`);
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ code: 'switch_not_found', message: 'switch not found' });

        expect((await call('GET', '/v1/switches/123')).json()).toMatchObject({ code: 'invalid_id' });
    });
});

describe('POST /v1/switches/:id/checkin and /disarm', () => {
    /** Check-in is proof of life (resets the timer, re-arms); disarm stops the switch; firing is final. */
    it('checks in: the deadline restarts from now and a running grace window ends', async () => {
        const { id } = await seedSwitch({ state: 'grace', timezone: 'Europe/Kyiv' });
        freezeClock(at(10));
        const res = await call('POST', `/v1/switches/${id}/checkin`);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
            state: 'active',
            lastCheckinAt: at(10).toISOString(),
            nextDeadline: new Date(at(10).getTime() + 7 * 24 * 3_600_000).toISOString(),
            armedAt: T0.toISOString(),
            disarmedAt: null,
        });
    });

    it('disarms, and a later check-in re-arms the switch', async () => {
        const { id } = await seedSwitch();
        freezeClock(at(-24));
        const disarmed = await call('POST', `/v1/switches/${id}/disarm`);
        expect(disarmed.statusCode).toBe(200);
        expect(disarmed.json()).toMatchObject({ state: 'disarmed', disarmedAt: at(-24).toISOString() });

        const rearmed = await call('POST', `/v1/switches/${id}/checkin`);
        expect(rearmed.json()).toMatchObject({ state: 'active', disarmedAt: null });
    });

    it('answers 404 switch_not_found for an unknown switch and 409 already_fired for a fired one', async () => {
        for (const verb of ['checkin', 'disarm']) {
            const missing = await call('POST', `/v1/switches/${uuidv7()}/${verb}`);
            expect(missing.statusCode).toBe(404);
            expect(missing.json().code).toBe('switch_not_found');
        }
        const { id } = await seedSwitch({ state: 'fired', firedAt: at(72) });
        const checkin = await call('POST', `/v1/switches/${id}/checkin`);
        expect(checkin.statusCode).toBe(409);
        expect(checkin.json()).toEqual({ code: 'already_fired', message: 'a fired switch cannot be checked in' });
        const disarm = await call('POST', `/v1/switches/${id}/disarm`);
        expect(disarm.json()).toEqual({ code: 'already_fired', message: 'a fired switch cannot be disarmed' });
        expect((await switchRow(id)).state).toBe('fired');
    });

    it('refuses a malformed id with 400 invalid_id', async () => {
        expect((await call('POST', '/v1/switches/xyz/checkin')).statusCode).toBe(400);
        expect((await call('POST', '/v1/switches/xyz/disarm')).statusCode).toBe(400);
    });
});

describe('PUT /v1/switches/:id/regional', () => {
    /** A legacy switch gets its zone and language filled in once; nothing else moves. */
    it('fills a missing zone and language without moving the deadline', async () => {
        const { id } = await seedSwitch({ timezone: null, locale: null });
        const res = await call('PUT', `/v1/switches/${id}/regional`, { timezone: 'Europe/Kyiv', locale: 'ru' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
            timezone: 'Europe/Kyiv',
            locale: 'ru',
            nextDeadline: '2026-10-08T00:00:00.000Z',
        });
    });

    it('fills the zone alone when no language is sent, and never overwrites what is set', async () => {
        const { id } = await seedSwitch({ timezone: null, locale: null });
        const res = await call('PUT', `/v1/switches/${id}/regional`, { timezone: 'Europe/Kyiv' });
        expect(res.json()).toMatchObject({ timezone: 'Europe/Kyiv', locale: null });
        const again = await call('PUT', `/v1/switches/${id}/regional`, { timezone: 'America/New_York', locale: 'en' });
        expect(again.json()).toMatchObject({ timezone: 'Europe/Kyiv', locale: 'en' });
    });

    it('refuses an invalid zone with 400, an unknown switch with 404', async () => {
        const { id } = await seedSwitch();
        const bad = await call('PUT', `/v1/switches/${id}/regional`, { timezone: '+03:00' });
        expect(bad.statusCode).toBe(400);
        expect(bad.json()).toEqual({ code: 'invalid_request', message: 'timezone: invalid time zone' });
        const missing = await call('PUT', `/v1/switches/${uuidv7()}/regional`, { timezone: 'Europe/Kyiv' });
        expect(missing.statusCode).toBe(404);
        expect(missing.json().code).toBe('switch_not_found');
    });
});

describe('DELETE /v1/switches/:id', () => {
    /** Delete is idempotent and takes every child row with it. */
    it('deletes a switch and its children with 204, and a repeat is still 204', async () => {
        const { id } = await seedSwitch({ actions: [{ type: 'secret', payload: 'zk' }] });
        const res = await call('DELETE', `/v1/switches/${id}`);
        expect(res.statusCode).toBe(204);
        expect(res.body).toBe('');
        expect(await db.select().from(switchRecipients)).toHaveLength(0);
        expect(await db.select().from(switchPayloads)).toHaveLength(0);
        expect((await call('GET', `/v1/switches/${id}`)).statusCode).toBe(404);
        expect((await call('DELETE', `/v1/switches/${id}`)).statusCode).toBe(204);
    });

    it('accepts the empty JSON body kit clients send on a DELETE', async () => {
        const { id } = await seedSwitch();
        const res = await app.inject({
            method: 'DELETE',
            url: `/v1/switches/${id}`,
            headers: { ...ownerHeaders(), 'content-type': 'application/json' },
            payload: '  ',
        });
        expect(res.statusCode).toBe(204);
        expect(await db.select().from(switches)).toHaveLength(0);
    });

    it('refuses a malformed id with 400 invalid_id', async () => {
        expect((await call('DELETE', '/v1/switches/nope')).json()).toMatchObject({ code: 'invalid_id' });
    });
});

describe('PUT /v1/switches/:id/actions/:actionId/payload', () => {
    /** The server stores the payload blind and acknowledges it without ever echoing the ciphertext. */
    it('stores a zero-knowledge payload and acknowledges it without echoing it', async () => {
        const { id, actionIds } = await seedSwitch({ actions: [{ type: 'secret' }] });
        const res = await call('PUT', `/v1/switches/${id}/actions/${actionIds[0]}/payload`, {
            mode: 'zk',
            ...ZK_FIELDS,
            size: 42,
        });
        expect(res.statusCode).toBe(200);
        const ack = res.json();
        expect(ack).toMatchObject({
            actionId: actionIds[0],
            mode: 'zk',
            hasCiphertext: true,
            hasBlob: false,
            hasReadable: false,
            size: 42,
        });
        expect(typeof ack.updatedAt).toBe('string');
        expect(res.body).not.toContain(ZK_FIELDS.ciphertext);
        const [stored] = await db.select().from(switchPayloads);
        expect(stored).toMatchObject({ mode: 'zk', ...ZK_FIELDS, size: 42, readableContent: null });
    });

    it('replaces an existing payload in place', async () => {
        const { id, actionIds } = await seedSwitch({ actions: [{ type: 'message', payload: 'readable' }] });
        const res = await call('PUT', `/v1/switches/${id}/actions/${actionIds[0]}/payload`, {
            mode: 'readable',
            readableContent: 'Updated words.',
        });
        expect(res.json()).toMatchObject({ mode: 'readable', hasReadable: true, hasCiphertext: false, size: null });
        const rows = await db.select().from(switchPayloads);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.readableContent).toBe('Updated words.');
    });

    it('accepts an externalized zk blob reference in place of inline ciphertext', async () => {
        const { id, actionIds } = await seedSwitch({ actions: [{ type: 'file' }] });
        const res = await call('PUT', `/v1/switches/${id}/actions/${actionIds[0]}/payload`, {
            mode: 'zk',
            blobRef: 'upload/123',
            wrappedKey: ZK_FIELDS.wrappedKey,
            salt: ZK_FIELDS.salt,
            nonce: ZK_FIELDS.nonce,
        });
        expect(res.json()).toMatchObject({ hasBlob: true, hasCiphertext: false });
    });

    it('refuses an incomplete payload with 400 invalid_request', async () => {
        const { id, actionIds } = await seedSwitch({ actions: [{ type: 'secret' }] });
        const url = `/v1/switches/${id}/actions/${actionIds[0]}/payload`;
        const cases: Array<[Record<string, unknown>, string]> = [
            [
                { mode: 'zk', wrappedKey: 'k', salt: 's', nonce: 'n' },
                'ciphertext: zk payload needs ciphertext or blobRef',
            ],
            [{ mode: 'zk', ciphertext: 'c', salt: 's', nonce: 'n' }, 'wrappedKey: zk payload needs wrappedKey'],
            [{ mode: 'zk', ciphertext: 'c', wrappedKey: 'k', nonce: 'n' }, 'salt: zk payload needs salt'],
            [{ mode: 'zk', ciphertext: 'c', wrappedKey: 'k', salt: 's' }, 'nonce: zk payload needs nonce'],
            [{ mode: 'readable' }, 'readableContent: readable payload needs readableContent'],
            [{ mode: 'plain', readableContent: 'x' }, 'mode: '],
        ];
        for (const [payload, message] of cases) {
            const res = await call('PUT', url, payload);
            expect(res.statusCode).toBe(400);
            expect(res.json().code).toBe('invalid_request');
            expect(res.json().message).toContain(message);
        }
        expect(await db.select().from(switchPayloads)).toHaveLength(0);
    });

    it('refuses malformed ids with 400 invalid_id, naming which one', async () => {
        const { id, actionIds } = await seedSwitch({ actions: [{ type: 'secret' }] });
        const body = { mode: 'zk', ...ZK_FIELDS };
        expect((await call('PUT', `/v1/switches/x/actions/${actionIds[0]}/payload`, body)).json()).toEqual({
            code: 'invalid_id',
            message: 'switch id must be a UUID',
        });
        expect((await call('PUT', `/v1/switches/${id}/actions/x/payload`, body)).json()).toEqual({
            code: 'invalid_id',
            message: 'action id must be a UUID',
        });
    });

    it('answers 404 for an unknown switch, and for an action that belongs to another switch', async () => {
        const mine = await seedSwitch({ actions: [{ type: 'secret' }] });
        const other = await seedSwitch({ actions: [{ type: 'secret' }] });
        const body = { mode: 'zk', ...ZK_FIELDS };
        const noSwitch = await call('PUT', `/v1/switches/${uuidv7()}/actions/${mine.actionIds[0]}/payload`, body);
        expect(noSwitch.statusCode).toBe(404);
        expect(noSwitch.json().code).toBe('switch_not_found');
        const foreign = await call('PUT', `/v1/switches/${mine.id}/actions/${other.actionIds[0]}/payload`, body);
        expect(foreign.statusCode).toBe(404);
        expect(foreign.json()).toEqual({ code: 'action_not_found', message: 'action_not_found' });
    });

    it('caps the ciphertext at 2,000,000 chars and the request body at 3 MB', async () => {
        const { id, actionIds } = await seedSwitch({ actions: [{ type: 'secret' }] });
        const url = `/v1/switches/${id}/actions/${actionIds[0]}/payload`;
        const over = await call('PUT', url, { mode: 'zk', ...ZK_FIELDS, ciphertext: 'a'.repeat(2_000_001) });
        expect(over.statusCode).toBe(400);
        expect(over.json().message).toMatch(/^ciphertext: /);

        const huge = await call('PUT', url, { mode: 'zk', ...ZK_FIELDS, ciphertext: 'a'.repeat(3 * 1024 * 1024) });
        expect(huge.statusCode).toBe(413);
        expect(huge.json().code).toBe('error');
    });
});

describe('GET /v1/switches/export', () => {
    /** One portable file with every live switch, payloads verbatim (ZK stays ciphertext). */
    it('downloads every live switch as an attachment, fired ones left out', async () => {
        freezeClock();
        const live = await seedSwitch({
            timezone: 'Europe/Kyiv',
            actions: [{ type: 'secret', payload: 'zk' }, { type: 'message' }],
        });
        await seedSwitch({ title: 'Already fired', state: 'fired', firedAt: at(72) });
        const res = await call('GET', '/v1/switches/export');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-disposition']).toBe('attachment; filename="quietletter-export-2026-10-17.json"');
        const file = res.json();
        expect(file).toMatchObject({
            format: 'quietletter-export',
            schemaVersion: 1,
            exportedAt: NOW.toISOString(),
            source: 'self-host',
        });
        expect(file.switches).toHaveLength(1);
        expect(file.switches[0]).toMatchObject({
            id: live.id,
            timezone: 'Europe/Kyiv',
            lastCheckinAt: T0.toISOString(),
            createdAt: T0.toISOString(),
        });
        expect(file.switches[0].actions[0].payload).toEqual({
            mode: 'zk',
            ...ZK_FIELDS,
            blobRef: null,
            size: 10,
            readableContent: null,
            schemaVersion: 1,
        });
        expect(file.switches[0].actions[1].payload).toBeNull();
    });

    it('exports an empty file when there is nothing live', async () => {
        await seedSwitch({ state: 'fired', firedAt: at(72) });
        expect((await call('GET', '/v1/switches/export')).json().switches).toEqual([]);
    });
});

describe('POST /v1/switches/import', () => {
    /** An import recreates the switches of an export file, restarts their timers and never duplicates. */
    async function exportFile() {
        return (await call('GET', '/v1/switches/export')).json<Record<string, unknown>>();
    }

    it('round-trips an export into a fresh instance with a fresh timer, and skips it the second time', async () => {
        const live = await seedSwitch({
            timezone: 'Europe/Kyiv',
            locale: 'ru',
            actions: [
                { type: 'secret', payload: 'zk' },
                { type: 'public_page', payload: 'readable', slug: 'my-statement' },
            ],
        });
        const disarmed = await seedSwitch({ title: 'Paused', state: 'disarmed' });
        const file = await exportFile();
        await resetDb(db);

        freezeClock();
        const res = await call('POST', '/v1/switches/import', file);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
            imported: 2,
            skipped: 0,
            results: [
                { id: live.id, title: 'For my family', status: 'imported' },
                { id: disarmed.id, title: 'Paused', status: 'imported' },
            ],
        });
        const restored = await switchRow(live.id);
        expect(restored).toMatchObject({ state: 'active', timezone: 'Europe/Kyiv', locale: 'ru', armedAt: NOW });
        expect(restored.lastCheckinAt).toEqual(NOW);
        expect(restored.nextDeadline).toEqual(new Date('2026-10-24T09:30:00.000Z'));
        expect(restored.createdAt).toEqual(T0);
        expect(await switchRow(disarmed.id)).toMatchObject({ state: 'disarmed', armedAt: null, disarmedAt: NOW });
        const payloads = await db.select().from(switchPayloads).where(eq(switchPayloads.switchId, live.id));
        expect(payloads.map((p) => p.mode).sort()).toEqual(['readable', 'zk']);
        expect(payloads.find((p) => p.mode === 'zk')).toMatchObject(ZK_FIELDS);

        const again = await call('POST', '/v1/switches/import', file);
        expect(again.json()).toMatchObject({
            imported: 0,
            skipped: 2,
            results: [
                { status: 'skipped', reason: 'exists' },
                { status: 'skipped', reason: 'exists' },
            ],
        });
    });

    it('reports a switch whose recipient id is already used by another switch as a conflict', async () => {
        const original = await seedSwitch();
        const file = await exportFile();
        await db.delete(switches).where(eq(switches.id, original.id));
        const holder = await seedSwitch({ title: 'Holder' });
        await db
            .update(switchRecipients)
            .set({ id: original.recipientIds[0] })
            .where(eq(switchRecipients.switchId, holder.id));

        const res = await call('POST', '/v1/switches/import', file);
        expect(res.json()).toMatchObject({
            imported: 0,
            skipped: 1,
            results: [{ id: original.id, status: 'skipped', reason: 'conflict' }],
        });
        expect(await db.select().from(switches)).toHaveLength(1);
    });

    it('imports the valid switches of a file and reports the invalid ones', async () => {
        const { id } = await seedSwitch();
        const file = await exportFile();
        await resetDb(db);
        const res = await call('POST', '/v1/switches/import', {
            ...file,
            switches: [{ id: 'nope', title: 'Broken' }, ...(file.switches as unknown[])],
        });
        expect(res.json()).toMatchObject({
            imported: 1,
            skipped: 1,
            results: [
                { id: 'nope', title: 'Broken', status: 'skipped', reason: 'invalid' },
                { id, status: 'imported' },
            ],
        });
    });

    it('refuses something that is not an export file, a newer version, and an empty body with 400', async () => {
        const notAFile = await call('POST', '/v1/switches/import', { hello: 'world' });
        expect(notAFile.statusCode).toBe(400);
        expect(notAFile.json()).toEqual({ code: 'invalid_export_file', message: 'not a Quietletter export file' });

        const newer = await call('POST', '/v1/switches/import', {
            format: 'quietletter-export',
            schemaVersion: 9,
            switches: [],
        });
        expect(newer.statusCode).toBe(400);
        expect(newer.json().code).toBe('unsupported_export_version');

        const empty = await app.inject({
            method: 'POST',
            url: '/v1/switches/import',
            headers: { ...ownerHeaders(), 'content-type': 'application/json' },
        });
        expect(empty.statusCode).toBe(400);
        expect(empty.json().code).toBe('invalid_export_file');
    });

    it('imports an empty file as a no-op', async () => {
        const res = await call('POST', '/v1/switches/import', {
            format: 'quietletter-export',
            schemaVersion: 1,
            switches: [],
        });
        expect(res.json()).toEqual({ imported: 0, skipped: 0, results: [] });
    });
});
