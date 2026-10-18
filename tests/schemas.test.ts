import { describe, expect, it } from 'vitest';
import { MIN_GRACE_HOURS, dueWarnings, graceHours, shouldFire } from '../src/logic.js';
import { createSwitchSchema, parse, putPayloadSchema, regionalSchema } from '../src/schemas.js';
import { payloadAckDTO, switchDTO } from '../src/serializers.js';
import type { SwitchWithChildren } from '../src/service.js';
import { ValidationError } from '../src/shared/errors.js';

/**
 * Write validation (the same rules guard a regular save and an import) and the pure timing math
 * the sweep fires on. A switch can only be saved if it can warn the owner before it fires, and a
 * zero-knowledge item can never be stored as plaintext.
 */

const base = { title: 'For my family' };

function firstIssue(body: unknown): string | undefined {
    const r = createSwitchSchema.safeParse(body);
    return r.success ? undefined : `${r.error.issues[0]?.path.join('.')}: ${r.error.issues[0]?.message}`;
}

describe('parse', () => {
    it('returns the parsed value, defaults applied', () => {
        expect(parse(createSwitchSchema, base)).toMatchObject({ title: 'For my family', recipients: [], actions: [] });
    });

    it('throws a 400 ValidationError naming the field, or "body" for the whole body', () => {
        const err = (() => {
            try {
                parse(regionalSchema, { timezone: 'Nowhere/Land' });
            } catch (e) {
                return e;
            }
        })();
        expect(err).toBeInstanceOf(ValidationError);
        expect(err).toMatchObject({ statusCode: 400, code: 'invalid_request', message: 'timezone: invalid time zone' });
        expect(() => parse(regionalSchema, 'text')).toThrow(/^body: /);
    });
});

describe('createSwitchSchema', () => {
    it('requires warnings on both push and email before a switch may fire', () => {
        expect(firstIssue({ ...base, warnings: [{ offsetHours: 0, channels: ['email', 'sms'] }] })).toBe(
            'warnings: warnings must include at least push and email',
        );
        expect(
            firstIssue({
                ...base,
                warnings: [
                    { offsetHours: 0, channels: ['push'] },
                    { offsetHours: 24, channels: ['email'] },
                ],
            }),
        ).toBeUndefined();
        expect(firstIssue({ ...base, warnings: [] })).toMatch(/^warnings: /);
    });

    it('holds the 48h grace floor in hours and in days', () => {
        expect(firstIssue({ ...base, grace: { value: 48, unit: 'hour' } })).toBeUndefined();
        expect(firstIssue({ ...base, grace: { value: 2, unit: 'day' } })).toBeUndefined();
        expect(firstIssue({ ...base, grace: { value: 1, unit: 'day' } })).toBe(
            `grace: grace must be at least ${MIN_GRACE_HOURS} hours`,
        );
    });

    it('validates recipient addresses, phone numbers and the language code', () => {
        expect(firstIssue({ ...base, recipients: [{ email: 'no-at-sign' }] })).toBe(
            'recipients.0.email: invalid email',
        );
        expect(firstIssue({ ...base, recipients: [{ email: 'a@b.co', phone: 'call me' }] })).toBe(
            'recipients.0.phone: invalid phone',
        );
        expect(firstIssue({ ...base, warningPhone: '12' })).toBe('warningPhone: invalid phone');
        expect(firstIssue({ ...base, locale: 'english' })).toBe('locale: expected a language code');
        expect(firstIssue({ ...base, locale: 'pt-BR' })).toBeUndefined();
        const trimmed = createSwitchSchema.parse({ ...base, recipients: [{ email: '  heir@example.com ' }] });
        expect(trimmed.recipients[0]).toEqual({ email: 'heir@example.com', phone: null, name: null });
    });

    it('keeps zero-knowledge items zero-knowledge and public pages plaintext', () => {
        const action = (type: string, config: Record<string, unknown>) =>
            firstIssue({ ...base, actions: [{ type, config }] });
        expect(action('public_page', { mode: 'zk' })).toBe(
            'actions.0.config.mode: a public_page must use readable mode (public pages are plaintext)',
        );
        for (const type of ['file', 'secret', 'private_page']) {
            expect(action(type, { mode: 'readable' })).toBe(
                'actions.0.config.mode: readable mode is only allowed for a message or public_page action',
            );
        }
        expect(action('message', { mode: 'readable' })).toBeUndefined();
        expect(action('message', { mode: 'zk' })).toBeUndefined();
        expect(action('secret', { mode: 'zk', slug: 'leak' })).toBe(
            'actions.0.config.slug: slug is only valid for a public_page action',
        );
        expect(action('public_page', { mode: 'readable', slug: 'Not A Slug' })).toMatch(/^actions\.0\.config\.slug: /);
        expect(action('public_page', { mode: 'readable', slug: 'my-statement' })).toBeUndefined();
        expect(action('voice_note', { mode: 'zk' })).toMatch(/^actions\.0\.type: /);
    });
});

