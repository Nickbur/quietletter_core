import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

/**
 * The libsodium browser build the recipient release page decrypts with, served by the
 * core itself (`/vendor/:file`) instead of a CDN: the page keeps working when a
 * third-party host is down or blocked, and no outside party can swap the code that
 * handles a recipient's passphrase. Pinned to the Quietletter app's version (its
 * `crypto.ts` makes the envelope). `libsodium-sumo.js` must load first — the
 * wrappers' UMD build reads its `libsodium` global.
 */

const requireFrom = createRequire(import.meta.url);

/** Published file name → npm package whose CommonJS/UMD entry is that browser script. */
const VENDOR_SCRIPTS: Record<string, string> = {
    'libsodium-sumo.js': 'libsodium-sumo',
    'libsodium-wrappers.js': 'libsodium-wrappers-sumo',
};

const cache = new Map<string, Promise<Buffer>>();

/** A vendored script's bytes (read once, then cached), or null for any other name. */
export function vendorScript(name: string): Promise<Buffer> | null {
    const pkg = Object.hasOwn(VENDOR_SCRIPTS, name) ? VENDOR_SCRIPTS[name] : undefined;
    if (!pkg) return null;
    let bytes = cache.get(name);
    if (!bytes) {
        bytes = readFile(requireFrom.resolve(pkg));
        bytes.catch(() => cache.delete(name)); // a failed read is retried on the next request
        cache.set(name, bytes);
    }
    return bytes;
}
