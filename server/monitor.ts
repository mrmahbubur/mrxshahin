import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import {
  addLog,
  countPostsForSite,
  getLatestSnapshot,
  getSetting,
  getSiteById,
  hasPostWithChangeHash,
  listActiveSites,
  saveSnapshot,
  setSetting,
  updateSiteDiscoveredMetadata,
  updateSiteStatus,
  upsertHubSite,
} from './db.ts';
import { getGithubToken } from './env.ts';
import { generateAndSavePostFromReport } from './generator.ts';
import { normalizeExternalUrl, safeFetchText } from './security.ts';
import type {
  ChangeReport,
  GithubActivity,
  GithubCommitEntry,
  GithubReleaseEntry,
  HeadingItem,
  ImageItem,
  LinkItem,
  RssEntry,
  SiteRecord,
  SnapshotRecord,
} from './types.ts';

const DEFAULT_HUB_URL = 'https://mrxshahin.ai.studio';

const IGNORED_HUB_DOMAINS = new Set([
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'discord.gg',
  'discord.com',
  't.me',
  'gravatar.com',
  'bsky.app',
  'mastodon.social',
  'threads.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'w3.org',
  'schema.org',
  'uplcm.com',
  's0.wp.com',
  's.wordpress.com',
  'api.microlink.io',
  'www.google.com',
  'google.com',
  'mail.google.com',
  'calendly.com',
  'goodreads.com',
  'www.goodreads.com',
  'react.dev',
  'vite.dev',
  'vitejs.dev',
  'developer.mozilla.org',
  'npmjs.com',
  'www.npmjs.com',
  'cloudflare.com',
]);

let checkInProgress = false;

export function isCheckRunning(): boolean {
  return checkInProgress;
}

const normalizeUrl = normalizeExternalUrl;

const UPPERCASE_SITE_TOKENS = new Set([
  'ai',
  'api',
  'apk',
  'iptv',
  'it',
  'mrs',
  'rss',
  'seo',
  'tv',
  'ui',
  'ux',
]);