describe('putPayloadSchema', () => {
    it('defaults every absent field to null', () => {
        expect(putPayloadSchema.parse({ mode: 'readable', readableContent: 'Hi' })).toEqual({
            mode: 'readable',
            ciphertext: null,
            wrappedKey: null,
            salt: null,
            nonce: null,
            algo: null,
            blobRef: null,
            size: null,
            readableContent: 'Hi',
        });
    });

    it('reports every missing part of a zk envelope at once', () => {
        const r = putPayloadSchema.safeParse({ mode: 'zk' });
        expect(r.success).toBe(false);
        expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['ciphertext', 'wrappedKey', 'salt', 'nonce']);
    });
});

describe('timing', () => {
    const deadline = new Date('2026-10-08T00:00:00.000Z');
    const h = (n: number) => new Date(deadline.getTime() + n * 3_600_000);

    it('fires exactly when the grace window (never under 48h) has elapsed', () => {
        const grace = { value: 3, unit: 'day' as const };
        expect(shouldFire(deadline, grace, h(71))).toBe(false);
        expect(shouldFire(deadline, grace, h(72))).toBe(true);
        expect(shouldFire(deadline, { value: 1, unit: 'hour' }, h(47))).toBe(false);
        expect(shouldFire(deadline, { value: 1, unit: 'hour' }, h(48))).toBe(true);
        expect(graceHours({ value: 1, unit: 'hour' })).toBe(1);
    });

    it('lists only the warnings that are due and still before the fire time', () => {
        const steps = [
            { offsetHours: 0, channels: ['push' as const] },
            { offsetHours: 24, channels: ['email' as const] },
            { offsetHours: 72, channels: ['email' as const] },
        ];
        const due = dueWarnings(deadline, steps, h(72), h(100));
        expect(due.map((d) => d.index)).toEqual([0, 1]);
        expect(due[1]).toMatchObject({ fireAt: h(24), stepKey: `${deadline.toISOString()}:1` });
        expect(dueWarnings(deadline, steps, h(72), h(-1))).toEqual([]);
    });
});

describe('serializers', () => {
    const T = new Date('2026-10-01T00:00:00.000Z');
    const row = {
        id: 's',
        title: 't',
        state: 'active',
        cadence: { value: 7, unit: 'day' },
        grace: { value: 3, unit: 'day' },
        warnings: [],
        warningPhone: null,
        timezone: null,
        locale: null,
        lastCheckinAt: T,
        nextDeadline: T,
        armedAt: null,
        firedAt: null,
        disarmedAt: null,
        createdAt: null,
        updatedAt: undefined,
        recipients: [],
        actions: [],
    } as unknown as SwitchWithChildren;

    it('never sends a null creation time to the client (epoch instead)', () => {
        expect(switchDTO(row)).toMatchObject({
            createdAt: '1970-01-01T00:00:00.000Z',
            updatedAt: '1970-01-01T00:00:00.000Z',
            armedAt: null,
            lastCheckinAt: T.toISOString(),
        });
    });

    it('acknowledges a payload by flags only', () => {
        const ack = payloadAckDTO({
            actionId: 'a',
            mode: 'zk',
            ciphertext: 'secret-bytes',
            blobRef: null,
            readableContent: null,
            size: undefined,
            updatedAt: T,
        } as never);
        expect(ack).toEqual({
            actionId: 'a',
            mode: 'zk',
            hasCiphertext: true,
            hasBlob: false,
            hasReadable: false,
            size: null,
            updatedAt: T.toISOString(),
        });
    });
});
