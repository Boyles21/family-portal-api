import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sendNotification, setVapidDetails } from 'web-push';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Db } from './db.js';

/* ---------------------------------- Storage --------------------------------- */

export interface Storage {
  /** Presigned PUT so the browser uploads straight to the bucket. */
  signUpload(key: string, contentType: string, maxBytes: number): Promise<string>;
  /** Short-lived private read URL for an object key. */
  urlFor(key: string | null | undefined): Promise<string | null>;
}

export const UPLOAD_LIMITS: Record<string, { types: string[]; maxBytes: number }> = {
  image: { types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * 1024 * 1024 },
  audio: { types: ['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav'], maxBytes: 25 * 1024 * 1024 },
  document: { types: ['application/pdf'], maxBytes: 20 * 1024 * 1024 },
};

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

export function newObjectKey(familyId: string, contentType: string): string {
  return `families/${familyId}/${randomUUID()}.${EXT[contentType] ?? 'bin'}`;
}

export function s3Storage(cfg: NonNullable<Config['s3']>): Storage {
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return {
    signUpload: (key, contentType) =>
      getSignedUrl(client, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType }), {
        expiresIn: 300,
      }),
    async urlFor(key) {
      if (!key) return null;
      return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: 3600 });
    },
  };
}

/** Used when no bucket is configured: uploads are refused, reads return null. */
export const noStorage: Storage = {
  async signUpload() {
    throw Object.assign(new Error('File storage is not configured'), { status: 501 });
  },
  async urlFor() {
    return null;
  },
};

/* ------------------------------------ Push ----------------------------------- */

export interface Push {
  publicKey: string | null;
  /** Fire-and-forget notification to specific users. Never throws. */
  notify(userIds: string[], payload: { title: string; body: string; url: string }): Promise<void>;
}

export function webPush(cfg: Config['vapid'], db: Db): Push {
  if (!cfg) return { publicKey: null, async notify() {} };
  setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
  return {
    publicKey: cfg.publicKey,
    async notify(userIds, payload) {
      if (userIds.length === 0) return;
      try {
        const { rows } = await db.query(
          'select id, endpoint, p256dh, auth from push_subscriptions where user_id = any($1::uuid[])',
          [userIds],
        );
        await Promise.all(
          rows.map(async (s: any) => {
            try {
              await sendNotification(
                { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                JSON.stringify(payload),
              );
            } catch (err: any) {
              // 404/410 = subscription is gone; clean it up.
              if (err?.statusCode === 404 || err?.statusCode === 410) {
                await db.query('delete from push_subscriptions where id = $1', [s.id]);
              }
            }
          }),
        );
      } catch {
        /* push must never break a request */
      }
    },
  };
}

/* ------------------------------ Realtime (SSE) ------------------------------- */

import type { Response } from 'express';

export interface Hub {
  subscribe(familyId: string, userId: string, res: Response): () => void;
  /** audience = specific user ids; omit to reach everyone in the family. */
  publish(familyId: string, event: string, data: unknown, audience?: string[]): void;
}

/** In-process hub: fine for one server instance. For several instances use Redis/Ably. */
export function createHub(): Hub {
  const clients = new Map<string, Set<{ userId: string; res: Response }>>();
  return {
    subscribe(familyId, userId, res) {
      const entry = { userId, res };
      if (!clients.has(familyId)) clients.set(familyId, new Set());
      clients.get(familyId)!.add(entry);
      return () => clients.get(familyId)?.delete(entry);
    },
    publish(familyId, event, data, audience) {
      for (const c of clients.get(familyId) ?? []) {
        if (audience && !audience.includes(c.userId)) continue;
        c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    },
  };
}
