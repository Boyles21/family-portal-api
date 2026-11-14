import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { makeApp } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => {
  t = await makeApp();
}, 60_000);

describe('auth', () => {
  it('registers, reads /me, logs out, and rejects bad passwords', async () => {
    const u = await t.newUser('Ada');
    const me = await u.agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(u.email);

    const bad = await request(t.app).post('/api/auth/login').send({ email: u.email, password: 'wrong-password' });
    expect(bad.status).toBe(401);
    const good = await request(t.app).post('/api/auth/login').send({ email: u.email.toUpperCase(), password: 'password123' });
    expect(good.status).toBe(200);

    await u.agent.post('/api/auth/logout');
    expect((await u.agent.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const u = await t.newUser('Dup');
    const dup = await request(t.app).post('/api/auth/register').send({ email: u.email, password: 'password123', displayName: 'x' });
    expect(dup.status).toBe(409);
    const weak = await request(t.app).post('/api/auth/register').send({ email: 'w@test.com', password: 'short', displayName: 'x' });
    expect(weak.status).toBe(400);
  });

  it('never returns the password hash', async () => {
    const u = await t.newUser('Hash');
    const me = await u.agent.get('/api/auth/me');
    expect(JSON.stringify(me.body)).not.toMatch(/password|\$2[aby]\$/);
  });

  it('blocks unsafe requests from a foreign origin (CSRF)', async () => {
    const u = await t.newUser('Csrf');
    const res = await u.agent.post('/api/families').set('Origin', 'https://evil.example').send({ name: 'Hijacked' });
    expect(res.status).toBe(403);
    const ok = await u.agent.post('/api/families').set('Origin', 'https://app.example.com').send({ name: 'Fine Family' });
    expect(ok.status).toBe(201);
  });
});

describe('families, invites and roles', () => {
  it('creator becomes owner with a person in the tree', async () => {
    const owner = await t.newUser('Owner');
    const fid = await t.newFamily(owner);
    const tree = await owner.agent.get(`/api/families/${fid}/tree`);
    expect(tree.body.persons).toHaveLength(1);
    expect(tree.body.persons[0].fullName).toBe('Owner');
    const me = await owner.agent.get('/api/auth/me');
    expect(me.body.families[0].role).toBe('owner');
  });

  it('members join with an invite; role comes from the invite, not the request', async () => {
    const owner = await t.newUser('Own2');
    const fid = await t.newFamily(owner);
    const joiner = await t.newUser('Join');
    const inv = await owner.agent.post(`/api/families/${fid}/invites`).send({ role: 'member' });
    const acc = await joiner.agent.post('/api/invites/accept').send({ code: inv.body.invite.code, role: 'owner' });
    expect(acc.status).toBe(200);
    expect(acc.body.family.role).toBe('member');
  });

  it('plain members cannot create invites, edit the family or change roles', async () => {
    const owner = await t.newUser('Own3');
    const fid = await t.newFamily(owner);
    const m = await t.newUser('Mem3');
    await t.join(owner, fid, m);
    expect((await m.agent.post(`/api/families/${fid}/invites`).send({})).status).toBe(403);
    expect((await m.agent.patch(`/api/families/${fid}`).send({ name: 'Mine now' })).status).toBe(403);
    expect((await m.agent.patch(`/api/families/${fid}/members/${owner.id}`).send({ role: 'member' })).status).toBe(403);
  });

  it('invites are single-use by default, can be revoked, and expire by count', async () => {
    const owner = await t.newUser('Own4');
    const fid = await t.newFamily(owner);
    const inv = await owner.agent.post(`/api/families/${fid}/invites`).send({});
    const a = await t.newUser('A4');
    const b = await t.newUser('B4');
    expect((await a.agent.post('/api/invites/accept').send({ code: inv.body.invite.code })).status).toBe(200);
    expect((await b.agent.post('/api/invites/accept').send({ code: inv.body.invite.code })).status).toBe(404);

    const inv2 = await owner.agent.post(`/api/families/${fid}/invites`).send({});
    await owner.agent.delete(`/api/families/${fid}/invites/${inv2.body.invite.id}`);
    expect((await b.agent.post('/api/invites/accept').send({ code: inv2.body.invite.code })).status).toBe(404);
  });

  it('public invite preview shows only the family name', async () => {
    const owner = await t.newUser('Own5');
    const fid = await t.newFamily(owner, 'Preview Family');
    const inv = await owner.agent.post(`/api/families/${fid}/invites`).send({});
    const res = await request(t.app).get(`/api/invites/${inv.body.invite.code}/preview`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.family).sort()).toEqual(['accentColor', 'name', 'tagline']);
  });

  it('enforces the free-plan member limit', async () => {
    const owner = await t.newUser('Own6');
    const fid = await t.newFamily(owner);
    await t.db.query('update families set member_limit = 2 where id = $1', [fid]);
    await t.join(owner, fid, await t.newUser('M6a'));
    const inv = await owner.agent.post(`/api/families/${fid}/invites`).send({});
    const late = await t.newUser('M6b');
    const res = await late.agent.post('/api/invites/accept').send({ code: inv.body.invite.code });
    expect(res.status).toBe(402);
  });

  it('only the owner can promote to admin; owner cannot be removed; admins cannot remove admins', async () => {
    const owner = await t.newUser('Own7');
    const fid = await t.newFamily(owner);
    const a = await t.newUser('Adm7');
    const b = await t.newUser('Adm7b');
    await t.join(owner, fid, a);
    await t.join(owner, fid, b);
    expect((await owner.agent.patch(`/api/families/${fid}/members/${a.id}`).send({ role: 'admin' })).status).toBe(200);
    expect((await a.agent.patch(`/api/families/${fid}/members/${b.id}`).send({ role: 'admin' })).status).toBe(403);
    expect((await a.agent.delete(`/api/families/${fid}/members/${owner.id}`)).status).toBe(403);
    expect((await a.agent.patch(`/api/families/${fid}/members/${b.id}`).send({ role: 'editor' })).status).toBe(200);
  });

  it('member emails are hidden from non-admins', async () => {
    const owner = await t.newUser('Own8');
    const fid = await t.newFamily(owner);
    const m = await t.newUser('Mem8');
    await t.join(owner, fid, m);
    const asMember = await m.agent.get(`/api/families/${fid}/members`);
    expect(asMember.body.members.every((x: any) => x.email === undefined)).toBe(true);
    const asOwner = await owner.agent.get(`/api/families/${fid}/members`);
    expect(asOwner.body.members.some((x: any) => x.email === owner.email)).toBe(true);
  });
});

describe('tenant isolation (the privacy guarantee)', () => {
  it('outsiders get 404 on every family route, and cannot read, write or guess ids', async () => {
    const owner = await t.newUser('OwnA');
    const fid = await t.newFamily(owner, 'Family A');
    const post = await owner.agent.post(`/api/families/${fid}/posts`).send({ content: 'Secret family news' });
    const postId = post.body.post.id;

    const outsider = await t.newUser('Outsider');
    const other = await t.newFamily(outsider, 'Family B');

    for (const path of ['', '/members', '/tree', '/posts', '/photos', '/conversations', '/invites']) {
      const res = await outsider.agent.get(`/api/families/${fid}${path}`);
      expect(res.status, path).toBe(404);
    }
    expect((await outsider.agent.post(`/api/families/${fid}/posts`).send({ content: 'hi' })).status).toBe(404);

    // Using MY family's route with THEIR post id must not reach it either.
    expect((await outsider.agent.post(`/api/families/${other}/posts/${postId}/comments`).send({ content: 'x' })).status).toBe(404);
    expect((await outsider.agent.post(`/api/families/${other}/posts/${postId}/reactions`).send({ type: 'heart' })).status).toBe(404);
    expect((await outsider.agent.delete(`/api/families/${other}/posts/${postId}`)).status).toBe(404);
    expect((await outsider.agent.get(`/api/families/${other}/posts/${postId}/comments`)).body.comments).toEqual([]);

    // Their own feed shows none of Family A's posts.
    const feed = await outsider.agent.get(`/api/families/${other}/posts`);
    expect(feed.body.posts).toHaveLength(0);
  });

  it('unauthenticated requests are refused everywhere', async () => {
    const owner = await t.newUser('OwnU');
    const fid = await t.newFamily(owner);
    for (const path of ['/posts', '/tree', '/members', '/photos']) {
      expect((await request(t.app).get(`/api/families/${fid}${path}`)).status).toBe(401);
    }
  });

  it('the database itself rejects tree links that cross families', async () => {
    const a = await t.newUser('TreeA');
    const b = await t.newUser('TreeB');
    const fa = await t.newFamily(a);
    const fb = await t.newFamily(b);
    const pa = (await a.agent.get(`/api/families/${fa}/tree`)).body.persons[0].id;
    const pb = (await b.agent.get(`/api/families/${fb}/tree`)).body.persons[0].id;
    // A (editor+) tries to attach B's person as a parent inside family A:
    const res = await a.agent.post(`/api/families/${fa}/parent-links`).send({ childId: pa, parentId: pb });
    expect(res.status).toBe(400);
    // Direct SQL attempt also fails (composite foreign key):
    await expect(
      t.db.query('insert into parent_links (family_id, child_id, parent_id) values ($1,$2,$3)', [fa, pa, pb]),
    ).rejects.toThrow();
    // Tagging another family's person on a post is refused:
    const tag = await a.agent.post(`/api/families/${fa}/posts`).send({ content: 'hi', taggedPersonIds: [pb] });
    expect(tag.status).toBe(400);
  });

  it('cannot attach another family\'s uploaded file to a post', async () => {
    const a = await t.newUser('FileA');
    const b = await t.newUser('FileB');
    const fa = await t.newFamily(a);
    const fb = await t.newFamily(b);
    const sign = await b.agent.post(`/api/families/${fb}/uploads/sign`).send({ kind: 'image', contentType: 'image/jpeg', size: 1000 });
    expect(sign.status).toBe(200);
    const stolen = await a.agent.post(`/api/families/${fa}/posts`).send({ content: 'x', objectKey: sign.body.objectKey });
    expect(stolen.status).toBe(400);
    const own = await a.agent.post(`/api/families/${fa}/uploads/sign`).send({ kind: 'image', contentType: 'image/png', size: 1000 });
    const ok = await a.agent.post(`/api/families/${fa}/posts`).send({ content: 'ok', objectKey: own.body.objectKey });
    expect(ok.status).toBe(201);
    expect(ok.body.post.photoUrl).toContain(own.body.objectKey);
  });
});

describe('private messages', () => {
  it('only sender and recipient can read a conversation, even admins and owners', async () => {
    const owner = await t.newUser('OwnM');
    const fid = await t.newFamily(owner);
    const a = await t.newUser('MsgA');
    const b = await t.newUser('MsgB');
    await t.join(owner, fid, a);
    await t.join(owner, fid, b);

    const sent = await a.agent.post(`/api/families/${fid}/messages`).send({ recipientUserId: b.id, content: 'Private hello' });
    expect(sent.status).toBe(201);

    const asB = await b.agent.get(`/api/families/${fid}/messages/${a.id}`);
    expect(asB.body.messages.map((m: any) => m.content)).toEqual(['Private hello']);

    // The owner asks for A<->B in every way the API allows: nothing comes back.
    expect((await owner.agent.get(`/api/families/${fid}/messages/${a.id}`)).body.messages).toEqual([]);
    expect((await owner.agent.get(`/api/families/${fid}/messages/${b.id}`)).body.messages).toEqual([]);
    expect((await owner.agent.get(`/api/families/${fid}/conversations`)).body.conversations).toEqual([]);
  });

  it('tracks unread counts and marks read', async () => {
    const owner = await t.newUser('OwnR');
    const fid = await t.newFamily(owner);
    const b = await t.newUser('ReadB');
    await t.join(owner, fid, b);
    await owner.agent.post(`/api/families/${fid}/messages`).send({ recipientUserId: b.id, content: 'one' });
    await owner.agent.post(`/api/families/${fid}/messages`).send({ recipientUserId: b.id, content: 'two' });
    let convo = await b.agent.get(`/api/families/${fid}/conversations`);
    expect(convo.body.totalUnread).toBe(2);
    await b.agent.post(`/api/families/${fid}/messages/${owner.id}/read`);
    convo = await b.agent.get(`/api/families/${fid}/conversations`);
    expect(convo.body.totalUnread).toBe(0);
  });

  it('cannot message someone outside the family or yourself', async () => {
    const owner = await t.newUser('OwnX');
    const fid = await t.newFamily(owner);
    const stranger = await t.newUser('Stranger');
    expect((await owner.agent.post(`/api/families/${fid}/messages`).send({ recipientUserId: stranger.id, content: 'hi' })).status).toBe(404);
    expect((await owner.agent.post(`/api/families/${fid}/messages`).send({ recipientUserId: owner.id, content: 'hi' })).status).toBe(400);
  });
});

describe('feed and gallery permissions', () => {
  it('members edit nothing they do not own; admins can moderate', async () => {
    const owner = await t.newUser('OwnF');
    const fid = await t.newFamily(owner);
    const a = await t.newUser('FeedA');
    const b = await t.newUser('FeedB');
    await t.join(owner, fid, a);
    await t.join(owner, fid, b);

    const p = await a.agent.post(`/api/families/${fid}/posts`).send({ content: 'Baby announcement' });
    const pid = p.body.post.id;
    expect((await b.agent.delete(`/api/families/${fid}/posts/${pid}`)).status).toBe(403);

    const react = await b.agent.post(`/api/families/${fid}/posts/${pid}/reactions`).send({ type: 'celebrate' });
    expect(react.body.post.reactions.celebrate).toEqual([b.id]);
    const unreact = await b.agent.post(`/api/families/${fid}/posts/${pid}/reactions`).send({ type: 'celebrate' });
    expect(unreact.body.post.reactions.celebrate).toEqual([]);

    const c = await b.agent.post(`/api/families/${fid}/posts/${pid}/comments`).send({ content: 'Congrats!' });
    expect(c.status).toBe(201);
    const feed = await a.agent.get(`/api/families/${fid}/posts`);
    expect(feed.body.posts[0].commentCount).toBe(1);

    expect((await owner.agent.delete(`/api/families/${fid}/posts/${pid}`)).status).toBe(200);
  });

  it('paginates the feed', async () => {
    const owner = await t.newUser('OwnP');
    const fid = await t.newFamily(owner);
    for (let i = 0; i < 5; i++) await owner.agent.post(`/api/families/${fid}/posts`).send({ content: `post ${i}` });
    const page1 = await owner.agent.get(`/api/families/${fid}/posts?limit=2`);
    expect(page1.body.posts).toHaveLength(2);
    expect(page1.body.nextBefore).toBeTruthy();
    const page2 = await owner.agent.get(`/api/families/${fid}/posts?limit=2&before=${encodeURIComponent(page1.body.nextBefore)}`);
    expect(page2.body.posts).toHaveLength(2);
    expect(page2.body.posts[0].id).not.toBe(page1.body.posts[0].id);
  });

  it('upload signing enforces type and size', async () => {
    const owner = await t.newUser('OwnS');
    const fid = await t.newFamily(owner);
    const base = `/api/families/${fid}/uploads/sign`;
    expect((await owner.agent.post(base).send({ kind: 'image', contentType: 'text/html', size: 100 })).status).toBe(400);
    expect((await owner.agent.post(base).send({ kind: 'image', contentType: 'image/jpeg', size: 50_000_000 })).status).toBe(413);
    expect((await owner.agent.post(base).send({ kind: 'audio', contentType: 'audio/mp4', size: 1_000_000 })).status).toBe(200);
  });

  it('gallery: upload, like toggle, filter by event', async () => {
    const owner = await t.newUser('OwnG');
    const fid = await t.newFamily(owner);
    const sign = await owner.agent.post(`/api/families/${fid}/uploads/sign`).send({ kind: 'image', contentType: 'image/jpeg', size: 1000 });
    const ph = await owner.agent.post(`/api/families/${fid}/photos`).send({
      title: 'Reunion', objectKey: sign.body.objectKey, eventName: 'Reunion', year: 2024,
    });
    expect(ph.status).toBe(201);
    const liked = await owner.agent.post(`/api/families/${fid}/photos/${ph.body.photo.id}/like`);
    expect(liked.body.photo.likes).toEqual([owner.id]);
    const list = await owner.agent.get(`/api/families/${fid}/photos?eventName=Reunion&year=2024`);
    expect(list.body.photos).toHaveLength(1);
    const none = await owner.agent.get(`/api/families/${fid}/photos?eventName=Wedding`);
    expect(none.body.photos).toHaveLength(0);
  });
});

describe('lineage tree', () => {
  it('builds a multi-generation tree with several spouses and deceased people', async () => {
    const owner = await t.newUser('OwnT');
    const fid = await t.newFamily(owner);
    const base = `/api/families/${fid}`;
    const mk = async (body: any) => (await owner.agent.post(`${base}/persons`).send(body)).body.person.id as string;

    const ojegede = await mk({ fullName: 'Ojegede', gender: 'male', isDeceased: true, titles: ['Oba'] });
    const wife1 = await mk({ fullName: 'Podo', gender: 'female' });
    const wife2 = await mk({ fullName: 'Second Wife', gender: 'female' });
    const kid1 = await mk({ fullName: 'Deyi', birthOrder: 1 });
    const kid2 = await mk({ fullName: 'Osikoya', birthOrder: 2 });

    expect((await owner.agent.post(`${base}/unions`).send({ partnerA: ojegede, partnerB: wife1 })).status).toBe(201);
    expect((await owner.agent.post(`${base}/unions`).send({ partnerA: ojegede, partnerB: wife2 })).status).toBe(201);
    for (const [c, p] of [[kid1, ojegede], [kid1, wife1], [kid2, ojegede], [kid2, wife2]]) {
      expect((await owner.agent.post(`${base}/parent-links`).send({ childId: c, parentId: p })).status).toBe(201);
    }

    const tree = (await owner.agent.get(`${base}/tree`)).body;
    expect(tree.unions).toHaveLength(2);
    expect(tree.parentLinks).toHaveLength(4);
    const oj = tree.persons.find((p: any) => p.fullName === 'Ojegede');
    expect(oj.isDeceased).toBe(true);
    expect(oj.titles).toEqual(['Oba']);
    expect(oj.userId).toBeNull(); // people do not need accounts
  });

  it('refuses a person being their own ancestor', async () => {
    const owner = await t.newUser('OwnC');
    const fid = await t.newFamily(owner);
    const base = `/api/families/${fid}`;
    const mk = async (n: string) => (await owner.agent.post(`${base}/persons`).send({ fullName: n })).body.person.id as string;
    const [a, b, c] = [await mk('A'), await mk('B'), await mk('C')];
    await owner.agent.post(`${base}/parent-links`).send({ childId: b, parentId: a });
    await owner.agent.post(`${base}/parent-links`).send({ childId: c, parentId: b });
    expect((await owner.agent.post(`${base}/parent-links`).send({ childId: a, parentId: c })).status).toBe(400);
    expect((await owner.agent.post(`${base}/parent-links`).send({ childId: a, parentId: a })).status).toBe(400);
  });

  it('plain members edit only their own profile fields; editors edit anyone', async () => {
    const owner = await t.newUser('OwnE');
    const fid = await t.newFamily(owner);
    const m = await t.newUser('MemE');
    const ed = await t.newUser('EdE');
    await t.join(owner, fid, m);
    await t.join(owner, fid, ed, 'editor');
    const base = `/api/families/${fid}`;
    const members = (await owner.agent.get(`${base}/members`)).body.members;
    const mine = members.find((x: any) => x.userId === m.id).personId;
    const ownersPerson = members.find((x: any) => x.userId === owner.id).personId;

    expect((await m.agent.patch(`${base}/persons/${mine}`).send({ bio: 'Hello' })).status).toBe(200);
    expect((await m.agent.patch(`${base}/persons/${mine}`).send({ fullName: 'Renamed' })).status).toBe(403);
    expect((await m.agent.patch(`${base}/persons/${ownersPerson}`).send({ bio: 'Hacked' })).status).toBe(403);
    expect((await m.agent.post(`${base}/persons`).send({ fullName: 'Fake Elder' })).status).toBe(403);
    expect((await ed.agent.patch(`${base}/persons/${ownersPerson}`).send({ bio: 'Elder bio' })).status).toBe(200);
    expect((await ed.agent.delete(`${base}/persons/${ownersPerson}`)).status).toBe(403); // delete is admin-only
  });

  it('an invite can claim a specific person already in the tree', async () => {
    const owner = await t.newUser('OwnI');
    const fid = await t.newFamily(owner);
    const base = `/api/families/${fid}`;
    const pid = (await owner.agent.post(`${base}/persons`).send({ fullName: 'Aunt Sadatu' })).body.person.id;
    const inv = await owner.agent.post(`${base}/invites`).send({ personId: pid });
    const aunt = await t.newUser('Sadatu');
    const acc = await aunt.agent.post('/api/invites/accept').send({ code: inv.body.invite.code });
    expect(acc.body.family.personId).toBe(pid);
    const tree = (await owner.agent.get(`${base}/tree`)).body;
    expect(tree.persons.find((p: any) => p.id === pid).userId).toBe(aunt.id);
  });
});

describe('input hardening', () => {
  it('rejects malformed ids with 404 and oversize bodies', async () => {
    const owner = await t.newUser('OwnH');
    const fid = await t.newFamily(owner);
    expect((await owner.agent.get('/api/families/not-a-uuid/posts')).status).toBe(404);
    expect((await owner.agent.delete(`/api/families/${fid}/posts/1;drop table users`)).status).toBe(404);
    const big = 'x'.repeat(300_000);
    expect((await owner.agent.post(`/api/families/${fid}/posts`).send({ content: big })).status).toBe(413);
  });

  it('treats SQL-looking text as plain data', async () => {
    const owner = await t.newUser('OwnQ');
    const fid = await t.newFamily(owner);
    const evil = "Robert'); DROP TABLE users;--";
    const res = await owner.agent.post(`/api/families/${fid}/posts`).send({ content: evil });
    expect(res.status).toBe(201);
    expect(res.body.post.content).toBe(evil);
    expect((await owner.agent.get('/api/auth/me')).status).toBe(200);
  });
});
