/**
 * Server-rendered HTML for the two PUBLIC, unauthenticated surfaces:
 *   - the public "leak" page (`/p/:slug`) — plaintext, indexable, no crypto.
 *   - the recipient release page (`/release/:token`) — renders the content-blind
 *     bundle; readable content works with zero JavaScript, and for zero-knowledge
 *     items it offers an in-browser reference decryptor (the server never sees the
 *     passphrase or plaintext).
 *
 * REFERENCE CRYPTO ENVELOPE (the Quietletter app's; documented in the public operator
 * guide): the bundled decryptor understands `algo = "xchacha20poly1305-argon2id-v1"`:
 *   KEK        = crypto_pwhash(32, passphrase, salt, INTERACTIVE, INTERACTIVE, ARGON2ID13)
 *   contentKey = crypto_aead_xchacha20poly1305_ietf_decrypt(wrappedKey[24:], wrappedKey[:24], KEK)
 *   plaintext  = crypto_aead_xchacha20poly1305_ietf_decrypt(ciphertext, nonce, contentKey)
 * with salt / wrappedKey / nonce / ciphertext all base64. A client using a
 * different envelope should point its own UI at the JSON endpoint instead — the
 * server stays blind either way.
 */

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const BASE_STYLE = `
    :root { color-scheme: light dark; }
    body { font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; line-height: 1.6;
           max-width: 720px; margin: 0 auto; padding: 32px 20px; color: #1a1a1a; background: #fafafa; }
    h1 { font-size: 1.6rem; margin: 0 0 4px; }
    .meta { color: #6b7280; font-size: 0.85rem; margin: 0 0 24px; }
    .content { white-space: pre-wrap; word-wrap: break-word; background: #fff; border: 1px solid #e5e7eb;
               border-radius: 10px; padding: 20px; }
    .action { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 20px; margin: 0 0 16px; }
    .action h3 { margin: 0 0 8px; font-size: 1rem; }
    .tag { display: inline-block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
           color: #6b7280; border: 1px solid #e5e7eb; border-radius: 999px; padding: 2px 8px; margin-left: 6px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #d1d5db;
                           border-radius: 8px; font-size: 0.95rem; margin: 8px 0; }
    button { background: #2563eb; color: #fff; border: 0; border-radius: 8px; padding: 10px 16px;
             font-size: 0.95rem; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    .muted { color: #6b7280; font-size: 0.85rem; }
    .err { color: #b91c1c; font-size: 0.9rem; }
    a.dl { display: inline-block; margin-top: 8px; }
    .foot { margin-top: 40px; color: #6b7280; font-size: 0.8rem; }
    .foot a { color: inherit; }
    @media (prefers-color-scheme: dark) {
        body { color: #e5e7eb; background: #0b0b0c; }
        .content, .action { background: #141416; border-color: #2a2a2e; }
        .meta, .muted, .tag, .foot { color: #9ca3af; }
        input[type=password] { background: #1c1c1f; border-color: #3a3a40; color: #e5e7eb; }
    }
`;

/** Footer links on every public page: the user guide and the instance's legal documents. */
export interface PageLinks {
    docs: string;
    privacy: string;
    terms: string;
}

function footer(links?: PageLinks): string {
    if (!links) return '';
    return (
        `<footer class="foot"><a href="${escapeHtml(links.docs)}">Docs</a> · ` +
        `<a href="${escapeHtml(links.privacy)}">Privacy</a> · ` +
        `<a href="${escapeHtml(links.terms)}">Terms</a></footer>`
    );
}

