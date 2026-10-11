import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Read DATABASE_URL directly (independent of the app's full env validation, which
// also requires OWNER_TOKEN) so migration GENERATION works without every runtime
// secret being present — e.g. `DATABASE_URL=postgres://x drizzle-kit generate`.
const url = process.env.DATABASE_URL ?? 'postgres://placeholder@localhost:5432/quietletter';

export default defineConfig({
    // Points at the COMPILED schema (run `npm run build` first — the `db:generate`
    // script does this automatically). drizzle-kit's loader cannot resolve NodeNext
    // `.js` specifiers inside the TS source, but the compiled JS resolves cleanly.
    // Keeps the app on standard NodeNext + explicit `.js` extensions everywhere.
    schema: './dist/db/schema.js',
    out: './drizzle/migrations',
    dialect: 'postgresql',
    dbCredentials: { url },
    verbose: true,
    strict: true,
});
