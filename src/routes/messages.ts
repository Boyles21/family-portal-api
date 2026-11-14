import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { HttpError, assertUuid, parse, requireMember } from '../http.js';
import type { Hub, Push, Storage } from '../services.js';

/**
 * Direct messages. Privacy rule: a message is only ever returned to its sender or its
 * recipient. There is no endpoint that lists other people's conversations, not even for admins.
 */
export function messageRoutes(cfg: Config, db: Db, storage: Storage, hub: Hub, push: Push) {
  const r = Router({ mergeParams: true });
  const member = requireMember(db);

  const shape = (m: any) => ({
    id: m.id, senderId: m.sender_user_id, recipientId: m.recipient_user_id,
    content: m.content, createdAt: m.created_at, readAt: m.read_at,
  });

  /** One row per person I have talked to: last message + unread count. */
  r.get('/conversations', member, async (req, res) => {
    const f = req.membership!.familyId;
    const me = req.user!.id;
    const [last, unread] = await Promise.all([
      db.query(
        `with mine as (
           select *, case when sender_user_id = $2 then recipient_user_id else sender_user_id end as other_id
             from messages where family_id = $1 and (sender_user_id = $2 or recipient_user_id = $2))
         select distinct on (other_id) other_id, id, content, created_at, sender_user_id
           from mine order by other_id, created_at desc`,
        [f, me],
      ),
      db.query(
        `select sender_user_id as other_id, count(*)::int as n from messages
          where family_id = $1 and recipient_user_id = $2 and read_at is null group by 1`,
        [f, me],
      ),
    ]);
    const unreadBy = new Map(unread.rows.map((u: any) => [u.other_id, u.n]));
    const people = await db.query(
      `select m.user_id, coalesce(p.full_name, u.display_name) as name, p.avatar_key
         from memberships m join users u on u.id = m.user_id left join persons p on p.id = m.person_id
        where m.family_id = $1 and m.user_id = any($2::uuid[])`,
      [f, last.rows.map((l: any) => l.other_id)],
    );
    const byId = new Map(people.rows.map((p: any) => [p.user_id, p]));
    const conversations = await Promise.all(
      last.rows
        .filter((l: any) => byId.has(l.other_id)) // hide chats with people who left the family
        .map(async (l: any) => ({
          userId: l.other_id,
          name: byId.get(l.other_id).name,
          avatarUrl: await storage.urlFor(byId.get(l.other_id).avatar_key),
          lastMessage: { id: l.id, content: l.content, createdAt: l.created_at, fromMe: l.sender_user_id === me },
          unreadCount: unreadBy.get(l.other_id) ?? 0,
        })),
    );
    conversations.sort((a, b) => +new Date(b.lastMessage.createdAt) - +new Date(a.lastMessage.createdAt));
    res.json({ conversations, totalUnread: [...unreadBy.values()].reduce((s: number, n: any) => s + n, 0) });
  });

  r.get('/messages/:otherUserId', member, async (req, res) => {
    const other = assertUuid(String(req.params.otherUserId), 'member');
    const q = parse(
      z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      req.query,
    );
    const { rows } = await db.query(
      `select * from messages
        where family_id = $1
          and ((sender_user_id = $2 and recipient_user_id = $3) or (sender_user_id = $3 and recipient_user_id = $2))
          and ($4::timestamptz is null or created_at < $4)
        order by created_at desc limit $5`,
      [req.membership!.familyId, req.user!.id, other, q.before ?? null, q.limit],
    );
    res.json({ messages: rows.reverse().map(shape) });
  });

  r.post('/messages', member, async (req, res) => {
    const f = req.membership!.familyId;
    const b = parse(
      z.object({ recipientUserId: z.string().uuid(), content: z.string().trim().min(1).max(4000) }),
      req.body,
    );
    if (b.recipientUserId === req.user!.id) throw new HttpError(400, 'You cannot message yourself');
    const rec = await db.query('select 1 from memberships where family_id = $1 and user_id = $2', [f, b.recipientUserId]);
    if (!rec.rows[0]) throw new HttpError(404, 'member not found');
    const { rows } = await db.query(
      `insert into messages (family_id, sender_user_id, recipient_user_id, content) values ($1,$2,$3,$4) returning *`,
      [f, req.user!.id, b.recipientUserId, b.content],
    );
    const message = shape(rows[0]);
    hub.publish(f, 'message.created', message, [req.user!.id, b.recipientUserId]);
    void push.notify([b.recipientUserId], { title: req.user!.displayName, body: b.content.slice(0, 120), url: '/' });
    res.status(201).json({ message });
  });

  r.post('/messages/:otherUserId/read', member, async (req, res) => {
    const other = assertUuid(String(req.params.otherUserId), 'member');
    const { rowCount } = await db.query(
      `update messages set read_at = now()
        where family_id = $1 and sender_user_id = $2 and recipient_user_id = $3 and read_at is null`,
      [req.membership!.familyId, other, req.user!.id],
    );
    if (rowCount) hub.publish(req.membership!.familyId, 'message.read', { by: req.user!.id, from: other }, [other]);
    res.json({ marked: rowCount });
  });

  return r;
}
