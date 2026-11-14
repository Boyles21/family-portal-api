import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { HttpError, parse, requireAuth, requireMember } from '../http.js';
import { UPLOAD_LIMITS, newObjectKey, type Hub, type Push, type Storage } from '../services.js';

/** Routes scoped to a family: uploads + realtime stream. */
export function familyMiscRoutes(cfg: Config, db: Db, storage: Storage, hub: Hub) {
  const r = Router({ mergeParams: true });
  const member = requireMember(db);

  /** Step 1 of an upload: ask for a short-lived URL, then PUT the file straight to the bucket. */
  r.post('/uploads/sign', member, async (req, res) => {
    const b = parse(
      z.object({
        kind: z.enum(['image', 'audio', 'document']),
        contentType: z.string().max(100),
        size: z.number().int().positive(),
      }),
      req.body,
    );
    const limit = UPLOAD_LIMITS[b.kind];
    if (!limit.types.includes(b.contentType)) throw new HttpError(400, `Unsupported file type for ${b.kind}`);
    if (b.size > limit.maxBytes) {
      throw new HttpError(413, `File too large (max ${Math.round(limit.maxBytes / 1024 / 1024)} MB)`);
    }
    const key = newObjectKey(req.membership!.familyId, b.contentType);
    const uploadUrl = await storage.signUpload(key, b.contentType, limit.maxBytes);
    res.json({ objectKey: key, uploadUrl, method: 'PUT', headers: { 'Content-Type': b.contentType } });
  });

  /** Server-Sent Events: new posts, comments, messages (only to the people they concern). */
  r.get('/events', member, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');
    const off = hub.subscribe(req.membership!.familyId, req.user!.id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      off();
    });
  });

  return r;
}

/** Push subscription management (per user, not per family). */
export function pushRoutes(cfg: Config, db: Db, push: Push) {
  const r = Router();
  const auth = requireAuth(cfg, db);

  r.get('/push/public-key', (_req, res) => res.json({ publicKey: push.publicKey }));

  r.post('/push/subscribe', auth, async (req, res) => {
    const b = parse(
      z.object({
        endpoint: z.string().url().max(1000),
        keys: z.object({ p256dh: z.string().max(300), auth: z.string().max(300) }),
      }),
      req.body,
    );
    await db.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1,$2,$3,$4)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      [req.user!.id, b.endpoint, b.keys.p256dh, b.keys.auth],
    );
    res.status(201).json({ ok: true });
  });

  r.post('/push/unsubscribe', auth, async (req, res) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().url() }), req.body);
    await db.query('delete from push_subscriptions where endpoint = $1 and user_id = $2', [endpoint, req.user!.id]);
    res.json({ ok: true });
  });

  return r;
}