function deriveSiteName(anchorText: string, siteUrl: string): string {
  const cleaned = anchorText
    .replace(/[→↗◀▶›»]+/g, ' ')
    .replace(/\s+\d{6,}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const genericWords = new Set(['visit', 'open', 'launch', 'view', 'live', 'demo', 'website', 'link', 'here', 'app', 'try']);
  if (cleaned.length >= 3 && cleaned.length <= 55 && !genericWords.has(cleaned.toLowerCase())) {
    return cleaned;
  }
  try {
    const host = new URL(siteUrl).hostname.replace(/^www\./, '');
    const firstPart = (host.split('.')[0] || host).replace(/-\d{6,}$/, '');
    const formatted = firstPart
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => {
        const lower = w.toLowerCase();
        if (UPPERCASE_SITE_TOKENS.has(lower)) {
          return lower === 'mrs' ? 'Mrs' : lower.toUpperCase();
        }
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(' ');
    return formatted || host;
  } catch {
    return siteUrl;
  }
}

export function normalizeTextForDiff(raw: string): string {
  return raw
    // Strip ISO dates and common timestamps
    .replace(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g, ' ')
    // Strip relative time strings ("5 minutes ago", "2 hours ago")
    .replace(/\b\d+\s+(?:second|seconds|minute|minutes|hour|hours|day|days|week|weeks)\s+ago\b/gi, ' ')
    // Strip copyright years
    .replace(/©\s*20\d{2}(?:\s*-\s*20\d{2})?/g, ' ')
    // Strip simple visitor/view counters
    .replace(/\b\d[\d,]*\s+(?:views|visitors|online|reads|hits)\b/gi, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function extractThemeColor($: cheerio.CheerioAPI): string | null {
  const metaTheme = $('meta[name="theme-color"]').attr('content')?.trim();
  if (metaTheme && /^#[0-9a-fA-F]{6}$/.test(metaTheme)) {
    return metaTheme;
  }
  return null;
}

const NOISE_HEADINGS = new Set([
  'search this blog',
  'pages',
  'posts',
  'pinned post',
  'report abuse',
  'archive',
  'labels',
  'menu',
  'navigation',
  'cookie notice',
]);

function collectJsonLdNodes(rawJson: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4 || !rawJson || typeof rawJson !== 'object') return [];
  if (Array.isArray(rawJson)) {
    return rawJson.flatMap((entry) => collectJsonLdNodes(entry, depth + 1));
  }
  const obj = rawJson as Record<string, unknown>;
  const collected: Record<string, unknown>[] = [obj];

  for (const nestedKey of ['@graph', 'mainEntity', 'about', 'hasPart', 'itemListElement']) {
    const child = obj[nestedKey];
    if (child && typeof child === 'object') {
      collected.push(...collectJsonLdNodes(child, depth + 1));
    }
  }
  if (obj.item && typeof obj.item === 'object') {
    collected.push(...collectJsonLdNodes(obj.item, depth + 1));
  }
  return collected;
}

function extractJsonLdSignals($: cheerio.CheerioAPI): {
  facts: string[];
  sameAsUrls: string[];
  fallbackTitle: string;
  fallbackDescription: string;
} {
  const facts: string[] = [];
  const sameAsUrls: string[] = [];
  let fallbackTitle = '';
  let fallbackDescription = '';

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const nodes = collectJsonLdNodes(parsed);
      for (const node of nodes) {
        const headline =
          typeof node.headline === 'string'
            ? node.headline.trim()
            : typeof node.name === 'string'
              ? node.name.trim()
              : '';
        const description =
          typeof node.description === 'string'
            ? node.description.trim()
            : typeof node.abstract === 'string'
              ? node.abstract.trim()
              : '';

        if (!fallbackTitle && headline) fallbackTitle = headline;
        if (!fallbackDescription && description) fallbackDescription = description;

        if (headline && description && headline.toLowerCase() !== description.toLowerCase()) {
          facts.push(`${headline}: ${description}`);
        } else if (description) {
          facts.push(description);
        }

        if (typeof node.applicationCategory === 'string' && node.applicationCategory.trim()) {
          const os = typeof node.operatingSystem === 'string' && node.operatingSystem.trim()
            ? ` (${node.operatingSystem.trim()})`
            : '';
          const ver = typeof node.softwareVersion === 'string' && node.softwareVersion.trim()
            ? ` v${node.softwareVersion.trim()}`
            : '';
          facts.push(`Application category: ${node.applicationCategory.trim()}${os}${ver}`);
        }

        if (Array.isArray(node.featureList)) {
          for (const f of node.featureList) {
            if (typeof f === 'string' && f.trim()) facts.push(f.trim());
          }
        } else if (typeof node.featureList === 'string' && node.featureList.trim()) {
          facts.push(node.featureList.trim());
        }

        if (Array.isArray(node.knowsAbout)) {
          const topics = node.knowsAbout.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
          if (topics.length > 0) facts.push(`Focus areas: ${topics.join(', ')}`);
        }

        if (Array.isArray(node.keywords)) {
          const kw = node.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0);
          if (kw.length > 0) facts.push(`Keywords: ${kw.join(', ')}`);
        } else if (typeof node.keywords === 'string' && node.keywords.trim()) {
          facts.push(`Keywords: ${node.keywords.trim()}`);
        }

        if (Array.isArray(node.sameAs)) {
          for (const item of node.sameAs) {
            if (typeof item === 'string' && item.trim()) sameAsUrls.push(item.trim());
          }
        } else if (typeof node.sameAs === 'string' && node.sameAs.trim()) {
          sameAsUrls.push(node.sameAs.trim());
        }
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  });

  const normalizedSameAs = sameAsUrls
    .map((url) => {
      try {
        return normalizeUrl(url);
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  return {
    facts: Array.from(new Set(facts.map((f) => f.replace(/\s+/g, ' ').trim()).filter(Boolean))),
    sameAsUrls: Array.from(new Set(normalizedSameAs)),
    fallbackTitle,
    fallbackDescription,
  };
}

function extractPageSignals(html: string, baseUrl: string): {
  title: string;
  metaDescription: string;
  headings: HeadingItem[];
  mainText: string;
  links: LinkItem[];
  images: ImageItem[];
  navItems: string[];
  discoveredRssUrl: string | null;
  discoveredSitemapUrl: string | null;
  themeColor: string | null;
} {
  const $ = cheerio.load(html);
  const themeColor = extractThemeColor($);

  const jsonLd = extractJsonLdSignals($);

  const title = (
    $('title').first().text() ||
    $('meta[property="og:title"]').attr('content') ||
    jsonLd.fallbackTitle ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  const metaDescription = (
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    jsonLd.fallbackDescription ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();

  // Discover feed/sitemap links
  let discoveredRssUrl: string | null = null;
  $('link[rel="alternate"]').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    const href = $(el).attr('href');
    if (href && (type.includes('rss') || type.includes('atom') || type.includes('xml'))) {
      try {
        discoveredRssUrl = normalizeUrl(new URL(href, baseUrl).toString());
      } catch {
        // ignore invalid/blocked href
      }
    }
  });

  let discoveredSitemapUrl: string | null = null;
  $('link[rel="sitemap"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      try {
        discoveredSitemapUrl = normalizeUrl(new URL(href, baseUrl).toString());
      } catch {
        // ignore invalid/blocked href
      }
    }
  });

  // Nav items
  const navSet = new Set<string>();
  $('header a, nav a').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && t.length <= 45) navSet.add(t);
  });

  // Headings (exclude sidebar/nav/footer widget chrome)
  const headings: HeadingItem[] = [];
  const seenHeadings = new Set<string>();
  $('h1, h2, h3').each((_, el) => {
    if ($(el).closest('nav, aside, footer, .sidebar, #sidebar, [role="complementary"]').length > 0) {
      return;
    }
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const level = el.tagName.toLowerCase();
    const key = `${level}:${text}`;
    if (text && text.length <= 180 && !NOISE_HEADINGS.has(text.toLowerCase()) && !seenHeadings.has(key)) {
      seenHeadings.add(key);
      headings.push({ level, text });
    }
  });

  // Images (prioritize og:image / twitter:image for rich hero artwork)
  const images: ImageItem[] = [];
  const seenImgs = new Set<string>();
  const metaHero =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[property="twitter:image"]').attr('content');
  if (metaHero && !metaHero.startsWith('data:')) {
    try {
      const abs = normalizeUrl(new URL(metaHero, baseUrl).toString());
      seenImgs.add(abs);
      images.push({ src: abs, alt: title || 'Site preview' });
    } catch {
      // ignore invalid/blocked meta image
    }
  }

  $('img').each((_, el) => {
    const src = $(el).attr('src');
    const alt = ($(el).attr('alt') || '').replace(/\s+/g, ' ').trim();
    if (src && !src.startsWith('data:')) {
      try {
        const abs = normalizeUrl(new URL(src, baseUrl).toString());
        if (!seenImgs.has(abs)) {
          seenImgs.add(abs);
          images.push({ src: abs, alt });
        }
      } catch {
        // ignore invalid/blocked image URL
      }
    }
  });

  // Links
  const links: LinkItem[] = [];
  const seenLinks = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      return;
    }
    try {
      const abs = normalizeUrl(new URL(href, baseUrl).toString());
      if (!seenLinks.has(abs)) {
        seenLinks.add(abs);
        links.push({ href: abs, text: text.slice(0, 100) });
      }
    } catch {
      // ignore invalid/blocked URLs
    }
  });

  const metaKeywords = ($('meta[name="keywords"]').attr('content') || '').replace(/\s+/g, ' ').trim();
  const structuredFacts = jsonLd.facts;

  // Remove non-content, form, modal, cookie, share, comment & ad/script chrome before extracting main text
  $(
    'form, script, style, noscript, svg, iframe, template, canvas, dialog, [aria-hidden="true"], [role="dialog"], [role="alert"], .ads, .ad-banner, [id*="cookie"], [class*="cookie"], .cookie-banner, .consent, .share-buttons, .post-share-buttons, .blog-pager, #comments, .comments'
  ).remove();

  const mainRoot = $('main, article, [role="main"]').first();
  const rawMainText = (mainRoot.length ? mainRoot.text() : $('body').text()) || '';
  let mainText = normalizeTextForDiff(rawMainText)
    .replace(/\bPlease Wait \d+ Seconds Download now with upload apk for free\b/gi, ' ')
    .replace(/\bEnglish(?:\s+English)?\s+Sign In\s+Sign Up\b/gi, ' ')
    .replace(/\bShare\s+Report\s+©?\s*Upload APK\s*-\s*All rights reserved\.?/gi, ' ')
    .replace(/\bShare\s+Post a Comment\s+Read more\b/gi, ' ')
    .replace(/\bSubscribe to:\s*Posts\s*\(Atom\)/gi, ' ')
    .replace(/\bPowered by Blogger\.?/gi, ' ')
    .replace(/\bReport Abuse\b/gi, ' ')
    .replace(/\bMore posts\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30000);
  if (mainText.length < 180 || structuredFacts.length > 0) {
    const isGenericUploadHost = /free apk hosting service for upload and download apps/i.test(metaDescription);
    const cleanedMeta = isGenericUploadHost ? '' : metaDescription;
    const fallbackStructured = Array.from(
      new Set(
        [cleanedMeta, ...structuredFacts, !isGenericUploadHost && metaKeywords ? `Focus & Topics: ${metaKeywords}` : '']
          .map((s) => s.trim())
          .filter(Boolean)
      )
    ).join(' ');
    if (fallbackStructured) {
      const baseText = isGenericUploadHost
        ? mainText
            .replace(/Free APK hosting service for Upload and Download apps[^.]*\./gi, ' ')
            .replace(/Offers integration solutions for uploading apks[^.]*\./gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : mainText;
      mainText = normalizeTextForDiff(
        baseText.length < 80 ? fallbackStructured : `${baseText} ${fallbackStructured}`
      ).slice(0, 30000);
    }
  }

  return {
    title,
    metaDescription,
    headings: headings.slice(0, 80),
    mainText,
    links: links.slice(0, 120),
    images: images.slice(0, 40),
    navItems: Array.from(navSet).slice(0, 40),
    discoveredRssUrl,
    discoveredSitemapUrl,
    themeColor,
  };
}

