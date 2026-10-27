import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pool, schema } from './client.js';
import {
    defaultCadence,
    defaultGrace,
    defaultWarnings,
    publicPages,
    releaseTokens,
    switchActions,
    switchDeliveries,
    switchPayloads,
    switchRecipients,
    switches,
} from './schema.js';
import { env } from '../env.js';

/**
 * The real database client and the schema it is bound to. Loading the client must not open a
 * connection (the server, the sweep CLI and the migrator all import it before anything runs), and
 * the schema must keep the guarantees the rest of the code relies on: deleting a switch cascades to
 * every child row, the delivery ledger and the one-page-per-action rule are unique indexes, and a
 * new switch gets the "Balanced" preset.
 */

afterAll(async () => {
    await pool.end();
});

describe('db client', () => {
    it('builds a pg pool from DATABASE_URL without connecting', () => {
        expect(pool).toBeInstanceOf(pg.Pool);
        expect(pool.options).toMatchObject({
            connectionString: env.DATABASE_URL,
            max: 10,
            idleTimeoutMillis: 30_000,
        });
        expect(pool.totalCount).toBe(0);
    });

    it('binds drizzle to the full schema, enabling the relational query API', () => {
        expect(schema.switches).toBe(switches);
        for (const table of ['switches', 'switchRecipients', 'switchActions', 'switchPayloads', 'releaseTokens']) {
            expect(db.query, table).toHaveProperty(table);
        }
    });
});

describe('schema', () => {
    const indexes = (table: PgTable) =>
        getTableConfig(table)
            .indexes.map((i) => ({
                name: i.config.name,
                unique: i.config.unique,
                on: i.config.columns.map((c) => (c as { name: string }).name),
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    it('cascades every child row from its switch (and payloads / pages from their action)', () => {
        const cases: Array<[PgTable, string[]]> = [
            [switchRecipients, ['quietletter_switches']],
            [switchActions, ['quietletter_switches']],
            [switchPayloads, ['quietletter_switches', 'quietletter_switch_actions']],
            [releaseTokens, ['quietletter_switches', 'quietletter_switch_recipients']],
            [publicPages, ['quietletter_switches', 'quietletter_switch_actions']],
            [switchDeliveries, ['quietletter_switches']],
        ];
        for (const [table, parents] of cases) {
            const fks = getTableConfig(table).foreignKeys;
            expect(fks.map((fk) => fk.onDelete)).toEqual(parents.map(() => 'cascade'));
            const referenced = fks.map((fk) => getTableConfig(fk.reference().foreignTable).name).sort();
            expect(referenced, getTableConfig(table).name).toEqual([...parents].sort());
        }
    });

    it('keeps the uniqueness the sweep and the publisher rely on', () => {
        expect(indexes(switchDeliveries)).toEqual([
            {
                name: 'quietletter_switch_deliveries_unique_idx',
                unique: true,
                on: ['switch_id', 'kind', 'step_key'],
            },
        ]);
        expect(indexes(switchPayloads)).toEqual([
            { name: 'quietletter_payloads_action_uniq', unique: true, on: ['action_id'] },
            { name: 'quietletter_payloads_switch_idx', unique: false, on: ['switch_id'] },
        ]);
        expect(indexes(publicPages)).toEqual([
            { name: 'quietletter_public_pages_action_uniq', unique: true, on: ['action_id'] },
            { name: 'quietletter_public_pages_switch_idx', unique: false, on: ['switch_id'] },
        ]);
        expect(indexes(switches)).toEqual([
            { name: 'quietletter_switches_deadline_idx', unique: false, on: ['next_deadline'] },
            { name: 'quietletter_switches_state_idx', unique: false, on: ['state'] },
        ]);
        for (const table of [switchRecipients, switchActions, releaseTokens]) {
            expect(indexes(table).map((i) => i.on)).toEqual([['switch_id']]);
        }
    });

    it('gives a new switch the Balanced preset and an active state', () => {
        const columns = Object.fromEntries(getTableConfig(switches).columns.map((c) => [c.name, c]));
        expect(columns.state?.default).toBe('active');
        expect(columns.cadence?.default).toEqual({ value: 30, unit: 'day' });
        expect(columns.grace?.default).toEqual({ value: 14, unit: 'day' });
        expect(columns.warnings?.default).toEqual(defaultWarnings());
        expect(defaultCadence()).toEqual({ value: 30, unit: 'day' });
        expect(defaultGrace()).toEqual({ value: 14, unit: 'day' });
        // Every escalation step goes out on push + email, inside the 14-day grace window.
        expect(defaultWarnings().every((w) => w.channels.includes('push') && w.channels.includes('email'))).toBe(true);
        expect(Math.max(...defaultWarnings().map((w) => w.offsetHours))).toBeLessThan(14 * 24);
    });

    it('returns fresh default objects, so one switch can never mutate another one’s preset', () => {
        const a = defaultWarnings();
        a[0]!.channels.push('sms');
        expect(defaultWarnings()[0]!.channels).toEqual(['push', 'email']);
    });

    it('mints time-ordered UUIDv7 primary keys in the application', () => {
        for (const table of [switches, switchRecipients, switchActions, switchPayloads, switchDeliveries]) {
            const id = getTableConfig(table).columns.find((c) => c.name === 'id');
            const value = id?.defaultFn?.();
            expect(value, getTableConfig(table).name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
        }
    });
});
