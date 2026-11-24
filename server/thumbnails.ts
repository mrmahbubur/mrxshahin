import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';
import { getGeminiApiKey } from './env.ts';
import { escapeXml, validateExternalUrl, validateSlug } from './security.ts';

const THUMB_WIDTH = 1280;
const THUMB_HEIGHT = 720;
const MAX_SOURCE_IMAGE_BYTES = 5 * 1024 * 1024;

export const THUMBNAILS_DIR = path.resolve(process.cwd(), 'data', 'thumbnails');

function ensureThumbnailsDir(): void {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

export function getThumbnailCachePath(slug: string): string {
  const safeSlug = validateSlug(slug);
  ensureThumbnailsDir();
  const resolved = path.resolve(THUMBNAILS_DIR, `${safeSlug}.png`);
  if (!resolved.startsWith(THUMBNAILS_DIR + path.sep)) {
    throw new Error('Invalid thumbnail path');
  }
  return resolved;
}

export function saveThumbnailToDiskCache(slug: string, pngBuffer: Buffer): void {
  try {
    const cachePath = getThumbnailCachePath(slug);
    fs.writeFileSync(cachePath, pngBuffer);
  } catch (err) {
    console.warn('Unable to write thumbnail disk cache:', err);
  }
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return ['Untitled Dispatch'];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharsPerLine) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
        current = word;
      } else {
        lines.push(word.slice(0, maxCharsPerLine - 1) + '…');
        current = '';
      }
      if (lines.length === maxLines) {
        break;
      }
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  } else if (current && lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (last && !last.endsWith('…')) {
      lines[maxLines - 1] = last.slice(0, Math.max(4, maxCharsPerLine - 1)).trimEnd() + '…';
    }
  }

  return lines;
}

function pickPalette(seedInput: string, themeColor?: string | null): {
  bg1: string;
  bg2: string;
  accent: string;
} {
  const palettes = [
    { bg1: '#0F172A', bg2: '#1E293B', accent: '#3B82F6' },
    { bg1: '#14191F', bg2: '#232B35', accent: '#D97706' },
    { bg1: '#111827', bg2: '#1F2937', accent: '#10B981' },
    { bg1: '#18181B', bg2: '#27272A', accent: '#60A5FA' },
    { bg1: '#0C1421', bg2: '#1A273B', accent: '#F59E0B' },
  ];
  const hash = crypto.createHash('sha256').update(seedInput).digest();
  const base = palettes[hash[0] % palettes.length];
  if (themeColor && /^#[0-9a-fA-F]{6}$/.test(themeColor)) {
    return { ...base, accent: themeColor };
  }
  return base;
}