function isReadableSpaSentence(raw: string): boolean {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s.length < 18 || s.length > 360) return false;
  if (/^https?:\/\//i.test(s) || /^[\w./:-]+$/.test(s)) return false;
  if (/[{}[\];=<>]/.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length < 3) return false;
  return /[a-zA-Z]{3,}/.test(s);
}

async function enrichSpaSignals(
  html: string,
  canonicalPageUrl: string,
  signals: ReturnType<typeof extractPageSignals>
): Promise<void> {
  if (signals.mainText.length >= 450 && signals.headings.length >= 3) {
    return;
  }

  const $ = cheerio.load(html);
  const pageHost = new URL(canonicalPageUrl).hostname.toLowerCase();
  const extraParagraphs: string[] = [];
  const extraHeadings: string[] = [];

  // 1. Inspect Web App Manifest for official app description & shortcuts
  const manifestHref = $('link[rel="manifest"]').attr('href') || '/manifest.webmanifest';
  try {
    const manifestUrl = normalizeUrl(new URL(manifestHref, canonicalPageUrl).toString());
    if (new URL(manifestUrl).hostname.toLowerCase() === pageHost) {
      const mRes = await safeFetchText(manifestUrl, {
        timeoutMs: 7000,
        retries: 0,
        maxBytes: 150_000,
        cacheBust: true,
      });
      const manifest = JSON.parse(mRes.text) as {
        name?: string;
        description?: string;
        shortcuts?: Array<{ name?: string; description?: string }>;
      };
      if (manifest.description && isReadableSpaSentence(manifest.description)) {
        extraParagraphs.push(manifest.description);
      }
      if (Array.isArray(manifest.shortcuts)) {
        for (const sc of manifest.shortcuts.slice(0, 8)) {
          if (sc.name && sc.name.trim().length >= 3) extraHeadings.push(sc.name.trim());
          if (sc.description && isReadableSpaSentence(sc.description)) extraParagraphs.push(sc.description);
        }
      }
    }
  } catch {
    // ignore missing or unparseable manifest
  }

  // 2. Inspect module script bundle(s) if static HTML was a minimal SPA shell
  if (signals.mainText.length < 350) {
    const scriptUrls: string[] = [];
    $('script[type="module"][src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      try {
        const abs = normalizeUrl(new URL(src, canonicalPageUrl).toString());
        if (new URL(abs).hostname.toLowerCase() === pageHost && !scriptUrls.includes(abs)) {
          scriptUrls.push(abs);
        }
      } catch {
        // ignore invalid script src
      }
    });

    for (const scriptUrl of scriptUrls.slice(0, 2)) {
      try {
        const jsRes = await safeFetchText(scriptUrl, {
          timeoutMs: 12000,
          retries: 0,
          maxBytes: 1_500_000,
          cacheBust: true,
        });
        const jsText = jsRes.text;

        const fieldRe =
          /(?:title|headline|subtitle|description|summary|tagline|speechNarrative|label)\s*:\s*"([^"\\]{6,320})"/g;
        let m: RegExpExecArray | null;
        while ((m = fieldRe.exec(jsText)) !== null && extraParagraphs.length < 24) {
          const val = m[1].replace(/\s+/g, ' ').trim();
          if (/^(title|description|summary|label|placeholder|loading)/i.test(val)) continue;
          if (val.length <= 75 && /^[A-Za-z0-9\s&/+\-–—:.]+$/.test(val) && val.split(/\s+/).length >= 2) {
            if (!extraHeadings.includes(val)) extraHeadings.push(val);
          } else if (isReadableSpaSentence(val)) {
            extraParagraphs.push(val);
          }
        }
      } catch {
        // ignore unreachable or oversized SPA bundle
      }
    }
  }

  const existingHeadingSet = new Set(signals.headings.map((h) => h.text.toLowerCase()));
  for (const h of extraHeadings.slice(0, 14)) {
    if (!existingHeadingSet.has(h.toLowerCase())) {
      existingHeadingSet.add(h.toLowerCase());
      signals.headings.push({ level: 'h2', text: h });
    }
  }

  const dedupedCopy = Array.from(new Set(extraParagraphs.map((p) => p.trim()).filter(Boolean))).join('. ');
  if (dedupedCopy) {
    signals.mainText = normalizeTextForDiff(
      signals.mainText ? `${signals.mainText}. ${dedupedCopy}` : dedupedCopy
    ).slice(0, 30000);
  }
}

function inferGithubRepoFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (host.endsWith('.github.io') && parts.length >= 1) {
      const owner = host.slice(0, -'.github.io'.length);
      const repo = parts[0];
      if (owner && repo) return `${owner}/${repo}`;
    }
    if ((host === 'github.com' || host === 'www.github.com') && parts.length >= 2) {
      return `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
    }
  } catch {
    // ignore invalid URL
  }
  return null;
}

async function fetchSitemapUrls(sitemapUrl: string, depth = 0): Promise<string[]> {
  try {
    const normalizedTarget = normalizeUrl(sitemapUrl);
    const res = await safeFetchText(normalizedTarget, { timeoutMs: 8000, retries: 1, cacheBust: true });
    const $ = cheerio.load(res.text, { xmlMode: true });
    const seen = new Set<string>();
    const urls: string[] = [];
    const childSitemaps: string[] = [];

    $('url > loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (!loc) return;
      try {
        const normalizedLoc = normalizeUrl(new URL(loc, res.finalUrl).toString());
        if (!seen.has(normalizedLoc)) {
          seen.add(normalizedLoc);
          urls.push(normalizedLoc);
        }
      } catch {
        // ignore invalid or blocked sitemap entry
      }
    });

    $('sitemap > loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (!loc) return;
      try {
        const normalizedLoc = normalizeUrl(new URL(loc, res.finalUrl).toString());
        if (normalizedLoc !== normalizedTarget && !childSitemaps.includes(normalizedLoc)) {
          childSitemaps.push(normalizedLoc);
        }
      } catch {
        // ignore invalid or blocked child sitemap entry
      }
    });

    if (depth < 1 && childSitemaps.length > 0) {
      const nestedResults = await Promise.allSettled(
        childSitemaps.slice(0, 3).map((childUrl) => fetchSitemapUrls(childUrl, depth + 1))
      );
      for (const result of nestedResults) {
        if (result.status === 'fulfilled') {
          for (const nestedUrl of result.value) {
            if (!seen.has(nestedUrl)) {
              seen.add(nestedUrl);
              urls.push(nestedUrl);
            }
          }
        }
      }
    }

    if (urls.length === 0) {
      for (const childUrl of childSitemaps) {
        if (!seen.has(childUrl)) {
          seen.add(childUrl);
          urls.push(childUrl);
        }
      }
    }

    return urls.slice(0, 200);
  } catch {
    return [];
  }
}

async function fetchRssItems(rssUrl: string): Promise<RssEntry[]> {
  try {
    const normalizedTarget = normalizeUrl(rssUrl);
    const res = await safeFetchText(normalizedTarget, { timeoutMs: 8000, retries: 1, cacheBust: true });
    const $ = cheerio.load(res.text, { xmlMode: true });
    const items: RssEntry[] = [];

    const normalizeFeedLink = (rawLink: string): string => {
      const trimmed = rawLink.trim();
      if (!trimmed) return '';
      try {
        return normalizeUrl(new URL(trimmed, res.finalUrl).toString());
      } catch {
        return '';
      }
    };

    $('item').each((_, el) => {
      const title = $(el).find('title').first().text().trim();
      const link = normalizeFeedLink($(el).find('link').first().text());
      const pubDate = $(el).find('pubDate').first().text().trim();
      const desc = $(el).find('description').first().text().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (title) {
        items.push({ title, link, pubDate, summary: desc.slice(0, 400) });
      }
    });

    if (items.length === 0) {
      $('entry').each((_, el) => {
        const title = $(el).find('title').first().text().trim();
        const link = normalizeFeedLink($(el).find('link').first().attr('href') || '');
        const pubDate = $(el).find('updated, published').first().text().trim();
        const desc = $(el).find('summary, content').first().text().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (title) {
          items.push({ title, link, pubDate, summary: desc.slice(0, 400) });
        }
      });
    }

    return items.slice(0, 25);
  } catch {
    return [];
  }
}

function parseGithubRepoSlug(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase().endsWith('github.com')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchGithubActivity(githubRepoRaw: string): Promise<GithubActivity | null> {
  const repoSlug = parseGithubRepoSlug(githubRepoRaw);
  if (!repoSlug) return null;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  const token = getGithubToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const releasesRes = await safeFetchText(`https://api.github.com/repos/${repoSlug}/releases?per_page=5`, {
      timeoutMs: 8000,
      retries: 1,
      headers,
      cacheBust: true,
    });

    const releases: GithubReleaseEntry[] = [];
    const data = JSON.parse(releasesRes.text) as Array<{
      tag_name?: string;
      name?: string;
      body?: string;
      published_at?: string;
      html_url?: string;
    }>;
    if (Array.isArray(data)) {
      for (const r of data) {
        if (r.tag_name) {
          releases.push({
            tagName: r.tag_name,
            name: r.name || r.tag_name,
            body: (r.body || '').slice(0, 600),
            publishedAt: r.published_at || '',
            url: r.html_url || '',
          });
        }
      }
    }

    return { commits: [], releases };
  } catch {
    return null;
  }
}

