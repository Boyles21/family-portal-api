import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { errorHandler, originGuard, requireAuth } from './http.js';
import { authRoutes } from './routes/auth.js';
import { familyRoutes } from './routes/families.js';
import { treeRoutes } from './routes/tree.js';
import { contentRoutes } from './routes/content.js';
import { messageRoutes } from './routes/messages.js';
import { familyMiscRoutes, pushRoutes } from './routes/misc.js';
import { createHub, noStorage, s3Storage, webPush, type Hub, type Push, type Storage } from './services.js';

export interface Deps {
  cfg: Config;
  db: Db;
  storage?: Storage;
  push?: Push;
  hub?: Hub;
}

export function createApp({ cfg, db, storage, push, hub }: Deps) {
  const st = storage ?? (cfg.s3 ? s3Storage(cfg.s3) : noStorage);
  const pu = push ?? webPush(cfg.vapid, db);
  const hb = hub ?? createHub();

  const app = express();
  app.set('trust proxy', 1); // behind Render/Fly/Cloudflare: use the real client IP for rate limits
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: cfg.allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '200kb' })); // files go to the bucket, never through the API
  app.use(cookieParser());
  app.use(originGuard(cfg));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: process.env.NODE_ENV === 'test' ? 100_000 : 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use('/auth', authRoutes(cfg, db));
  api.use(pushRoutes(cfg, db, pu));
  api.use(familyRoutes(cfg, db, st));

  const auth = requireAuth(cfg, db);
  api.use('/families/:familyId', auth, treeRoutes(cfg, db, st));
  api.use('/families/:familyId', auth, contentRoutes(cfg, db, st, hb, pu));
  api.use('/families/:familyId', auth, messageRoutes(cfg, db, st, hb, pu));
  api.use('/families/:familyId', auth, familyMiscRoutes(cfg, db, st, hb));

  app.use('/api', api);
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
