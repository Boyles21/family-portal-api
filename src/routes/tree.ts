import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db, Queryable } from '../db.js';
import { HttpError, assertUuid, parse, requireAuth, requireMember } from '../http.js';
import { ROLE_RANK } from '../types.js';
import type { Storage } from '../services.js';

const year = z.number().int().min(1000).max(2200).nullable().optional();

const personFields = {
  fullName: z.string().trim().min(1).max(160),
  nickname: z.string().trim().max(80),
  titles: z.array(z.string().trim().min(1).max(40)).max(8),
  gender: z.enum(['male', 'female', 'other', 'unknown']),
  birthYear: year,
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deathYear: year,
  isDeceased: z.boolean(),
  birthOrder: z.number().int().min(1).max(60).nullable().optional(),
  location: z.string().trim().max(120),
  bio: z.string().trim().max(4000),
  notes: z.string().trim().max(2000),
  avatarKey: z.string().max(300).nullable().optional(),
};
const createPerson = z.object(personFields).partial().required({ fullName: true });
const updatePerson = z.object(personFields).partial();
// A member who is not an editor may only edit these fields on their OWN person.
const SELF_FIELDS = new Set(['nickname', 'birthYear', 'birthDate', 'location', 'bio', 'avatarKey']);

const createUnion = z.object({
  partnerA: z.string().uuid(),
  partnerB: z.string().uuid(),
  kind: z.enum(['marriage', 'partnership', 'other']).default('marriage'),
  startYear: year,
  endYear: year,
  notes: z.string().trim().max(500).default(''),
});
const createLink = z.object({
  childId: z.string().uuid(),
  parentId: z.string().uuid(),
  kind: z.enum(['biological', 'adoptive', 'step']).default('biological'),
});

const COLS: Record<string, string> = {
  fullName: 'full_name', nickname: 'nickname', titles: 'titles', gender: 'gender',
  birthYear: 'birth_year', birthDate: 'birth_date', deathYear: 'death_year',
  isDeceased: 'is_deceased', birthOrder: 'birth_order', location: 'location',
  bio: 'bio', notes: 'notes', avatarKey: 'avatar_key',
};

