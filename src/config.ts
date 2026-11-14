export interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  /** Browser origins allowed to call the API (your frontend URL(s)). */
  allowedOrigins: string[];
  cookieSecure: boolean;
  cookieDomain?: string;
  /** 'lax' when frontend and API share a registrable domain; 'none' for separate domains (needs HTTPS). */
  cookieSameSite: 'lax' | 'none';
  s3?: {
    bucket: string;
    region: string;
    endpoint?: string; // e.g. https://<account>.r2.cloudflarestorage.com
    accessKeyId: string;
    secretAccessKey: string;
  };
  vapid?: { publicKey: string; privateKey: string; subject: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProd = env.NODE_ENV === 'production';
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters long');
  }
  if (!env.DATABASE_URL && env.NODE_ENV !== 'test') {
    throw new Error('DATABASE_URL is required (use your Neon pooled connection string)');
  }
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (isProd && allowedOrigins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must list your frontend URL(s) in production');
  }

  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? '',
    jwtSecret,
    allowedOrigins,
    cookieSecure: isProd,
    cookieDomain: env.COOKIE_DOMAIN || undefined,
    cookieSameSite: env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax',
    s3:
      env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            bucket: env.S3_BUCKET,
            region: env.S3_REGION ?? 'auto',
            endpoint: env.S3_ENDPOINT || undefined,
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
    vapid:
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
          }
        : undefined,
  };
}
