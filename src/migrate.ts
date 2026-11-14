// Applies db/schema.sql to the database in DATABASE_URL. Safe to run once on an empty database.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const sql = await readFile(fileURLToPath(new URL('../db/schema.sql', import.meta.url)), 'utf8');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const exists = await client.query("select to_regclass('public.users') as t");
  if (exists.rows[0].t) {
    console.log('Schema already applied (users table exists). Nothing to do.');
  } else {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log('Schema applied.');
  }
} catch (err) {
  await client.query('rollback').catch(() => {});
  throw err;
} finally {
  await client.end();
}