function buildFallbackBackgroundSvg(title: string, siteName: string, slug: string, themeColor?: string | null): string {
  const { bg1, bg2, accent } = pickPalette(`${siteName}:${slug}`, themeColor);
  const hash = crypto.createHash('sha256').update(slug || title).digest();
  const cx1 = 880 + (hash[1] % 260);
  const cy1 = 120 + (hash[2] % 180);
  const cx2 = 160 + (hash[3] % 220);
  const cy2 = 520 + (hash[4] % 140);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" viewBox="0 0 ${THUMB_WIDTH} ${THUMB_HEIGHT}">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${bg1}" />
        <stop offset="100%" stop-color="${bg2}" />
      </linearGradient>
      <radialGradient id="glow1" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.34" />
        <stop offset="100%" stop-color="${accent}" stop-opacity="0" />
      </radialGradient>
      <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
        <path d="M 64 0 L 0 0 0 64" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1" />
      </pattern>
    </defs>
    <rect width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" fill="url(#bgGrad)" />
    <rect width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" fill="url(#grid)" />
    <circle cx="${cx1}" cy="${cy1}" r="420" fill="url(#glow1)" />
    <circle cx="${cx2}" cy="${cy2}" r="320" fill="url(#glow1)" opacity="0.65" />
    <g stroke="rgba(255,255,255,0.09)" fill="none" stroke-width="1.5">
      <rect x="820" y="96" width="340" height="340" rx="8" />
      <rect x="860" y="136" width="260" height="260" rx="4" stroke="${accent}" stroke-opacity="0.35" />
      <line x1="72" y1="96" x2="540" y2="96" stroke="${accent}" stroke-opacity="0.55" stroke-width="2" />
    </g>
  </svg>`;
}

function buildTextOverlaySvg(title: string, siteName: string, themeColor?: string | null): string {
  const accent = themeColor && /^#[0-9a-fA-F]{6}$/.test(themeColor) ? themeColor : '#60A5FA';
  const lines = wrapLines(title, 38, 3);
  const lineHeight = 62;
  const blockHeight = lines.length * lineHeight;
  const startY = THUMB_HEIGHT - 86 - (blockHeight - lineHeight);
  const kickerY = startY - 48;

  const titleElements = lines
    .map((line, idx) => {
      const y = startY + idx * lineHeight;
      return `<text x="72" y="${y}" font-family="Georgia, 'Times New Roman', serif" font-size="50" font-weight="700" fill="#FFFFFF" letter-spacing="-0.8">${escapeXml(line)}</text>`;
    })
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" viewBox="0 0 ${THUMB_WIDTH} ${THUMB_HEIGHT}">
    <defs>
      <linearGradient id="scrim" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#090B10" stop-opacity="0.18" />
        <stop offset="45%" stop-color="#090B10" stop-opacity="0.48" />
        <stop offset="100%" stop-color="#090B10" stop-opacity="0.92" />
      </linearGradient>
    </defs>
    <rect width="${THUMB_WIDTH}" height="${THUMB_HEIGHT}" fill="url(#scrim)" />
    <rect x="72" y="${kickerY - 22}" width="38" height="3" fill="${accent}" />
    <text x="122" y="${kickerY - 14}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="22" font-weight="600" fill="#E4E4E7" letter-spacing="2.4">${escapeXml(siteName.toUpperCase().slice(0, 48))}</text>
    ${titleElements}
    <text x="72" y="${THUMB_HEIGHT - 36}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="18" font-weight="500" fill="#A1A1AA" letter-spacing="1.2">M R S AUTO BLOG</text>
  </svg>`;
}

async function fetchSafeSourceImageBuffer(rawUrl: string): Promise<Buffer | null> {
  try {
    const valid = validateExternalUrl(rawUrl);
    const res = await fetch(valid.toString(), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: {
        'User-Agent': 'MRSAutoBlogBot/1.0',
        Accept: 'image/png,image/jpeg,image/webp,image/*;q=0.8',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      },
    });
    if (!res.ok) return null;

    const finalUrl = res.url || valid.toString();
    validateExternalUrl(finalUrl);

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/') || contentType.includes('svg') || contentType.includes('icon')) {
      return null;
    }

    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_SOURCE_IMAGE_BYTES) return null;

    const arrBuf = await res.arrayBuffer();
    if (arrBuf.byteLength < 2048 || arrBuf.byteLength > MAX_SOURCE_IMAGE_BYTES) return null;

    const buf = Buffer.from(arrBuf);
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height || meta.width < 360 || meta.height < 200) {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

export async function buildFallbackThumbnailPng(
  title: string,
  siteName: string,
  slug: string,
  themeColor?: string | null
): Promise<Buffer> {
  try {
    const bgSvg = buildFallbackBackgroundSvg(title, siteName, slug, themeColor);
    const overlaySvg = buildTextOverlaySvg(title, siteName, themeColor);

    return await sharp(Buffer.from(bgSvg))
      .resize(THUMB_WIDTH, THUMB_HEIGHT)
      .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
      .png({ compressionLevel: 8 })
      .toBuffer();
  } catch {
    // Guaranteed emergency 16:9 PNG so no post is ever left without a valid PNG image
    return sharp({
      create: {
        width: THUMB_WIDTH,
        height: THUMB_HEIGHT,
        channels: 4,
        background: { r: 15, g: 23, b: 42, alpha: 1 },
      },
    })
      .png({ compressionLevel: 8 })
      .toBuffer();
  }
}

export async function generatePostThumbnail(options: {
  title: string;
  siteName: string;
  slug: string;
  themeColor?: string | null;
  sourceImageUrl?: string | null;
}): Promise<{ buffer: Buffer; usedAiImage: boolean; fallbackReason?: string }> {
  const ai = getAiClient();
  let baseImageBuffer: Buffer | null = null;
  let usedAiImage = false;
  let fallbackReason: string | undefined;

  // Tier 1: Gemini Image Generation
  if (ai) {
    try {
      const prompt = `Minimalist editorial background artwork representing the software and web theme of "${options.siteName}" and the update "${options.title}". Modern architectural shapes, clean light and shadow depth, subtle studio texture, rich muted color palette. Strictly no text, no letters, no words, no logos, no watermarks.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite-image',
        contents: { parts: [{ text: prompt }] },
        config: {
          abortSignal: AbortSignal.timeout(10000),
          imageConfig: {
            aspectRatio: '16:9',
          },
        },
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          baseImageBuffer = Buffer.from(part.inlineData.data, 'base64');
          usedAiImage = true;
          break;
        }
      }

      if (!baseImageBuffer) {
        fallbackReason = 'Gemini image response did not include inline image data';
      }
    } catch (err) {
      fallbackReason = err instanceof Error ? err.message : String(err);
    }
  } else {
    fallbackReason = 'GEMINI_API_KEY not configured';
  }

  // Tier 2: Source site's verified OG/hero image when AI image generation is unavailable
  if (!baseImageBuffer && options.sourceImageUrl) {
    const sourceImg = await fetchSafeSourceImageBuffer(options.sourceImageUrl);
    if (sourceImg) {
      baseImageBuffer = sourceImg;
    }
  }

  const overlaySvg = buildTextOverlaySvg(options.title, options.siteName, options.themeColor);

  if (baseImageBuffer) {
    try {
      const finalPng = await sharp(baseImageBuffer)
        .resize(THUMB_WIDTH, THUMB_HEIGHT, { fit: 'cover', position: 'center' })
        .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
        .png({ compressionLevel: 8 })
        .toBuffer();
      saveThumbnailToDiskCache(options.slug, finalPng);
      return { buffer: finalPng, usedAiImage, fallbackReason: usedAiImage ? undefined : fallbackReason };
    } catch (err) {
      usedAiImage = false;
      fallbackReason = `Sharp composite failed on background image: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Tier 3/4: Guaranteed bespoke editorial SVG/PNG fallback
  const finalPng = await buildFallbackThumbnailPng(options.title, options.siteName, options.slug, options.themeColor);
  saveThumbnailToDiskCache(options.slug, finalPng);
  return { buffer: finalPng, usedAiImage: false, fallbackReason };
}
