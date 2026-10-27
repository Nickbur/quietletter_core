import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';

/**
 * A real Postgres — PGlite, in-process — with every migration in `drizzle/migrations` applied, as a
 * module shaped like `src/db/client.ts`. Queries, constraints and cascades run exactly as in
 * production, without a database server. Mock the client with it at the top of a test file (paths as seen
 * from a test in `src/`):
 *
 *     vi.mock('./db/client.js', () => import('./test/db.js').then((m) => m.pgliteClient()));
 *
 * and empty it between tests with `resetDb(db)`.
 */
export async function pgliteClient() {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const schema = await import('../db/schema.js');
    const pglite = new PGlite();
    const db = drizzle(pglite, { schema });
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle/migrations', import.meta.url)) });
    return { db, schema, pool: { end: async () => {} }, pglite };
}

/** Empties every table (the migrations' own bookkeeping lives outside `public` and stays). */
export async function resetDb(db: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }): Promise<void> {
    const result = (await db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)) as {
        rows: Array<{ tablename: string }>;
    };
    if (result.rows.length === 0) return;
    const tables = result.rows.map((row) => `"${row.tablename}"`).join(', ');
    await db.execute(sql.raw(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`));
}