export function treeRoutes(cfg: Config, db: Db, storage: Storage) {
  const r = Router({ mergeParams: true });
  const member = requireMember(db);
  const editor = requireMember(db, 'editor');

  const shapePerson = async (p: any) => ({
    id: p.id, fullName: p.full_name, nickname: p.nickname, titles: p.titles, gender: p.gender,
    birthYear: p.birth_year, birthDate: p.birth_date, deathYear: p.death_year,
    isDeceased: p.is_deceased, birthOrder: p.birth_order, location: p.location,
    bio: p.bio, notes: p.notes, avatarUrl: await storage.urlFor(p.avatar_key),
    userId: p.user_id ?? null,
  });

  /** Whole tree in one call: people, unions and parent links. */
  r.get('/tree', member, async (req, res) => {
    const f = req.membership!.familyId;
    const [people, unions, links] = await Promise.all([
      db.query(
        `select p.*, m.user_id from persons p
           left join memberships m on m.person_id = p.id
          where p.family_id = $1 order by p.birth_order nulls last, p.birth_year nulls last, p.full_name`,
        [f],
      ),
      db.query('select * from unions where family_id = $1', [f]),
      db.query('select * from parent_links where family_id = $1', [f]),
    ]);
    res.json({
      persons: await Promise.all(people.rows.map(shapePerson)),
      unions: unions.rows.map((u: any) => ({
        id: u.id, partnerA: u.partner_a, partnerB: u.partner_b, kind: u.kind,
        startYear: u.start_year, endYear: u.end_year, notes: u.notes,
      })),
      parentLinks: links.rows.map((l: any) => ({ childId: l.child_id, parentId: l.parent_id, kind: l.kind })),
    });
  });

  r.post('/persons', editor, async (req, res) => {
    const b = parse(createPerson, req.body);
    const keys = Object.keys(b) as (keyof typeof b)[];
    const cols = keys.map((k) => COLS[k as string]);
    const vals = keys.map((k) => (b as any)[k]);
    const { rows } = await db.query(
      `insert into persons (family_id, created_by, ${cols.join(', ')})
       values ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) returning *`,
      [req.membership!.familyId, req.user!.id, ...vals],
    );
    res.status(201).json({ person: await shapePerson(rows[0]) });
  });

  r.patch('/persons/:personId', member, async (req, res) => {
    const id = assertUuid(String(req.params.personId), 'person');
    const b = parse(updatePerson, req.body);
    const keys = Object.keys(b) as string[];
    if (keys.length === 0) throw new HttpError(400, 'Nothing to update');

    const isEditor = ROLE_RANK[req.membership!.role] >= ROLE_RANK.editor;
    const isSelf = req.membership!.personId === id;
    if (!isEditor) {
      if (!isSelf) throw new HttpError(403, 'You can only edit your own profile');
      const forbidden = keys.filter((k) => !SELF_FIELDS.has(k));
      if (forbidden.length) throw new HttpError(403, `You cannot change: ${forbidden.join(', ')}`);
    }
    const sets = keys.map((k, i) => `${COLS[k]} = $${i + 3}`);
    const { rows } = await db.query(
      `update persons set ${sets.join(', ')} where id = $1 and family_id = $2 returning *`,
      [id, req.membership!.familyId, ...keys.map((k) => (b as any)[k])],
    );
    if (!rows[0]) throw new HttpError(404, 'person not found');
    res.json({ person: await shapePerson(rows[0]) });
  });

  r.delete('/persons/:personId', requireMember(db, 'admin'), async (req, res) => {
    const id = assertUuid(String(req.params.personId), 'person');
    const linked = await db.query('select 1 from memberships where person_id = $1', [id]);
    if (linked.rows[0]) throw new HttpError(409, 'This person has a login. Remove the member first.');
    const { rowCount } = await db.query('delete from persons where id = $1 and family_id = $2', [
      id, req.membership!.familyId,
    ]);
    if (!rowCount) throw new HttpError(404, 'person not found');
    res.json({ ok: true });
  });

  /* ---------------------------------- unions ---------------------------------- */

  r.post('/unions', editor, async (req, res) => {
    const b = parse(createUnion, req.body);
    const { rows } = await db.query(
      `insert into unions (family_id, partner_a, partner_b, kind, start_year, end_year, notes)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [req.membership!.familyId, b.partnerA, b.partnerB, b.kind, b.startYear ?? null, b.endYear ?? null, b.notes],
    ); // composite FKs reject partners from another family
    res.status(201).json({ id: rows[0].id });
  });

  r.delete('/unions/:unionId', editor, async (req, res) => {
    const id = assertUuid(String(req.params.unionId), 'union');
    await db.query('delete from unions where id = $1 and family_id = $2', [id, req.membership!.familyId]);
    res.json({ ok: true });
  });

  /* ------------------------------- parent links ------------------------------- */

  r.post('/parent-links', editor, async (req, res) => {
    const b = parse(createLink, req.body);
    const f = req.membership!.familyId;
    if (b.childId === b.parentId) throw new HttpError(400, 'A person cannot be their own parent');
    if (await isDescendant(db, f, b.parentId, b.childId)) {
      throw new HttpError(400, 'That would make a person their own ancestor');
    }
    await db.query('insert into parent_links (family_id, child_id, parent_id, kind) values ($1,$2,$3,$4)', [
      f, b.childId, b.parentId, b.kind,
    ]);
    res.status(201).json({ ok: true });
  });

  r.delete('/parent-links', editor, async (req, res) => {
    const b = parse(z.object({ childId: z.string().uuid(), parentId: z.string().uuid() }), req.query);
    await db.query('delete from parent_links where family_id = $1 and child_id = $2 and parent_id = $3', [
      req.membership!.familyId, b.childId, b.parentId,
    ]);
    res.json({ ok: true });
  });

  return r;
}

/** True when `candidate` is a descendant of `ancestor` (walks children downwards). */
async function isDescendant(q: Queryable, familyId: string, candidate: string, ancestor: string) {
  const { rows } = await q.query(
    `with recursive down(id) as (
       select child_id from parent_links where family_id = $1 and parent_id = $2
       union
       select l.child_id from parent_links l join down d on l.parent_id = d.id where l.family_id = $1
     ) select 1 from down where id = $3 limit 1`,
    [familyId, ancestor, candidate],
  );
  return rows.length > 0;
}
