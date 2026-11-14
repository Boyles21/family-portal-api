import pg from 'pg';

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Runs fn inside one transaction (commit on success, rollback on error). */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Production adapter: node-postgres against Neon (use the *pooled* connection string). */
export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  return {
    async query(text, params) {
      const r = await pool.query(text, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn({
          async query(text, params) {
            const r = await client.query(text, params);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
        });
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
