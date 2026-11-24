import crypto from 'node:crypto';
import net from 'node:net';
import sanitizeHtml from 'sanitize-html';
import { getSessionSecret } from './env.ts';

export function sanitizePostHtml(rawHtml: string): string {
  return sanitizeHtml(rawHtml, {
    allowedTags: [
      'h2',
      'h3',
      'h4',
      'p',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'strong',
      'b',
      'em',
      'i',
      'a',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'hr',
      'br',
      'figure',
      'figcaption',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      h2: ['id'],
      h3: ['id'],
      h4: ['id'],
      code: ['class'],
    },
    allowedSchemes: ['http', 'https'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href || '#';
        const isExternal = href.startsWith('http://') || href.startsWith('https://');
        return {
          tagName,
          attribs: {
            href,
            ...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
          },
        };
      },
    },
  });
}

export function validateSlug(slug: string): string {
  const cleaned = slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned) || cleaned.length > 140) {
    throw new Error('Invalid slug format');
  }
  return cleaned;
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  return base || `dispatch-${Date.now()}`;
}

function isPrivateOrBlockedIp(ip: string): boolean {
  if (!net.isIP(ip)) return false;

  if (ip === '::1' || ip === '::' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) {
    return true;
  }

  // Handle IPv4-mapped IPv6
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!net.isIPv4(v4)) return false;

  const parts = v4.split('.').map(Number);
  if (parts.length !== 4) return true;
  const [a, b] = parts;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

const BLOCKED_EXTERNAL_PORTS = new Set([
  '21',
  '22',
  '23',
  '25',
  '110',
  '135',
  '137',
  '138',
  '139',
  '143',
  '445',
  '3306',
  '5432',
  '6379',
  '27017',
]);

export function validateExternalUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Embedded credentials in external URLs are not allowed');
  }

  if (parsed.port && BLOCKED_EXTERNAL_PORTS.has(parsed.port)) {
    throw new Error(`Blocked port: ${parsed.port}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal' ||
    isPrivateOrBlockedIp(hostname)
  ) {
    throw new Error(`Blocked host: ${hostname}`);
  }

  return parsed;
}

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'ref',
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'wickedid',
  'vero_id',
  's_kwcid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_enc_id',
  'oly_anon_id',
  'si',
  'spm',
  'scm',
  '_cb',
]);

const TRACKING_PARAM_PREFIXES = ['utm_', 'ga_', 'hsa_', 'pk_', 'mtm_'];

function isTrackingQueryParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_QUERY_PARAMS.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function normalizeExternalUrl(rawUrl: string): string {
  const parsed = validateExternalUrl(rawUrl);
  parsed.hash = '';
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (isTrackingQueryParam(key)) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  parsed.searchParams.sort();
  const str = parsed.toString();
  return str.endsWith('/') && parsed.pathname === '/' ? str.slice(0, -1) : str;
}

function stripInternalCacheBuster(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.searchParams.delete('_cb');
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export async function safeFetchText(
  rawUrl: string,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
    retries?: number;
    cacheBust?: boolean;
  } = {}
): Promise<{ text: string; finalUrl: string; status: number; contentType: string }> {
  const timeoutMs = options.timeoutMs ?? 12000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const retries = options.retries ?? 2;
  const cacheBust = options.cacheBust ?? true;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const validated = validateExternalUrl(rawUrl);
      const fetchTarget = new URL(validated.toString());
      if (cacheBust) {
        fetchTarget.searchParams.set('_cb', `${Date.now()}-${attempt}`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(fetchTarget.toString(), {
          method: 'GET',
          cache: 'no-store',
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; MRSAutoBlogBot/1.0; +https://mrxshahin.ai.studio)',
            Accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
            'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0',
            ...(options.headers ?? {}),
          },
        });

        // Verify final redirected URL is also safe
        if (res.url) {
          validateExternalUrl(res.url);
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }

        const contentLength = Number(res.headers.get('content-length') || '0');
        if (contentLength > maxBytes) {
          throw new Error(`Response exceeded max size (${maxBytes} bytes)`);
        }

        const cleanFinalUrl = stripInternalCacheBuster(res.url || validated.toString());

        const reader = res.body?.getReader();
        if (!reader) {
          const text = await res.text();
          return {
            text: text.slice(0, maxBytes),
            finalUrl: cleanFinalUrl,
            status: res.status,
            contentType: res.headers.get('content-type') || '',
          };
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > maxBytes) {
              reader.cancel().catch(() => {});
              break;
            }
            chunks.push(value);
          }
        }

        const buffer = Buffer.concat(chunks);
        return {
          text: buffer.toString('utf8'),
          finalUrl: cleanFinalUrl,
          status: res.status,
          contentType: res.headers.get('content-type') || '',
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const [salt, expectedHex] = stored.split(':');
  if (!salt || !expectedHex) return false;
  const actualBuf = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export function verifyEnvPassword(candidate: string, envPassword: string): boolean {
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(envPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

export function signSessionToken(): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt, nonce })).toString('base64url');
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, expiresAt };
}

export function verifySessionToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (!payload || !sig) return false;

  const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof decoded.exp === 'number' && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
