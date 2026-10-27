import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: h.readFile }));

import { vendorScript } from './vendor.js';

/**
 * The release page's libsodium is read from node_modules once and then served from memory; a read
 * that fails (disk hiccup, missing package) is not cached, so the next request tries again instead
 * of breaking every release page until the server restarts.
 */

beforeEach(() => {
    h.readFile.mockReset();
});

describe('vendorScript cache', () => {
    it('reads each script once and serves it from memory afterwards', async () => {
        h.readFile.mockResolvedValue(Buffer.from('/* wrappers */'));
        const first = vendorScript('libsodium-wrappers.js');
        expect(vendorScript('libsodium-wrappers.js')).toBe(first);
        expect((await first)?.toString()).toBe('/* wrappers */');
        expect(h.readFile).toHaveBeenCalledOnce();
        expect(String(h.readFile.mock.calls[0]?.[0])).toMatch(/libsodium-wrappers-sumo/);
    });

    it('retries a failed read on the next request', async () => {
        h.readFile.mockRejectedValueOnce(new Error('EIO')).mockResolvedValueOnce(Buffer.from('/* core */'));
        await expect(vendorScript('libsodium-sumo.js')).rejects.toThrow('EIO');
        const retried = await vendorScript('libsodium-sumo.js');
        expect(retried?.toString()).toBe('/* core */');
        expect(h.readFile).toHaveBeenCalledTimes(2);
    });

    it('serves nothing for a name outside the allowlist, without touching the disk', () => {
        expect(vendorScript('hasOwnProperty')).toBeNull();
        expect(vendorScript('libsodium-sumo.js.map')).toBeNull();
        expect(h.readFile).not.toHaveBeenCalled();
    });
});
