import { describe, expect, it } from 'vitest';
import { renderNotFoundPage, renderPublicPage, renderReleasePage } from '../src/shared/html.js';
import { vendorScript } from '../src/shared/vendor.js';

/**
 * The recipient release page decrypts in the browser with libsodium served by this
 * instance — never a CDN — and loads the core library before the wrappers (their UMD
 * build reads its `libsodium` global; the other order leaves `sodium` undefined).
 */

describe('vendored libsodium', () => {
    it('serves the core library and the wrappers as browser scripts', async () => {
        const core = (await vendorScript('libsodium-sumo.js'))?.toString('utf8') ?? '';
        const wrappers = (await vendorScript('libsodium-wrappers.js'))?.toString('utf8') ?? '';
        expect(core).toContain('A.libsodium=');
        expect(wrappers).toContain('e.libsodium');
        expect(wrappers).toContain('crypto_aead_xchacha20poly1305_ietf_decrypt');
    });

    it('serves nothing else', () => {
        expect(vendorScript('../package.json')).toBeNull();
        expect(vendorScript('constructor')).toBeNull();
        expect(vendorScript('sodium.js')).toBeNull();
    });
});

describe('release page', () => {
    it('loads libsodium from this instance, core library first', () => {
        const html = renderReleasePage('token-0123456789abcdef');
        expect(html).not.toMatch(/https?:\/\/[^"']*(jsdelivr|unpkg|cdnjs)/);
        const core = html.indexOf('<script src="/vendor/libsodium-sumo.js">');
        const wrappers = html.indexOf('<script src="/vendor/libsodium-wrappers.js">');
        expect(core).toBeGreaterThan(-1);
        expect(wrappers).toBeGreaterThan(core);
    });

    it('unwraps the content key with the same AEAD the app wraps it with', () => {
        const html = renderReleasePage('token-0123456789abcdef');
        expect(html).not.toContain('secretbox');
        expect(html).toContain('crypto_aead_xchacha20poly1305_ietf_decrypt(null, wrapped.slice(npub)');
    });
});

describe('times on the pages', () => {
    it('renders the publish time in UTC for crawlers and switches it to the reader’s local time', () => {
        const html = renderPublicPage({
            title: 'A statement',
            content: 'Hello.',
            publishedAt: new Date('2026-08-05T06:00:00.000Z'),
        });
        expect(html).toContain('<time datetime="2026-08-05T06:00:00.000Z">August 5, 2026 at 6:00 AM UTC</time>');
        expect(html).toMatch(/toLocaleString\('en-US', \{[^}]*timeZoneName: 'short' \}\)/);
        expect(html).not.toContain('GMT</time>');
    });

    it('shows the release time in the reader’s local time, naming the zone', () => {
        const html = renderReleasePage('token-0123456789abcdef');
        expect(html).not.toContain('toUTCString');
        expect(html).toContain("'Released ' + new Date(bundle.firedAt).toLocaleString('en-US', LOCAL_TIME)");
        expect(html).toMatch(/var LOCAL_TIME = \{[^}]*timeZoneName: 'short' \};/);
    });
});

describe('footer links', () => {
    const links = {
        docs: 'https://docs.example.com/guide',
        privacy: 'https://example.com/privacy?a=1&b=2',
        terms: 'https://example.com/terms',
    };

    it('links every public page to the guide and the legal documents', () => {
        const pages = [
            renderReleasePage('token-0123456789abcdef', links),
            renderPublicPage({ title: 'A statement', content: 'Hello.', publishedAt: new Date() }, links),
            renderNotFoundPage('Nothing here.', links),
        ];
        for (const html of pages) {
            expect(html).toContain('<a href="https://docs.example.com/guide">Docs</a>');
            expect(html).toContain('<a href="https://example.com/privacy?a=1&amp;b=2">Privacy</a>');
            expect(html).toContain('<a href="https://example.com/terms">Terms</a>');
        }
    });

    it('renders no footer without links', () => {
        expect(renderNotFoundPage('Nothing here.')).not.toContain('class="foot"');
    });
});
