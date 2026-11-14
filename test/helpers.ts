import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db.js';
import type { Storage } from '../src/services.js';

const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

export async function makeDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(schema);
  return {
    query: async (t, p) => {
      const r = await pg.query(t, p);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? 0 };
    },
    tx: (fn) =>
      pg.transaction((tx) =>
        fn({
          query: async (t, p) => {
            const r = await tx.query(t, p);
            return { rows: r.rows as any[], rowCount: r.affectedRows ?? 0 };
          },
        }),
      ),
    close: () => pg.close(),
  };
}

export const testConfig: Config = {
  port: 0,
  databaseUrl: '',
  jwtSecret: 'x'.repeat(40),
  allowedOrigins: ['https://app.example.com'],
  cookieSecure: false,
  cookieSameSite: 'lax',
};

export const fakeStorage: Storage = {
  async signUpload(key) {
    return `https://upload.test/${key}`;
  },
  async urlFor(key) {
    return key ? `https://files.test/${key}` : null;
  },
};

export async function makeApp() {
  process.env.NODE_ENV = 'test';
  const db = await makeDb();
  const app = createApp({ cfg: testConfig, db, storage: fakeStorage });
  let n = 0;

  /** A signed-in browser (cookie jar) for a brand-new user. */
  async function newUser(name = `User${++n}`) {
    const agent = request.agent(app);
    const email = `${name.toLowerCase()}${n}@test.com`;
    const res = await agent.post('/api/auth/register').send({ email, password: 'password123', displayName: name });
    if (res.status !== 201) throw new Error('register failed: ' + JSON.stringify(res.body));
    return { agent, id: res.body.user.id as string, email, name };
  }

  async function newFamily(owner: Awaited<ReturnType<typeof newUser>>, name = 'Test Family') {
    const res = await owner.agent.post('/api/families').send({ name });
    return res.body.family.id as string;
  }

  /** Invite via the owner/admin, then join as `joiner`. */
  async function join(
    inviter: Awaited<ReturnType<typeof newUser>>,
    familyId: string,
    joiner: Awaited<ReturnType<typeof newUser>>,
    role: 'member' | 'editor' = 'member',
  ) {
    const inv = await inviter.agent.post(`/api/families/${familyId}/invites`).send({ role });
    const acc = await joiner.agent.post('/api/invites/accept').send({ code: inv.body.invite.code });
    if (acc.status !== 200) throw new Error('join failed: ' + JSON.stringify(acc.body));
    return acc.body.family;
  }

  return { app, db, newUser, newFamily, join };
}