function computeSnapshotHash(data: {
  title: string;
  metaDescription: string;
  headings: HeadingItem[];
  mainText: string;
  navItems: string[];
  sitemapUrls: string[];
  rssItems: RssEntry[];
  githubData: GithubActivity | null;
}): string {
  const canonical = JSON.stringify({
    title: data.title,
    metaDescription: data.metaDescription,
    headings: data.headings.map((h) => `${h.level}:${h.text}`),
    mainText: data.mainText,
    navItems: data.navItems,
    sitemapUrls: [...data.sitemapUrls].sort(),
    rssTitles: data.rssItems.map((r) => `${r.title}|${r.link}`),
    githubReleases: data.githubData?.releases.map((r) => r.tagName) ?? [],
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function tokenJaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function isSystemicPagePath(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();
  return /\/(manifest|sitemap|robots|feed|rss|favicon|sw\.js|service-worker|workbox|assets\/|static-data\/|\.well-known\/)/.test(
    lower
  );
}

function buildChangeReport(
  site: SiteRecord,
  previous: SnapshotRecord | null,
  current: Omit<SnapshotRecord, 'id' | 'createdAt'>,
  siteHasAnyPosts: boolean
): ChangeReport {
  if (!previous) {
    const wordCount = current.mainText.split(/\s+/).filter(Boolean).length;
    const hasSubstance =
      wordCount >= 10 ||
      (current.metaDescription.length >= 20 && current.title.length >= 4) ||
      current.headings.length >= 2 ||
      current.rssItems.length > 0 ||
      (current.githubData?.releases.length ?? 0) > 0;

    const meaningful = !siteHasAnyPosts && hasSubstance;
    const changeHash = crypto
      .createHash('sha256')
      .update(`initial:${site.id}:${current.contentHash}`)
      .digest('hex');

    return {
      siteId: site.id,
      siteName: site.name,
      siteUrl: site.url,
      isInitial: true,
      meaningful,
      reason: meaningful
        ? `Featured launch & capabilities on ${site.name}`
        : 'Initial snapshot stored (awaiting richer public features or content)',
      changeHash,
      newPages: current.sitemapUrls.filter((u) => !isSystemicPagePath(u)).slice(0, 20),
      removedPages: [],
      newHeadings: current.headings.map((h) => h.text).slice(0, 20),
      removedHeadings: [],
      newNavItems: current.navItems,
      newLinks: current.links.slice(0, 20),
      newRssItems: current.rssItems.slice(0, 10),
      newGithubCommits: [],
      newGithubReleases: current.githubData?.releases ?? [],
      beforeSummary: '',
      afterSummary: current.metaDescription || current.title,
      textDiffSnippet: current.mainText.slice(0, 600),
      currentTitle: current.title,
      currentMetaDescription: current.metaDescription,
      currentHeadings: current.headings,
      currentMainTextExcerpt: current.mainText.slice(0, 6000),
      heroImageUrl: current.images[0]?.src ?? null,
    };
  }

  const prevSitemaps = new Set(previous.sitemapUrls);
  const newPages = current.sitemapUrls.filter((u) => !prevSitemaps.has(u) && !isSystemicPagePath(u));
  const removedPages: string[] = [];

  const prevHeadings = new Set(previous.headings.map((h) => h.text));
  const currHeadings = new Set(current.headings.map((h) => h.text));
  const newHeadings = current.headings
    .map((h) => h.text)
    .filter((t) => !prevHeadings.has(t) && t.length >= 6);
  const removedHeadings = previous.headings.map((h) => h.text).filter((t) => !currHeadings.has(t));

  const prevNav = new Set(previous.navItems);
  const newNavItems = current.navItems.filter((n) => !prevNav.has(n));

  const prevLinks = new Set(previous.links.map((l) => l.href));
  const newLinks = current.links.filter((l) => !prevLinks.has(l.href));

  const prevRssKeys = new Set(previous.rssItems.map((r) => `${r.title}|${r.link}`));
  const newRssItems = current.rssItems.filter((r) => !prevRssKeys.has(`${r.title}|${r.link}`));

  const hadGithubHistory = Boolean(previous.githubData);
  const newGithubCommits: GithubCommitEntry[] = [];

  const prevReleaseTags = new Set(previous.githubData?.releases.map((r) => r.tagName) ?? []);
  const newGithubReleases = hadGithubHistory
    ? (current.githubData?.releases ?? []).filter((r) => !prevReleaseTags.has(r.tagName))
    : [];

  const textSimilarity = tokenJaccardSimilarity(previous.mainText, current.mainText);
  const titleChanged = previous.title !== current.title && current.title.length > 0;
  const metaChanged = previous.metaDescription !== current.metaDescription && current.metaDescription.length > 0;

  // Meaningful user-facing update criteria (ignores GitHub commits, systemic refactors, and trivial copy shifts)
  const significantTextShift =
    textSimilarity < 0.85 && Math.abs(current.mainText.length - previous.mainText.length) > 180;
  const meaningful =
    newRssItems.length > 0 ||
    newGithubReleases.length > 0 ||
    newPages.length > 0 ||
    newHeadings.length >= 2 ||
    newNavItems.length >= 2 ||
    titleChanged ||
    metaChanged ||
    significantTextShift;

  const reasons: string[] = [];
  if (newRssItems.length > 0) {
    reasons.push(
      newRssItems.length === 1
        ? `New blog article: ${newRssItems[0].title}`
        : `${newRssItems.length} new blog articles & feed updates`
    );
  }
  if (newGithubReleases.length > 0) {
    reasons.push(`New release ${newGithubReleases[0].tagName}: ${newGithubReleases[0].name}`);
  }
  if (newHeadings.length >= 2) {
    reasons.push(`New features & highlights: ${newHeadings.slice(0, 2).join(' · ')}`);
  }
  if (newPages.length > 0) {
    reasons.push(
      newPages.length === 1
        ? `New destination launched on ${site.name}`
        : `${newPages.length} new sections launched on ${site.name}`
    );
  }
  if (newNavItems.length >= 2) {
    reasons.push(`New sections added: ${newNavItems.slice(0, 3).join(', ')}`);
  }
  if (titleChanged) reasons.push(`Updated spotlight: ${current.title}`);
  if (metaChanged) reasons.push('Updated product & feature overview');
  if (significantTextShift && reasons.length === 0) {
    reasons.push(`Expanded features, content, and capabilities on ${site.name}`);
  }

  const changeSignature = JSON.stringify({
    newPages: newPages.slice(0, 10),
    newHeadings: newHeadings.slice(0, 10),
    newRssItems: newRssItems.map((r) => r.title).slice(0, 5),
    newGithubReleases: newGithubReleases.map((r) => r.tagName).slice(0, 5),
    title: current.title,
    meta: current.metaDescription,
    textHash: significantTextShift ? current.contentHash : '',
  });

  const changeHash = crypto.createHash('sha256').update(changeSignature).digest('hex');

  const prevSentences = new Set(previous.mainText.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 20));
  const changedSentences = current.mainText
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && !prevSentences.has(s))
    .slice(0, 6);

  return {
    siteId: site.id,
    siteName: site.name,
    siteUrl: site.url,
    isInitial: false,
    meaningful,
    reason: reasons.length > 0 ? reasons.join(' · ') : 'No user-facing feature or content update detected',
    changeHash,
    newPages,
    removedPages,
    newHeadings,
    removedHeadings,
    newNavItems,
    newLinks,
    newRssItems,
    newGithubCommits,
    newGithubReleases,
    beforeSummary: `${previous.title}${previous.metaDescription ? ` — ${previous.metaDescription}` : ''}`,
    afterSummary: `${current.title}${current.metaDescription ? ` — ${current.metaDescription}` : ''}`,
    textDiffSnippet: changedSentences.join('. '),
    currentTitle: current.title,
    currentMetaDescription: current.metaDescription,
    currentHeadings: current.headings,
    currentMainTextExcerpt: current.mainText.slice(0, 6000),
    heroImageUrl: current.images[0]?.src ?? null,
  };
}

export async function syncHubSitesOnly(): Promise<{ discovered: number; added: number; hubUrl: string }> {
  const rawHubUrl = (await getSetting('hub_url')) || DEFAULT_HUB_URL;
  const hubUrl = normalizeUrl(rawHubUrl);

  try {
    const res = await safeFetchText(hubUrl, { timeoutMs: 14000, retries: 2, cacheBust: true });
    const resolvedHubUrl = normalizeUrl(res.finalUrl || hubUrl);
    const hubHost = new URL(resolvedHubUrl).hostname.toLowerCase();
    const $ = cheerio.load(res.text);
    const seenUrls = new Set<string>();
    const candidates: Array<{ name: string; url: string; githubRepo: string | null }> = [];

    const addCandidate = (rawHref: string, rawLabel: string) => {
      try {
        const abs = normalizeUrl(new URL(rawHref, resolvedHubUrl).toString());
        const parsed = new URL(abs);
        const host = parsed.hostname.toLowerCase();

        if (host === hubHost) return;
        if (IGNORED_HUB_DOMAINS.has(host) || IGNORED_HUB_DOMAINS.has(host.replace(/^www\./, ''))) return;
        if (host === 'github.com' || host === 'www.github.com') return;

        if (!seenUrls.has(abs)) {
          seenUrls.add(abs);
          const shortTitle = rawLabel.split(/\s+[—–-]\s+/)[0]?.trim() || rawLabel;
          candidates.push({
            name: deriveSiteName(shortTitle, abs),
            url: abs,
            githubRepo: null,
          });
        }
      } catch {
        // ignore malformed or blocked links
      }
    };

    // 1. Static HTML anchor links
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text();
      if (href) addCandidate(href, text);
    });

    // 2. Hub RSS/Atom feed project items (useful for client-rendered SPA hubs)
    const rssHref =
      $('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]').first().attr('href') ||
      '/rss.xml';
    try {
      const hubRssUrl = normalizeUrl(new URL(rssHref, resolvedHubUrl).toString());
      const rssEntries = await fetchRssItems(hubRssUrl);
      for (const entry of rssEntries) {
        if (entry.link) addCandidate(entry.link, entry.title);
      }
    } catch {
      // ignore if hub has no RSS
    }

    // 3. Structured JSON-LD sameAs links across @graph / nested entities
    const hubJsonLd = extractJsonLdSignals($);
    for (const sameAsUrl of hubJsonLd.sameAsUrls) {
      addCandidate(sameAsUrl, '');
    }

    // 4. Client-rendered SPA module bundle discovery (extracts JS-rendered project cards & links)
    const moduleScriptSrcs: string[] = [];
    $('script[type="module"][src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      try {
        const absScript = normalizeUrl(new URL(src, resolvedHubUrl).toString());
        if (new URL(absScript).hostname.toLowerCase() === hubHost && !moduleScriptSrcs.includes(absScript)) {
          moduleScriptSrcs.push(absScript);
        }
      } catch {
        // ignore invalid script src
      }
    });

    for (const scriptUrl of moduleScriptSrcs.slice(0, 2)) {
      try {
        const jsRes = await safeFetchText(scriptUrl, {
          timeoutMs: 16000,
          retries: 1,
          maxBytes: 2_000_000,
          cacheBust: true,
        });
        const jsText = jsRes.text;

        const titleFirstRe = /title\s*:\s*["']([^"']{2,70})["'][^}]{0,700}?link\s*:\s*["'](https?:\/\/[^"']+)["']/g;
        let match: RegExpExecArray | null;
        while ((match = titleFirstRe.exec(jsText)) !== null) {
          addCandidate(match[2], match[1]);
        }

        const linkFirstRe = /link\s*:\s*["'](https?:\/\/[^"']+)["'][^}]{0,700}?title\s*:\s*["']([^"']{2,70})["']/g;
        while ((match = linkFirstRe.exec(jsText)) !== null) {
          addCandidate(match[1], match[2]);
        }

        const firstPartyUrlRe =
          /https?:\/\/(?:[a-z0-9-]+\.)?(?:ai\.studio|github\.io|blogspot\.com|wordpress\.com|run\.app)(?:\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?/g;
        const foundUrls = jsText.match(firstPartyUrlRe) || [];
        for (const rawFound of foundUrls) {
          const cleanFound = rawFound.replace(/[),.;'"`\\]+$/, '');
          if (cleanFound.includes('/mshots/') || cleanFound.includes('/p/contact-us')) continue;
          addCandidate(cleanFound, '');
        }
      } catch {
        // ignore unreachable or oversized module bundle
      }
    }

    // Ensure hub itself is included if no external sites were found
    if (candidates.length === 0) {
      candidates.push({
        name: 'M R X Shahin Studio',
        url: resolvedHubUrl,
        githubRepo: null,
      });
    }

    let added = 0;
    for (const item of candidates) {
      const result = await upsertHubSite(item);
      if (result.created) added++;
    }

    await addLog({
      level: 'info',
      action: 'hub_sync',
      message: `Synced ${candidates.length} site(s) from ${hubUrl} (${added} newly added)`,
    });

    return { discovered: candidates.length, added, hubUrl };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await addLog({
      level: 'warn',
      action: 'hub_sync',
      message: `Hub sync encountered an error fetching ${hubUrl}`,
      details: errMsg,
    });
    return { discovered: 0, added: 0, hubUrl };
  }
}

