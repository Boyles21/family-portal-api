import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ZodError, type ZodType } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ROLE_RANK, type Role } from './types.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, what = 'id'): string {
  if (!UUID_RE.test(value)) throw new HttpError(404, `${what} not found`);
  return value;
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

export const COOKIE_NAME = 'fp_session';

export function signSession(cfg: Config, userId: string): string {
  return jwt.sign({ sub: userId }, cfg.jwtSecret, { expiresIn: '30d' });
}

export function setSessionCookie(cfg: Config, res: Response, userId: string) {
  res.cookie(COOKIE_NAME, signSession(cfg, userId), {
    httpOnly: true,
    sameSite: cfg.cookieSameSite,
    // Browsers require Secure with SameSite=None.
    secure: cfg.cookieSecure || cfg.cookieSameSite === 'none',
    domain: cfg.cookieDomain,
    maxAge: 30 * 24 * 3600 * 1000,
    path: '/',
  });
}

/** Blocks cross-site form/fetch abuse: unsafe requests must come from an allowed origin. */
export function originGuard(cfg: Config): RequestHandler {
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !cfg.allowedOrigins.includes(origin)) {
      return next(new HttpError(403, 'Origin not allowed'));
    }
    next();
  };
}

export function requireAuth(cfg: Config, db: Db): RequestHandler {
  return async (req, _res, next) => {
    try {
      const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined;
      const token = req.cookies?.[COOKIE_NAME] ?? bearer;
      if (!token) throw new HttpError(401, 'Please sign in');
      let sub: string;
      try {
        sub = (jwt.verify(token, cfg.jwtSecret) as jwt.JwtPayload).sub as string;
      } catch {
        throw new HttpError(401, 'Session expired, please sign in again');
      }
      const { rows } = await db.query('select id, email, display_name from users where id = $1', [sub]);
      if (!rows[0]) throw new HttpError(401, 'Please sign in');
      req.user = { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Tenant gate for every /families/:familyId/* route. Non-members get a 404 (not 403)
 * so the API never confirms that someone else's family exists.
 */
export function requireMember(db: Db, minRole: Role = 'member'): RequestHandler {
  return async (req, _res, next) => {
    try {
      const familyId = assertUuid(String(req.params.familyId), 'family');
      const { rows } = await db.query(
        'select role, person_id from memberships where family_id = $1 and user_id = $2',
        [familyId, req.user!.id],
      );
      if (!rows[0]) throw new HttpError(404, 'family not found');
      if (ROLE_RANK[rows[0].role as Role] < ROLE_RANK[minRole]) {
        throw new HttpError(403, 'You do not have permission to do that');
      }
      req.membership = {
        familyId,
        userId: req.user!.id,
        role: rows[0].role,
        personId: rows[0].person_id,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const atLeast = (m: { role: Role }, min: Role) => ROLE_RANK[m.role] >= ROLE_RANK[min];

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Invalid input',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (typeof err?.status === 'number' && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err?.status === 501) return res.status(501).json({ error: err.message });
  // Postgres: foreign key / check violation = the client sent a reference that is not allowed.
  if (err?.code === '23503' || err?.code === '23514') {
    return res.status(400).json({ error: 'That link is not allowed' });
  }
  if (err?.code === '23505') return res.status(409).json({ error: 'Already exists' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
}
