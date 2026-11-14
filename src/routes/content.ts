import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { HttpError, assertUuid, parse, requireMember } from '../http.js';
import { ROLE_RANK } from '../types.js';
import type { Hub, Push, Storage } from '../services.js';

const objectKey = (familyId: string) =>
  z.string().max(300).refine((k) => k.startsWith(`families/${familyId}/`) && !k.includes('..'), {
    message: 'Invalid file reference',
  });

const REACTIONS = ['heart', 'celebrate', 'laugh', 'hug'] as const;

export function contentRoutes(cfg: Config, db: Db, storage: Storage, hub: Hub, push: Push) {
  const r = Router({ mergeParams: true });
  const member = requireMember(db);
  const isAdmin = (req: any) => ROLE_RANK[req.membership.role as keyof typeof ROLE_RANK] >= ROLE_RANK.admin;

  /** Every person id in `ids` must belong to this family. */
  async function assertPersonsInFamily(familyId: string, ids: string[]) {
    if (ids.length === 0) return;
    const { rows } = await db.query('select count(*)::int as n from persons where family_id = $1 and id = any($2::uuid[])', [
      familyId, ids,
    ]);
    if (rows[0].n !== new Set(ids).size) throw new HttpError(400, 'Tagged person not found in this family');
  }

  /* ----------------------------------- posts ----------------------------------- */

  const POST_SELECT = `
    select p.id, p.content, p.object_key, p.location, p.feeling, p.tagged_person_ids, p.created_at,
           p.author_user_id,
           coalesce(per.full_name, u.display_name, 'Former member') as author_name,
           per.avatar_key as author_avatar_key,
           (select count(*)::int from comments c where c.post_id = p.id) as comment_count,
           coalesce((select jsonb_object_agg(t.type, t.users)
                       from (select type, array_agg(user_id) as users from reactions
                              where post_id = p.id group by type) t), '{}'::jsonb) as reactions
      from posts p
      left join users u on u.id = p.author_user_id
      left join memberships m on m.family_id = p.family_id and m.user_id = p.author_user_id
      left join persons per on per.id = m.person_id`;

  const shapePost = async (p: any) => ({
    id: p.id, content: p.content, photoUrl: await storage.urlFor(p.object_key),
    location: p.location, feeling: p.feeling, taggedPersonIds: p.tagged_person_ids,
    createdAt: p.created_at, authorId: p.author_user_id, authorName: p.author_name,
    authorAvatarUrl: await storage.urlFor(p.author_avatar_key),
    commentCount: p.comment_count,
    reactions: { heart: [], celebrate: [], laugh: [], hug: [], ...(p.reactions ?? {}) },
  });

  r.get('/posts', member, async (req, res) => {
    const q = parse(
      z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
      req.query,
    );
    const { rows } = await db.query(
      `${POST_SELECT} where p.family_id = $1 and ($2::timestamptz is null or p.created_at < $2)
        order by p.created_at desc limit $3`,
      [req.membership!.familyId, q.before ?? null, q.limit],
    );
    res.json({ posts: await Promise.all(rows.map(shapePost)), nextBefore: rows.length === q.limit ? rows[rows.length - 1].created_at : null });
  });

  r.post('/posts', member, async (req, res) => {
    const f = req.membership!.familyId;
    const b = parse(
      z.object({
        content: z.string().trim().min(1).max(5000),
        objectKey: objectKey(f).optional(),
        location: z.string().trim().max(120).default(''),
        feeling: z.string().trim().max(60).default(''),
        taggedPersonIds: z.array(z.string().uuid()).max(30).default([]),
      }),
      req.body,
    );
    await assertPersonsInFamily(f, b.taggedPersonIds);
    const ins = await db.query(
      `insert into posts (family_id, author_user_id, content, object_key, location, feeling, tagged_person_ids)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [f, req.user!.id, b.content, b.objectKey ?? null, b.location, b.feeling, b.taggedPersonIds],
    );
    const { rows } = await db.query(`${POST_SELECT} where p.id = $1 and p.family_id = $2`, [ins.rows[0].id, f]);
    const post = await shapePost(rows[0]);
    hub.publish(f, 'post.created', post);
    void notifyOthers(f, req.user!.id, { title: post.authorName, body: b.content.slice(0, 120), url: '/' });
    res.status(201).json({ post });
  });

  r.delete('/posts/:postId', member, async (req, res) => {
    const id = assertUuid(String(req.params.postId), 'post');
    const f = req.membership!.familyId;
    const { rows } = await db.query('select author_user_id from posts where id = $1 and family_id = $2', [id, f]);
    if (!rows[0]) throw new HttpError(404, 'post not found');
    if (rows[0].author_user_id !== req.user!.id && !isAdmin(req)) {
      throw new HttpError(403, 'Only the author or an admin can delete this post');
    }
    await db.query('delete from posts where id = $1 and family_id = $2', [id, f]);
    hub.publish(f, 'post.deleted', { id });
    res.json({ ok: true });
  });

  async function notifyOthers(familyId: string, exceptUserId: string, payload: { title: string; body: string; url: string }) {
    const { rows } = await db.query('select user_id from memberships where family_id = $1 and user_id <> $2', [
      familyId, exceptUserId,
    ]);
    await push.notify(rows.map((x: any) => x.user_id), payload);
  }

  /* ---------------------------------- reactions --------------------------------- */

  r.post('/posts/:postId/reactions', member, async (req, res) => {
    const id = assertUuid(String(req.params.postId), 'post');
    const f = req.membership!.familyId;
    const { type } = parse(z.object({ type: z.enum(REACTIONS) }), req.body);
    const post = await db.query('select 1 from posts where id = $1 and family_id = $2', [id, f]);
    if (!post.rows[0]) throw new HttpError(404, 'post not found');
    // Toggle: delete if present, otherwise insert.
    const del = await db.query('delete from reactions where post_id = $1 and user_id = $2 and type = $3', [id, req.user!.id, type]);
    if (!del.rowCount) {
      await db.query('insert into reactions (post_id, family_id, user_id, type) values ($1,$2,$3,$4)', [id, f, req.user!.id, type]);
    }
    const { rows } = await db.query(`${POST_SELECT} where p.id = $1 and p.family_id = $2`, [id, f]);
    const shaped = await shapePost(rows[0]);
    hub.publish(f, 'post.updated', shaped);
    res.json({ post: shaped });
  });

  /* ---------------------------------- comments ---------------------------------- */

  const shapeComment = (c: any) => ({
    id: c.id, postId: c.post_id, content: c.content, createdAt: c.created_at,
    authorId: c.author_user_id, authorName: c.author_name,
  });
  const COMMENT_SELECT = `
    select c.*, coalesce(per.full_name, u.display_name, 'Former member') as author_name
      from comments c
      left join users u on u.id = c.author_user_id
      left join memberships m on m.family_id = c.family_id and m.user_id = c.author_user_id
      left join persons per on per.id = m.person_id`;

  r.get('/posts/:postId/comments', member, async (req, res) => {
    const id = assertUuid(String(req.params.postId), 'post');
    const { rows } = await db.query(`${COMMENT_SELECT} where c.post_id = $1 and c.family_id = $2 order by c.created_at`, [
      id, req.membership!.familyId,
    ]);
    res.json({ comments: rows.map(shapeComment) });
  });

  r.post('/posts/:postId/comments', member, async (req, res) => {
    const id = assertUuid(String(req.params.postId), 'post');
    const f = req.membership!.familyId;
    const { content } = parse(z.object({ content: z.string().trim().min(1).max(2000) }), req.body);
    const post = await db.query('select author_user_id from posts where id = $1 and family_id = $2', [id, f]);
    if (!post.rows[0]) throw new HttpError(404, 'post not found');
    const ins = await db.query(
      'insert into comments (family_id, post_id, author_user_id, content) values ($1,$2,$3,$4) returning id',
      [f, id, req.user!.id, content],
    );
    const { rows } = await db.query(`${COMMENT_SELECT} where c.id = $1 and c.family_id = $2`, [ins.rows[0].id, f]);
    const comment = shapeComment(rows[0]);
    hub.publish(f, 'comment.created', comment);
    const authorId = post.rows[0].author_user_id;
    if (authorId && authorId !== req.user!.id) {
      void push.notify([authorId], { title: comment.authorName, body: `commented: ${content.slice(0, 100)}`, url: '/' });
    }
    res.status(201).json({ comment });
  });

  r.delete('/comments/:commentId', member, async (req, res) => {
    const id = assertUuid(String(req.params.commentId), 'comment');
    const f = req.membership!.familyId;
    const { rows } = await db.query('select author_user_id from comments where id = $1 and family_id = $2', [id, f]);
    if (!rows[0]) throw new HttpError(404, 'comment not found');
    if (rows[0].author_user_id !== req.user!.id && !isAdmin(req)) throw new HttpError(403, 'Not allowed');
    await db.query('delete from comments where id = $1 and family_id = $2', [id, f]);
    res.json({ ok: true });
  });

  /* ----------------------------------- photos ----------------------------------- */

  const PHOTO_SELECT = `
    select ph.*, coalesce(per.full_name, u.display_name, 'Former member') as uploader_name,
           coalesce((select array_agg(user_id) from photo_likes where photo_id = ph.id), '{}') as likes
      from photos ph
      left join users u on u.id = ph.uploader_user_id
      left join memberships m on m.family_id = ph.family_id and m.user_id = ph.uploader_user_id
      left join persons per on per.id = m.person_id`;

  const shapePhoto = async (p: any) => ({
    id: p.id, title: p.title, caption: p.caption, url: await storage.urlFor(p.object_key),
    eventName: p.event_name, year: p.year, taggedPersonIds: p.tagged_person_ids,
    uploaderId: p.uploader_user_id, uploaderName: p.uploader_name, likes: p.likes, createdAt: p.created_at,
  });

  r.get('/photos', member, async (req, res) => {
    const q = parse(
      z.object({
        eventName: z.string().max(100).optional(),
        year: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(60),
        before: z.string().datetime().optional(),
      }),
      req.query,
    );
    const { rows } = await db.query(
      `${PHOTO_SELECT} where ph.family_id = $1
          and ($2::text is null or ph.event_name = $2)
          and ($3::int is null or ph.year = $3)
          and ($4::timestamptz is null or ph.created_at < $4)
        order by ph.created_at desc limit $5`,
      [req.membership!.familyId, q.eventName ?? null, q.year ?? null, q.before ?? null, q.limit],
    );
    res.json({ photos: await Promise.all(rows.map(shapePhoto)) });
  });

  r.post('/photos', member, async (req, res) => {
    const f = req.membership!.familyId;
    const b = parse(
      z.object({
        title: z.string().trim().min(1).max(160),
        caption: z.string().trim().max(1000).default(''),
        objectKey: objectKey(f),
        eventName: z.string().trim().min(1).max(100).default('General'),
        year: z.number().int().min(1800).max(2200).optional(),
        taggedPersonIds: z.array(z.string().uuid()).max(40).default([]),
      }),
      req.body,
    );
    await assertPersonsInFamily(f, b.taggedPersonIds);
    const ins = await db.query(
      `insert into photos (family_id, uploader_user_id, title, caption, object_key, event_name, year, tagged_person_ids)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [f, req.user!.id, b.title, b.caption, b.objectKey, b.eventName, b.year ?? null, b.taggedPersonIds],
    );
    const { rows } = await db.query(`${PHOTO_SELECT} where ph.id = $1 and ph.family_id = $2`, [ins.rows[0].id, f]);
    const photo = await shapePhoto(rows[0]);
    hub.publish(f, 'photo.created', photo);
    res.status(201).json({ photo });
  });

  r.post('/photos/:photoId/like', member, async (req, res) => {
    const id = assertUuid(String(req.params.photoId), 'photo');
    const f = req.membership!.familyId;
    const photo = await db.query('select 1 from photos where id = $1 and family_id = $2', [id, f]);
    if (!photo.rows[0]) throw new HttpError(404, 'photo not found');
    const del = await db.query('delete from photo_likes where photo_id = $1 and user_id = $2', [id, req.user!.id]);
    if (!del.rowCount) {
      await db.query('insert into photo_likes (photo_id, family_id, user_id) values ($1,$2,$3)', [id, f, req.user!.id]);
    }
    const { rows } = await db.query(`${PHOTO_SELECT} where ph.id = $1 and ph.family_id = $2`, [id, f]);
    res.json({ photo: await shapePhoto(rows[0]) });
  });

  r.delete('/photos/:photoId', member, async (req, res) => {
    const id = assertUuid(String(req.params.photoId), 'photo');
    const f = req.membership!.familyId;
    const { rows } = await db.query('select uploader_user_id from photos where id = $1 and family_id = $2', [id, f]);
    if (!rows[0]) throw new HttpError(404, 'photo not found');
    if (rows[0].uploader_user_id !== req.user!.id && !isAdmin(req)) {
      throw new HttpError(403, 'Only the uploader or an admin can delete this photo');
    }
    await db.query('delete from photos where id = $1 and family_id = $2', [id, f]);
    res.json({ ok: true });
  });

  return r;
}
