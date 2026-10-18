import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { resetDb } from './helpers/db.js';

const h = vi.hoisted(() => ({ poolEnd: vi.fn(async () => {}), client: undefined as Promise<object> | undefined }));
// Every fresh module graph below gets the SAME in-process database (one PGlite per file, created
// at import time): only the modules are re-evaluated, which is what decides `invokedDirectly`.
vi.mock('../src/db/client.js', () => {
    h.client ??= import('./helpers/db.js').then((m) => m.pgliteClient());
    return h.client.then((client) => ({ ...client, pool: { end: h.poolEnd } }));
});

/**
 * `npm run sweep` / `node dist/sweep.js` (the cron entry): importing the module runs one sweep
 * ONLY when it is the process entry point — the server and the tests import it without side
 * effects. Run directly it sweeps, prints a one-line summary and closes the pool; a failed sweep
 * prints the error and exits 1 so cron / the orchestrator sees it.
 */

const SWEEP_PATH = fileURLToPath(new URL('../src/sweep.ts', import.meta.url));
const originalEntry = process.argv[1];

type DbModule = typeof import('../src/db/client.js');
type SchemaModule = typeof import('../src/db/schema.js');

const { db: sharedDb } = await import('../src/db/client.js');

/** A fresh module graph (same database) with `argv[1]` set as the process entry. */
async function freshGraph(entry: string | undefined): Promise<{ db: DbModule['db']; schema: SchemaModule }> {
    vi.resetModules();
    if (entry === undefined) process.argv.splice(1, 1);
    else process.argv[1] = entry;
    const { db } = await import('../src/db/client.js');
    const schema = await import('../src/db/schema.js');
    return { db, schema };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = () => {};
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

let log: MockInstance<typeof console.log>;
let error: MockInstance<typeof console.error>;

beforeEach(async () => {
    await resetDb(sharedDb);
    h.poolEnd.mockReset().mockResolvedValue(undefined);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    if (process.argv.length < 2) process.argv.push(originalEntry ?? '');
    process.argv[1] = originalEntry ?? '';
    vi.restoreAllMocks();
});

describe('run directly', () => {
    it('sweeps once, prints the summary and closes the pool', async () => {
        const { db, schema } = await freshGraph(SWEEP_PATH);
        // Seed the fresh graph's database before the sweep module loads (and runs).
        const now = Date.now();
        await db.insert(schema.switches).values({
            title: 'Overdue',
            lastCheckinAt: new Date(now - 8 * 24 * 3_600_000),
            nextDeadline: new Date(now - 3_600_000),
            warnings: [{ offsetHours: 0, channels: ['push', 'email'] }],
        });
        const ended = deferred();
        h.poolEnd.mockImplementation(async () => ended.resolve());

        await import('../src/sweep.js');
        await ended.promise;

        expect(log).toHaveBeenCalledWith(
            '[sweep] scanned 1: warned 1, fired 0, published 0, delivered 0, skipped 0, failed 0',
        );
        const [row] = await db.select().from(schema.switches);
        expect(row?.state).toBe('grace');
    });

    it('prints the error and exits 1 when the sweep fails', async () => {
        const { db } = await freshGraph(SWEEP_PATH);
        vi.spyOn(db.query.switches, 'findMany').mockRejectedValueOnce(new Error('database unreachable'));
        const exited = deferred();
        const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
            exited.resolve();
        }) as never);

        await import('../src/sweep.js');
        await exited.promise;

        expect(error).toHaveBeenCalledWith(
            '[sweep] failed:',
            expect.objectContaining({ message: 'database unreachable' }),
        );
        expect(exit).toHaveBeenCalledWith(1);
        expect(h.poolEnd).not.toHaveBeenCalled();
    });
});

describe('imported', () => {
    it.each([
        ['another program is the entry point', fileURLToPath(new URL('../package.json', import.meta.url))],
        ['the entry path does not exist', '/nonexistent/quietletter/sweep.js'],
        ['there is no entry path at all', undefined],
    ])('does not sweep when %s', async (_case, entry) => {
        const { db } = await freshGraph(entry);
        const scan = vi.spyOn(db.query.switches, 'findMany');
        const mod = await import('../src/sweep.js');
        expect(typeof mod.runSweep).toBe('function');
        expect(scan).not.toHaveBeenCalled();
        expect(h.poolEnd).not.toHaveBeenCalled();
    });
});
