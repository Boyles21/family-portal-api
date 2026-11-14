import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { HttpError, assertUuid, parse, requireAuth, requireMember } from '../http.js';
import { ROLE_RANK, type Role } from '../types.js';
import type { Storage } from '../services.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const newCode = () => Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const createFamily = z.object({
  name: z.string().trim().min(2).max(100),
  tagline: z.string().trim().max(200).optional(),
  myName: z.string().trim().min(1).max(120).optional(),
});
const updateFamily = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  tagline: z.string().trim().max(200).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
const createInvite = z.object({
  role: z.enum(['editor', 'member']).default('member'),
  personId: z.string().uuid().optional(),
  maxUses: z.number().int().min(1).max(50).default(1),
  expiresInDays: z.number().int().min(1).max(60).default(14),
});
const changeRole = z.object({ role: z.enum(['admin', 'editor', 'member']) });
const acceptInvite = z.object({ code: z.string().trim().min(6).max(20).transform((s) => s.toUpperCase()) });

export function familyRoutes(cfg: Config, db: Db, storage: Storage) {
  const r = Router();
  const auth = requireAuth(cfg, db);

  /* ---------------------------- create / read family --------------------------- */

  r.post('/families', auth, async (req, res) => {
    const body = parse(createFamily, req.body);
    const family = await db.tx(async (q) => {
      const f = await q.query(
        'insert into families (name, tagline, created_by) values ($1, $2, $3) returning *',
        [body.name, body.tagline ?? '', req.user!.id],
      );
      const p = await q.query(
        'insert into persons (family_id, full_name, created_by) values ($1, $2, $3) returning id',
        [f.rows[0].id, body.myName ?? req.user!.displayName, req.user!.id],
      );
      await q.query(
        "insert into memberships (family_id, user_id, role, person_id) values ($1, $2, 'owner', $3)",
        [f.rows[0].id, req.user!.id, p.rows[0].id],
      );
      return { ...f.rows[0], person_id: p.rows[0].id };
    });
    res.status(201).json({ family: shapeFamily(family, 'owner', family.person_id) });
  });

  const fam = Router({ mergeParams: true });
  r.use('/families/:familyId', auth, fam);

  fam.get('/', requireMember(db), async (req, res) => {
    const { rows } = await db.query('select * from families where id = $1', [req.membership!.familyId]);
    res.json({ family: shapeFamily(rows[0], req.membership!.role, req.membership!.personId) });
  });

  fam.patch('/', requireMember(db, 'admin'), async (req, res) => {
    const b = parse(updateFamily, req.body);
    const { rows } = await db.query(
      `update families set name = coalesce($2, name), tagline = coalesce($3, tagline),
              accent_color = coalesce($4, accent_color) where id = $1 returning *`,
      [req.membership!.familyId, b.name ?? null, b.tagline ?? null, b.accentColor ?? null],
    );
    res.json({ family: shapeFamily(rows[0], req.membership!.role, req.membership!.personId) });
  });

  /* --------------------------------- members ---------------------------------- */

  fam.get('/members', requireMember(db), async (req, res) => {
    const isAdmin = ROLE_RANK[req.membership!.role] >= ROLE_RANK.admin;
    const { rows } = await db.query(
      `select m.user_id, m.role, m.person_id, m.joined_at, u.display_name, u.email,
              p.full_name, p.nickname, p.avatar_key
         from memberships m
         join users u on u.id = m.user_id
         left join persons p on p.id = m.person_id
        where m.family_id = $1 order by m.joined_at`,
      [req.membership!.familyId],
    );
    res.json({
      members: await Promise.all(
        rows.map(async (m: any) => ({
          userId: m.user_id,
          role: m.role,
          personId: m.person_id,
          joinedAt: m.joined_at,
          name: m.full_name ?? m.display_name,
          nickname: m.nickname ?? '',
          avatarUrl: await storage.urlFor(m.avatar_key),
          email: isAdmin ? m.email : undefined, // emails are only visible to admins
        })),
      ),
    });
  });

  fam.patch('/members/:userId', requireMember(db, 'admin'), async (req, res) => {
    const targetId = assertUuid(String(req.params.userId), 'member');
    const { role } = parse(changeRole, req.body);
    const t = await db.query('select role from memberships where family_id = $1 and user_id = $2', [
      req.membership!.familyId, targetId,
    ]);
    if (!t.rows[0]) throw new HttpError(404, 'member not found');
    const current = t.rows[0].role as Role;
    if (current === 'owner') throw new HttpError(403, 'The owner role cannot be changed');
    const isOwner = req.membership!.role === 'owner';
    if ((role === 'admin' || current === 'admin') && !isOwner) {
      throw new HttpError(403, 'Only the owner can manage admins');
    }
    await db.query('update memberships set role = $3 where family_id = $1 and user_id = $2', [
      req.membership!.familyId, targetId, role,
    ]);
    res.json({ ok: true });
  });

  fam.delete('/members/:userId', requireMember(db), async (req, res) => {
    const targetId = assertUuid(String(req.params.userId), 'member');
    const t = await db.query('select role from memberships where family_id = $1 and user_id = $2', [
      req.membership!.familyId, targetId,
    ]);
    if (!t.rows[0]) throw new HttpError(404, 'member not found');
    const targetRole = t.rows[0].role as Role;
    if (targetRole === 'owner') throw new HttpError(403, 'The owner cannot be removed');
    const self = targetId === req.user!.id;
    if (!self && ROLE_RANK[req.membership!.role] <= Math.max(ROLE_RANK[targetRole], ROLE_RANK.editor)) {
      throw new HttpError(403, 'You do not have permission to remove this member');
    }
    await db.query('delete from memberships where family_id = $1 and user_id = $2', [
      req.membership!.familyId, targetId,
    ]);
    res.json({ ok: true });
  });

  /* --------------------------------- invites ---------------------------------- */

  fam.post('/invites', requireMember(db, 'admin'), async (req, res) => {
    const b = parse(createInvite, req.body);
    const { rows } = await db.query(
      `insert into invites (family_id, code, role, person_id, max_uses, expires_at, created_by)
       values ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7)
       returning id, code, role, person_id, max_uses, uses, expires_at`,
      [req.membership!.familyId, newCode(), b.role, b.personId ?? null, b.maxUses, b.expiresInDays, req.user!.id],
    );
    res.status(201).json({ invite: shapeInvite(rows[0]) });
  });

  fam.get('/invites', requireMember(db, 'admin'), async (req, res) => {
    const { rows } = await db.query(
      `select id, code, role, person_id, max_uses, uses, expires_at, revoked
         from invites where family_id = $1 and not revoked and expires_at > now() and uses < max_uses
        order by created_at desc`,
      [req.membership!.familyId],
    );
    res.json({ invites: rows.map(shapeInvite) });
  });

  fam.delete('/invites/:inviteId', requireMember(db, 'admin'), async (req, res) => {
    const id = assertUuid(String(req.params.inviteId), 'invite');
    await db.query('update invites set revoked = true where id = $1 and family_id = $2', [
      id, req.membership!.familyId,
    ]);
    res.json({ ok: true });
  });

  /* ------------- public preview + accept (not under /families/:id) ------------- */

  r.get('/invites/:code/preview', async (req, res) => {
    const { rows } = await db.query(
      `select f.name, f.tagline, f.accent_color
         from invites i join families f on f.id = i.family_id
        where i.code = $1 and not i.revoked and i.expires_at > now() and i.uses < i.max_uses`,
      [String(req.params.code).toUpperCase()],
    );
    if (!rows[0]) throw new HttpError(404, 'This invite is invalid or has expired');
    res.json({ family: { name: rows[0].name, tagline: rows[0].tagline, accentColor: rows[0].accent_color } });
  });

  r.post('/invites/accept', auth, async (req, res) => {
    const { code } = parse(acceptInvite, req.body);
    const out = await db.tx(async (q) => {
      const inv = await q.query(
        `select * from invites where code = $1 and not revoked and expires_at > now() and uses < max_uses for update`,
        [code],
      );
      const invite = inv.rows[0];
      if (!invite) throw new HttpError(404, 'This invite is invalid or has expired');

      const already = await q.query('select 1 from memberships where family_id = $1 and user_id = $2', [
        invite.family_id, req.user!.id,
      ]);
      if (already.rows[0]) throw new HttpError(409, 'You are already a member of this family');

      const fRow = await q.query('select * from families where id = $1', [invite.family_id]);
      const count = await q.query('select count(*)::int as n from memberships where family_id = $1', [
        invite.family_id,
      ]);
      if (count.rows[0].n >= fRow.rows[0].member_limit) {
        throw new HttpError(402, 'This family has reached its member limit. Ask the owner to upgrade.');
      }

      let personId: string = invite.person_id;
      if (personId) {
        const claimed = await q.query('select 1 from memberships where person_id = $1', [personId]);
        if (claimed.rows[0]) throw new HttpError(409, 'That person is already linked to another account');
      } else {
        const p = await q.query(
          'insert into persons (family_id, full_name, created_by) values ($1, $2, $3) returning id',
          [invite.family_id, req.user!.displayName, req.user!.id],
        );
        personId = p.rows[0].id;
      }
      // Role always comes from the invite the admin created, never from the request body.
      await q.query('insert into memberships (family_id, user_id, role, person_id) values ($1, $2, $3, $4)', [
        invite.family_id, req.user!.id, invite.role, personId,
      ]);
      await q.query('update invites set uses = uses + 1 where id = $1', [invite.id]);
      return { family: fRow.rows[0], role: invite.role as Role, personId };
    });
    res.json({ family: shapeFamily(out.family, out.role, out.personId) });
  });

  return r;
}

function shapeFamily(f: any, role: Role, personId: string | null) {
  return {
    id: f.id, name: f.name, tagline: f.tagline, accentColor: f.accent_color,
    plan: f.plan, memberLimit: f.member_limit, role, personId,
  };
}

function shapeInvite(i: any) {
  return {
    id: i.id, code: i.code, role: i.role, personId: i.person_id,
    maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at,
  };
}