export async function checkSingleSite(
  siteId: number,
  options: { forcePost?: boolean } = {}
): Promise<{ status: 'ok' | 'error'; changed: boolean; postCreated: boolean; message: string }> {
  const site = await getSiteById(siteId);
  if (!site) {
    throw new Error(`Site ${siteId} not found`);
  }

  try {
    const res = await safeFetchText(site.url, { timeoutMs: 22000, retries: 2, cacheBust: true });
    const canonicalPageUrl = normalizeUrl(res.finalUrl || site.url);
    const signals = extractPageSignals(res.text, canonicalPageUrl);
    await enrichSpaSignals(res.text, canonicalPageUrl, signals);

    const origin = new URL(canonicalPageUrl).origin;
    const hostLower = new URL(canonicalPageUrl).hostname.toLowerCase();
    const sitemapTarget = normalizeUrl(site.sitemapUrl || signals.discoveredSitemapUrl || `${origin}/sitemap.xml`);
    const rssTarget = normalizeUrl(
      site.rssUrl ||
        signals.discoveredRssUrl ||
        (hostLower.endsWith('.blogspot.com')
          ? `${origin}/feeds/posts/default?alt=rss`
          : hostLower.endsWith('.wordpress.com')
            ? `${origin}/feed/`
            : `${origin}/rss.xml`)
    );

    const resolvedGithubRepo = site.githubRepo || inferGithubRepoFromUrl(canonicalPageUrl);
    await updateSiteDiscoveredMetadata(site.id, {
      rssUrl: signals.discoveredRssUrl,
      sitemapUrl: signals.discoveredSitemapUrl,
      githubRepo: resolvedGithubRepo,
    });

    let [sitemapUrls, rssItems, githubData] = await Promise.all([
      fetchSitemapUrls(sitemapTarget),
      fetchRssItems(rssTarget),
      resolvedGithubRepo ? fetchGithubActivity(resolvedGithubRepo) : Promise.resolve(null),
    ]);

    if (rssItems.length === 0 && !site.rssUrl && !signals.discoveredRssUrl && rssTarget.endsWith('/rss.xml')) {
      rssItems = await fetchRssItems(normalizeUrl(`${origin}/feed`));
    }

    const contentHash = computeSnapshotHash({
      title: signals.title,
      metaDescription: signals.metaDescription,
      headings: signals.headings,
      mainText: signals.mainText,
      navItems: signals.navItems,
      sitemapUrls,
      rssItems,
      githubData,
    });

    const previousSnapshot = await getLatestSnapshot(site.id);
    const currentSnapshotPayload: Omit<SnapshotRecord, 'id' | 'createdAt'> = {
      siteId: site.id,
      pageUrl: canonicalPageUrl,
      contentHash,
      title: signals.title,
      metaDescription: signals.metaDescription,
      headings: signals.headings,
      mainText: signals.mainText,
      links: signals.links,
      images: signals.images,
      navItems: signals.navItems,
      sitemapUrls,
      rssItems,
      githubData,
    };

    const existingPostCount = await countPostsForSite(site.id);
    const report = buildChangeReport(site, previousSnapshot, currentSnapshotPayload, existingPostCount > 0);

    const shouldPublish = options.forcePost || report.meaningful;
    if (!shouldPublish) {
      if (!previousSnapshot || previousSnapshot.contentHash !== contentHash) {
        await saveSnapshot(currentSnapshotPayload);
      }
      await updateSiteStatus(site.id, 'ok', null, signals.themeColor);
      await addLog({
        level: 'info',
        siteId: site.id,
        siteName: site.name,
        action: 'monitor_check',
        message: `Checked ${site.name} — no meaningful changes`,
      });
      return { status: 'ok', changed: false, postCreated: false, message: 'No meaningful changes' };
    }

    if (!options.forcePost) {
      const duplicate = await hasPostWithChangeHash(site.id, report.changeHash);
      if (duplicate) {
        if (!previousSnapshot || previousSnapshot.contentHash !== contentHash) {
          await saveSnapshot(currentSnapshotPayload);
        }
        await updateSiteStatus(site.id, 'ok', null, signals.themeColor);
        await addLog({
          level: 'info',
          siteId: site.id,
          siteName: site.name,
          action: 'duplicate_skipped',
          message: `Skipped duplicate post for ${site.name} (change already covered)`,
        });
        return { status: 'ok', changed: true, postCreated: false, message: 'Change already covered' };
      }
    } else {
      // Ensure unique changeHash when admin forces generation
      report.changeHash = crypto
        .createHash('sha256')
        .update(`manual:${site.id}:${Date.now()}`)
        .digest('hex');
      report.meaningful = true;
    }

    await addLog({
      level: 'info',
      siteId: site.id,
      siteName: site.name,
      action: 'change_detected',
      message: `Detected meaningful update on ${site.name}: ${report.reason}`,
    });

    const post = await generateAndSavePostFromReport(report);
    if (!previousSnapshot || previousSnapshot.contentHash !== contentHash) {
      await saveSnapshot(currentSnapshotPayload);
    }
    await updateSiteStatus(site.id, 'ok', null, signals.themeColor);
    return {
      status: 'ok',
      changed: true,
      postCreated: true,
      message: `Generated post "${post.title}"`,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await updateSiteStatus(site.id, 'error', errMsg);
    await addLog({
      level: 'error',
      siteId: site.id,
      siteName: site.name,
      action: 'monitor_error',
      message: `Failed checking ${site.name}`,
      details: errMsg,
    });
    return { status: 'error', changed: false, postCreated: false, message: errMsg };
  }
}

export async function runMonitoringCycle(
  trigger: 'scheduler' | 'manual' | 'startup'
): Promise<{
  skipped?: boolean;
  sitesChecked: number;
  postsCreated: number;
  errors: number;
}> {
  if (checkInProgress) {
    return { skipped: true, sitesChecked: 0, postsCreated: 0, errors: 0 };
  }

  checkInProgress = true;
  const startedAt = new Date().toISOString();
  let sitesChecked = 0;
  let postsCreated = 0;
  let errors = 0;

  try {
    await addLog({
      level: 'info',
      action: 'cycle_start',
      message: `Starting monitoring cycle (${trigger})`,
    });

    await syncHubSitesOnly();
    const sites = await listActiveSites();
    const concurrency = Math.min(3, Math.max(1, sites.length));
    let cursor = 0;

    const runWorker = async () => {
      while (cursor < sites.length) {
        const site = sites[cursor++];
        if (!site) break;
        sitesChecked++;
        try {
          const result = await checkSingleSite(site.id);
          if (result.status === 'error') errors++;
          if (result.postCreated) postsCreated++;
        } catch (err) {
          errors++;
          await addLog({
            level: 'error',
            siteId: site.id,
            siteName: site.name,
            action: 'cycle_site_error',
            message: `Unhandled error checking ${site.name}`,
            details: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

    await setSetting('last_run_at', startedAt);
    await setSetting(
      'last_run_status',
      errors > 0 ? `Completed with ${errors} site error(s)` : 'All monitored sites nominal'
    );

    await addLog({
      level: errors > 0 ? 'warn' : 'success',
      action: 'cycle_complete',
      message: `Monitoring cycle finished: ${sitesChecked} site(s) checked, ${postsCreated} post(s) generated, ${errors} error(s)`,
    });

    return { sitesChecked, postsCreated, errors };
  } finally {
    checkInProgress = false;
  }
}
