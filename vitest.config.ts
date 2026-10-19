import { defineConfig } from 'vitest/config';

/** Logic — shared helpers, the owner gate and the service layer — is held higher than the wiring around it. */
const LOGIC = { lines: 90, statements: 90, functions: 90, branches: 90 };

export default defineConfig({
    test: {
        environment: 'node',
        // Quiet the app logger, pin the zone, and make every run independent of the local `.env`:
        // `DOTENV_PATH` points dotenv at a file that never exists, so only the values below (and
        // what a test sets itself) reach `env`. They are placeholders — nothing connects: tests
        // replace the database with an in-process PGlite.
        env: {
            LOG_LEVEL: 'silent',
            NODE_ENV: 'test',
            TZ: 'UTC',
            DOTENV_PATH: 'tests/.env.none',
            DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
            OWNER_TOKEN: 'test-owner-token-0123456789',
            PUBLIC_URL: 'https://core.example.com',
        },
        include: ['tests/**/*.test.ts'],
        testTimeout: 20_000,
        hookTimeout: 20_000,
        pool: 'forks',
        coverage: {
            enabled: true,
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
                // Process entry points with nothing of their own to test: `server.ts` only binds the
                // port and wires the sweep interval and signal handlers around `buildApp()`, and
                // `db/migrate.ts` runs the migrator against a live Postgres and exits. `buildApp()`,
                // `runSweep()` and the migrations themselves run in the integration tests.
                'src/server.ts',
                'src/db/migrate.ts',
            ],
            reporter: ['text-summary'],
            // `build` fails below these.
            thresholds: {
                // Each file on its own as well: a new module without tests fails `build` instead of hiding in the total.
                perFile: { lines: 80, statements: 80, functions: 80, branches: 80 },
                lines: 80,
                statements: 80,
                functions: 80,
                branches: 80,
                'src/shared/**': LOGIC,
                'src/auth.ts': LOGIC,
                'src/{service,logic}.ts': LOGIC,
            },
        },
    },
});
