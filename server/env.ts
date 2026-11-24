import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeEnvironment {
  port: number;
  isProd: boolean;
  isRender: boolean;
  hasBuiltDist: boolean;
  distDir: string;
  adminPath: string;
  checkIntervalSeconds: number | null;
  checkIntervalMinutes: number;
  publicBaseUrl: string | null;
}

const RESERVED_ROUTE_PREFIXES = [
  '/api',
  '/post',
  '/category',
  '/thumbnails',
  '/health',
  '/robots.txt',
  '/sitemap.xml',
  '/rss.xml',
  '/assets',
  '/src',
];

const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

export function resolveAdminPath(rawValue = process.env.ADMIN_PATH): string {
  const raw = (rawValue || '/admin-mrs').trim();
  const collapsed = raw.replace(/\/+/g, '/');
  const withSlash = collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
  const normalized = withSlash.replace(/\/+$/, '');
  const validFormat = /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(normalized);
  if (!validFormat || normalized.length > 80) {
    return '/admin-mrs';
  }

  const lower = normalized.toLowerCase();
  const collides = RESERVED_ROUTE_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}/`)
  );
  if (collides) {
    return '/admin-mrs';
  }
  return normalized;
}

export function resolveRuntimeEnvironment(): RuntimeEnvironment {
  const rawPort = Number(process.env.PORT || 3000);
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? Math.floor(rawPort) : 3000;

  const distDir = path.resolve(process.cwd(), 'dist');
  const hasBuiltDist = fs.existsSync(path.join(distDir, 'index.html'));
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  const isRender = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  const isTsxRuntime =
    process.execArgv.some((arg) => arg.includes('tsx')) || process.env.npm_lifecycle_event === 'dev';

  let isProd: boolean;
  if (nodeEnv === 'production') {
    isProd = true;
  } else if (nodeEnv === 'development' || nodeEnv === 'test') {
    isProd = false;
  } else {
    isProd = isRender || (hasBuiltDist && !isTsxRuntime);
  }

  const rawSeconds = Number(process.env.CHECK_INTERVAL_SECONDS || 0);
  const checkIntervalSeconds =
    Number.isFinite(rawSeconds) && rawSeconds >= 15 ? Math.floor(rawSeconds) : null;

  const rawMinutes = Number(process.env.CHECK_INTERVAL_MINUTES || 1);
  const checkIntervalMinutes =
    Number.isFinite(rawMinutes) && rawMinutes >= 1 ? Math.floor(rawMinutes) : 1;

  const rawBaseUrl =
    process.env.SITE_URL?.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    '';
  const publicBaseUrl = rawBaseUrl ? rawBaseUrl.replace(/\/+$/, '') : null;

  return {
    port,
    isProd,
    isRender,
    hasBuiltDist,
    distDir,
    adminPath: resolveAdminPath(),
    checkIntervalSeconds,
    checkIntervalMinutes,
    publicBaseUrl,
  };
}

export function getGeminiApiKey(): string {
  return process.env.GEMINI_API_KEY?.trim() || '';
}

export function getDatabaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || '';
}

export function getAdminPassword(): string {
  return process.env.ADMIN_PASSWORD?.trim() || '';
}

export function getGithubToken(): string {
  return process.env.GITHUB_TOKEN?.trim() || '';
}

export function getSessionSecret(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  return configured && configured.length >= 16 ? configured : EPHEMERAL_SESSION_SECRET;
}
