import { describe, expect, it } from 'vitest';
import { ApiError, AuthError, ConflictError, NotFoundError, ValidationError } from './errors.js';
import { escapeHtml, renderNotFoundPage, renderPublicPage, renderReleasePage } from './html.js';
import { uuidv7 } from './id.js';
import { isUniqueViolation, pgErrorCode } from './pgErrors.js';
import { formatZonedTime, isRussian, isValidTimeZone } from './timezone.js';

/** The small shared helpers every route leans on: errors, ids, SQLSTATE reading, zones, HTML escaping. */

describe('errors', () => {
    /** Every error serializes to the flat { code, message } wire contract the client switches on. */
    it('gives each error class its status and a message that defaults to the code', () => {
        const cases: Array<[ApiError, number, string, string]> = [
            [new ValidationError('invalid_id'), 400, 'invalid_id', 'invalid_id'],
            [new AuthError(), 401, 'unauthenticated', 'unauthenticated'],
            [new NotFoundError(), 404, 'not_found', 'not_found'],
            [new NotFoundError('switch_not_found', 'switch not found'), 404, 'switch_not_found', 'switch not found'],
            [new ConflictError('already_fired', 'final'), 409, 'already_fired', 'final'],
            [new ApiError(418, 'teapot'), 418, 'teapot', 'teapot'],
        ];
        for (const [err, status, code, message] of cases) {
            expect(err).toBeInstanceOf(ApiError);
            expect(err).toBeInstanceOf(Error);
            expect(err.statusCode).toBe(status);
            expect(err.body).toEqual({ code, message });
        }
        expect(new ConflictError('x').name).toBe('ConflictError');
    });
});

describe('uuidv7', () => {
    /** Time-ordered ids keep primary-key inserts at the index tail; they must still be valid UUIDs. */
    it('mints RFC 9562 version-7 UUIDs carrying the current millisecond', () => {
        const before = Date.now();
        const id = uuidv7();
        const after = Date.now();
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
        expect(ms).toBeGreaterThanOrEqual(before);
        expect(ms).toBeLessThanOrEqual(after);
    });

    it('never repeats and sorts by creation time', () => {
        const ids = Array.from({ length: 500 }, () => uuidv7());
        expect(new Set(ids).size).toBe(ids.length);
        const stamps = ids.map((id) => id.slice(0, 13));
        expect([...stamps].sort()).toEqual(stamps);
    });
});

describe('pgErrors', () => {
    /** A concurrent import must be told apart from any other failure, whether or not drizzle wrapped the error. */
    it('reads the SQLSTATE from the driver error or from the drizzle wrapper around it', () => {
        expect(pgErrorCode({ code: '23505' })).toBe('23505');
        expect(pgErrorCode({ message: 'Failed query', cause: { code: '23503' } })).toBe('23503');
        expect(pgErrorCode({ code: 42, cause: { code: '23505' } })).toBe('23505');
        expect(pgErrorCode(new Error('plain'))).toBeUndefined();
        expect(pgErrorCode({ cause: { code: 1 } })).toBeUndefined();
        expect(pgErrorCode(null)).toBeUndefined();
        expect(pgErrorCode(undefined)).toBeUndefined();
    });

    it('recognizes only 23505 as a unique violation', () => {
        expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
        expect(isUniqueViolation({ code: '23503' })).toBe(false);
        expect(isUniqueViolation('23505')).toBe(false);
    });
});

describe('timezone', () => {
    it('accepts only IANA names the runtime knows', () => {
        expect(isValidTimeZone('UTC')).toBe(true);
        expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
        for (const zone of [null, undefined, '', '3/Europe', 'GMT+3x', 'Europe/Atlantis']) {
            expect(isValidTimeZone(zone), String(zone)).toBe(false);
        }
    });

    it('formats in Russian on request, naming the zone', () => {
        const at = new Date('2026-08-05T06:00:00.000Z');
        expect(formatZonedTime(at, 'Europe/Kyiv', 'ru')).toMatch(/^среда, 5 августа 2026 г\..*09:00 \(Europe\/Kyiv\)$/);
    });

    it('picks Russian copy for any ru* language and English for everything else', () => {
        expect(isRussian('ru')).toBe(true);
        expect(isRussian('RU-ua')).toBe(true);
        expect(isRussian('en')).toBe(false);
        expect(isRussian('uk')).toBe(false);
        expect(isRussian(null)).toBe(false);
        expect(isRussian(undefined)).toBe(false);
    });
});

describe('html', () => {
    /** Owner-written text lands on public, indexable pages: it must never become markup. */
    it('escapes all five HTML-significant characters', () => {
        expect(escapeHtml(`<a href="x" onclick='y'>&amp;</a>`)).toBe(
            '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;',
        );
        expect(escapeHtml('plain text')).toBe('plain text');
    });

    it('makes the public page indexable and every other page noindex', () => {
        const page = renderPublicPage({ title: 'T', content: 'C', publishedAt: new Date(0) });
        expect(page).not.toContain('name="robots"');
        expect(page).toMatch(/^<!doctype html>\n<html lang="en">/);
        for (const html of [renderNotFoundPage('Gone.'), renderReleasePage('token-0123456789abcdef')]) {
            expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
        }
    });

    it('escapes the not-found message and the footer links', () => {
        const html = renderNotFoundPage('<b>nope</b>', {
            docs: 'https://d.example/"x"',
            privacy: 'https://p.example',
            terms: 'https://t.example',
        });
        expect(html).toContain('<p class="muted">&lt;b&gt;nope&lt;/b&gt;</p>');
        expect(html).toContain('<a href="https://d.example/&quot;x&quot;">Docs</a>');
    });

    it('embeds the release token as a JS string literal, quotes and backslashes escaped', () => {
        const html = renderReleasePage('ab"c\\d-0123456789');
        expect(html).toContain('var TOKEN = "ab\\"c\\\\d-0123456789";');
        expect(html).toContain('<title>Release</title>');
    });
});