function doc(title: string, body: string, opts: { index: boolean; links?: PageLinks }): string {
    const robots = opts.index ? '' : '<meta name="robots" content="noindex,nofollow">';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${robots}
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
${body}
${footer(opts.links)}
</body>
</html>`;
}

/**
 * `Intl` options for a time shown on a page, in the reader's own zone, naming it
 * ("August 5, 2026 at 9:00 AM GMT+3") — a JS object literal for the page scripts.
 */
const LOCAL_TIME_JS =
    "{ year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }";

/**
 * The truly-public "leak" page. Indexable plaintext — this is the self-host-only action.
 * The publish time is server-rendered in UTC (crawlers, no-JS readers) and switched to
 * the reader's own local time by a tiny inline script.
 */
export function renderPublicPage(
    page: { title: string; content: string; publishedAt: Date },
    links?: PageLinks,
): string {
    const iso = page.publishedAt.toISOString();
    const utc = `${new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(
        page.publishedAt,
    )} UTC`;
    const body =
        `<h1>${escapeHtml(page.title)}</h1>` +
        `<p class="meta">Published <time datetime="${iso}">${escapeHtml(utc)}</time> via Quietletter.</p>` +
        `<div class="content">${escapeHtml(page.content)}</div>` +
        `<script>(function () {
    var el = document.querySelector('time[datetime]');
    var d = el && new Date(el.getAttribute('datetime'));
    if (d && !isNaN(d.getTime())) el.textContent = d.toLocaleString('en-US', ${LOCAL_TIME_JS});
})();</script>`;
    return doc(page.title, body, { index: true, links });
}

/** Simple 404 page for an unknown public slug. */
export function renderNotFoundPage(message: string, links?: PageLinks): string {
    return doc('Not found', `<h1>Not found</h1><p class="muted">${escapeHtml(message)}</p>`, { index: false, links });
}

/**
 * The recipient release page. It fetches the content-blind JSON bundle from
 * `/v1/release/:token` and renders it; readable items show immediately, ZK items
 * get a passphrase box + reference decryptor. Noindex — release links are private.
 */
export function renderReleasePage(token: string, links?: PageLinks): string {
    // Encode the token for safe interpolation into a JS string literal inside an inline <script>:
    // JSON quotes it, and `<` becomes `<` so a token like `</script>` can never end the
    // script element (the literal still evaluates to the same token).
    const jsToken = JSON.stringify(token).replace(/</g, '\\u003c');
    const body = `
<h1 id="title">Release</h1>
<p class="meta" id="meta"></p>
<div id="root"><p class="muted">Loading…</p></div>
<!-- Served by this instance (no CDN). The wrappers read the "libsodium" global, so the core library loads first. -->
<script src="/vendor/libsodium-sumo.js"></script>
<script src="/vendor/libsodium-wrappers.js"></script>
<script>
(function () {
    var TOKEN = ${jsToken};
    var LOCAL_TIME = ${LOCAL_TIME_JS};
    var REF_ALGO = 'xchacha20poly1305-argon2id-v1';
    var root = document.getElementById('root');

    function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

    function b64(s) {
        var bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    async function decrypt(p, passphrase) {
        await sodium.ready;
        if (p.algo !== REF_ALGO) {
            throw new Error('This page decrypts the "' + REF_ALGO + '" envelope. This item uses "' + (p.algo || 'unknown') + '" — use your Quietletter client.');
        }
        var salt = b64(p.salt), wrapped = b64(p.wrappedKey), nonce = b64(p.nonce), ct = b64(p.ciphertext);
        var kek = sodium.crypto_pwhash(32, passphrase, salt,
            sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
            sodium.crypto_pwhash_ALG_ARGON2ID13);
        // The content key is wrapped with the same AEAD as the content: a 24-byte nonce prefix + the sealed key.
        var npub = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
        var contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, wrapped.slice(npub), null, wrapped.slice(0, npub), kek);
        return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, contentKey);
    }

    function renderAction(a) {
        var el = document.createElement('div');
        el.className = 'action';
        var label = a.type.replace('_', ' ');
        el.innerHTML = '<h3>' + esc(a.config && a.config.subject ? a.config.subject : label) +
            '<span class="tag">' + esc(label) + '</span></h3>';
        var p = a.payload;
        if (!p) { el.innerHTML += '<p class="muted">No content was stored for this item.</p>'; return el; }

        if (p.mode === 'readable') {
            var c = document.createElement('div'); c.className = 'content'; c.textContent = p.readableContent || '';
            el.appendChild(c);
            return el;
        }

        // Zero-knowledge: passphrase + decrypt.
        var note = document.createElement('p'); note.className = 'muted';
        note.textContent = 'Encrypted. Enter the passphrase the sender shared with you out-of-band.';
        var input = document.createElement('input'); input.type = 'password'; input.placeholder = 'Passphrase';
        var btn = document.createElement('button'); btn.textContent = 'Decrypt';
        var out = document.createElement('div');
        btn.onclick = async function () {
            out.innerHTML = ''; btn.disabled = true; btn.textContent = 'Decrypting…';
            try {
                var bytes = await decrypt(p, input.value);
                var fname = a.config && a.config.filename;
                var mime = (a.config && a.config.mimeType) || 'application/octet-stream';
                if (fname) {
                    var blob = new Blob([bytes], { type: mime });
                    var url = URL.createObjectURL(blob);
                    out.innerHTML = '<a class="dl" href="' + url + '" download="' + esc(fname) + '">Download ' + esc(fname) + '</a>';
                } else {
                    var text = sodium.to_string(bytes);
                    var c = document.createElement('div'); c.className = 'content'; c.textContent = text; out.appendChild(c);
                }
            } catch (e) {
                out.innerHTML = '<p class="err">' + esc(e && e.message ? e.message : 'Could not decrypt — check the passphrase.') + '</p>';
            } finally { btn.disabled = false; btn.textContent = 'Decrypt'; }
        };
        el.appendChild(note); el.appendChild(input); el.appendChild(btn); el.appendChild(out);
        return el;
    }

    fetch('/v1/release/' + encodeURIComponent(TOKEN))
        .then(function (r) { if (!r.ok) throw new Error('invalid'); return r.json(); })
        .then(function (bundle) {
            document.getElementById('title').textContent = bundle.switchTitle || 'Release';
            var m = [];
            if (bundle.recipientName) m.push('For ' + bundle.recipientName);
            if (bundle.firedAt) m.push('Released ' + new Date(bundle.firedAt).toLocaleString('en-US', LOCAL_TIME));
            document.getElementById('meta').textContent = m.join(' · ');
            root.innerHTML = '';
            var actions = bundle.actions || [];
            if (!actions.length) { root.innerHTML = '<p class="muted">Nothing was left here.</p>'; return; }
            actions.forEach(function (a) { root.appendChild(renderAction(a)); });
        })
        .catch(function () {
            root.innerHTML = '<p class="err">This release link is not valid, has expired, or the switch has not fired.</p>';
        });
})();
</script>`;
    return doc('Release', body, { index: false, links });
}
