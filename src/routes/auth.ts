import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { COOKIE_NAME, HttpError, parse, requireAuth, setSessionCookie } from '../http.js';

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(100),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

// Compared against when the email does not exist, so timing does not reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export function authRoutes(cfg: Config, db: Db) {
  const r = Router();
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: process.env.NODE_ENV === 'test' ? 1000 : 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, please wait a minute' },
  });

  r.post('/register', limiter, async (req, res) => {
    const body = parse(registerSchema, req.body);
    const hash = await bcrypt.hash(body.password, 11);
    try {
      const { rows } = await db.query(
        'insert into users (email, password_hash, display_name) values ($1, $2, $3) returning id, email, display_name',
        [body.email, hash, body.displayName],
      );
      setSessionCookie(cfg, res, rows[0].id);
      res.status(201).json({ user: { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name } });
    } catch (err: any) {
      if (err?.code === '23505') throw new HttpError(409, 'An account with this email already exists');
      throw err;
    }
  });

  r.post('/login', limiter, async (req, res) => {
    const body = parse(loginSchema, req.body);
    const { rows } = await db.query(
      'select id, email, display_name, password_hash from users where lower(email) = $1',
      [body.email],
    );
    const ok = await bcrypt.compare(body.password, rows[0]?.password_hash ?? DUMMY_HASH);
    if (!rows[0] || !ok) throw new HttpError(401, 'Invalid email or password');
    setSessionCookie(cfg, res, rows[0].id);
    res.json({ user: { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name } });
  });

  r.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/', domain: cfg.cookieDomain });
    res.json({ ok: true });
  });

  r.get('/me', requireAuth(cfg, db), async (req, res) => {
    const { rows } = await db.query(
      `select f.id, f.name, f.tagline, f.accent_color, m.role, m.person_id
         from memberships m join families f on f.id = m.family_id
        where m.user_id = $1 order by m.joined_at`,
      [req.user!.id],
    );
    res.json({
      user: req.user,
      families: rows.map((f: any) => ({
        id: f.id, name: f.name, tagline: f.tagline, accentColor: f.accent_color,
        role: f.role, personId: f.person_id,
      })),
    });
  });

  return r;
}
