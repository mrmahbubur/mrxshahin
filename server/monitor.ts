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
  updateSiteStatus,
  upsertHubSite,
} from './db.ts';
import { generateAndSavePostFromReport } from './generator.ts';
import { safeFetchText, validateExternalUrl } from './security.ts';
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
]);

let checkInProgress = false;

export function isCheckRunning(): boolean {
  return checkInProgress;
}

function normalizeUrl(raw: string): string {
  const parsed = validateExternalUrl(raw);
  parsed.hash = '';
  // Remove common tracking query params
  for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref']) {
    parsed.searchParams.delete(param);
  }
  const str = parsed.toString();
  return str.endsWith('/') && parsed.pathname === '/' ? str.slice(0, -1) : str;
}

function deriveSiteName(anchorText: string, siteUrl: string): string {
  const cleaned = anchorText.replace(/\s+/g, ' ').trim();
  const genericWords = new Set(['visit', 'open', 'launch', 'view', 'live', 'demo', 'website', 'link', 'here', 'app', 'try']);
  if (cleaned.length >= 3 && cleaned.length <= 55 && !genericWords.has(cleaned.toLowerCase())) {
    return cleaned;
  }
  try {
    const host = new URL(siteUrl).hostname.replace(/^www\./, '');
    const firstPart = host.split('.')[0] || host;
    return firstPart
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
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

  const title = ($('title').first().text() || $('meta[property="og:title"]').attr('content') || '').replace(/\s+/g, ' ').trim();
  const metaDescription = (
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
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
        discoveredRssUrl = new URL(href, baseUrl).toString();
      } catch {
        // ignore invalid href
      }
    }
  });

  let discoveredSitemapUrl: string | null = null;
  $('link[rel="sitemap"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      try {
        discoveredSitemapUrl = new URL(href, baseUrl).toString();
      } catch {
        // ignore
      }
    }
  });

  // Nav items
  const navSet = new Set<string>();
  $('header a, nav a').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && t.length <= 45) navSet.add(t);
  });

  // Headings
  const headings: HeadingItem[] = [];
  const seenHeadings = new Set<string>();
  $('h1, h2, h3').each((_, el) => {
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const level = el.tagName.toLowerCase();
    const key = `${level}:${text}`;
    if (text && text.length <= 180 && !seenHeadings.has(key)) {
      seenHeadings.add(key);
      headings.push({ level, text });
    }
  });

  // Images
  const images: ImageItem[] = [];
  const seenImgs = new Set<string>();
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    const alt = ($(el).attr('alt') || '').replace(/\s+/g, ' ').trim();
    if (src && !src.startsWith('data:') && !seenImgs.has(src)) {
      try {
        const abs = new URL(src, baseUrl).toString();
        seenImgs.add(src);
        images.push({ src: abs, alt });
      } catch {
        // ignore
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

  // Remove non-content & noisy ad/script elements before extracting main text
  $('script, style, noscript, svg, iframe, [aria-hidden="true"], .ads, .ad-banner, [id*="cookie"], [class*="cookie"]').remove();

  const mainRoot = $('main, article, [role="main"]').first();
  const rawMainText = (mainRoot.length ? mainRoot.text() : $('body').text()) || '';
  const mainText = normalizeTextForDiff(rawMainText).slice(0, 30000);

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

async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  try {
    const res = await safeFetchText(sitemapUrl, { timeoutMs: 8000, retries: 1 });
    const $ = cheerio.load(res.text, { xmlMode: true });
    const urls: string[] = [];
    $('url > loc, sitemap > loc').each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) urls.push(loc);
    });
    return urls.slice(0, 200);
  } catch {
    return [];
  }
}

async function fetchRssItems(rssUrl: string): Promise<RssEntry[]> {
  try {
    const res = await safeFetchText(rssUrl, { timeoutMs: 8000, retries: 1 });
    const $ = cheerio.load(res.text, { xmlMode: true });
    const items: RssEntry[] = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').first().text().trim();
      const link = $(el).find('link').first().text().trim();
      const pubDate = $(el).find('pubDate').first().text().trim();
      const desc = $(el).find('description').first().text().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (title) {
        items.push({ title, link, pubDate, summary: desc.slice(0, 400) });
      }
    });

    if (items.length === 0) {
      $('entry').each((_, el) => {
        const title = $(el).find('title').first().text().trim();
        const link = $(el).find('link').first().attr('href') || '';
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
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const [commitsRes, releasesRes] = await Promise.allSettled([
      safeFetchText(`https://api.github.com/repos/${repoSlug}/commits?per_page=8`, {
        timeoutMs: 8000,
        retries: 1,
        headers,
      }),
      safeFetchText(`https://api.github.com/repos/${repoSlug}/releases?per_page=5`, {
        timeoutMs: 8000,
        retries: 1,
        headers,
      }),
    ]);

    const commits: GithubCommitEntry[] = [];
    if (commitsRes.status === 'fulfilled') {
      const data = JSON.parse(commitsRes.value.text) as Array<{
        sha?: string;
        html_url?: string;
        commit?: { message?: string; author?: { name?: string; date?: string } };
      }>;
      if (Array.isArray(data)) {
        for (const c of data) {
          if (c.sha && c.commit?.message) {
            commits.push({
              sha: c.sha.slice(0, 7),
              message: c.commit.message.split('\n')[0].slice(0, 180),
              author: c.commit.author?.name || 'Author',
              date: c.commit.author?.date || '',
              url: c.html_url || '',
            });
          }
        }
      }
    }

    const releases: GithubReleaseEntry[] = [];
    if (releasesRes.status === 'fulfilled') {
      const data = JSON.parse(releasesRes.value.text) as Array<{
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
    }

    return { commits, releases };
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
    githubCommits: data.githubData?.commits.map((c) => c.sha) ?? [],
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
      (current.githubData?.commits.length ?? 0) > 0 ||
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
        ? `Initial site discovery and baseline index for ${site.name}`
        : 'Initial baseline snapshot stored (insufficient public text for standalone article)',
      changeHash,
      newPages: current.sitemapUrls.slice(0, 20),
      removedPages: [],
      newHeadings: current.headings.map((h) => h.text).slice(0, 20),
      removedHeadings: [],
      newNavItems: current.navItems,
      newLinks: current.links.slice(0, 20),
      newRssItems: current.rssItems.slice(0, 10),
      newGithubCommits: current.githubData?.commits ?? [],
      newGithubReleases: current.githubData?.releases ?? [],
      beforeSummary: '',
      afterSummary: current.metaDescription || current.title,
      textDiffSnippet: current.mainText.slice(0, 600),
      currentTitle: current.title,
      currentMetaDescription: current.metaDescription,
      currentHeadings: current.headings,
      currentMainTextExcerpt: current.mainText.slice(0, 6000),
    };
  }

  const prevSitemaps = new Set(previous.sitemapUrls);
  const currSitemaps = new Set(current.sitemapUrls);
  const newPages = current.sitemapUrls.filter((u) => !prevSitemaps.has(u));
  const removedPages = previous.sitemapUrls.filter((u) => !currSitemaps.has(u));

  const prevHeadings = new Set(previous.headings.map((h) => h.text));
  const currHeadings = new Set(current.headings.map((h) => h.text));
  const newHeadings = current.headings.map((h) => h.text).filter((t) => !prevHeadings.has(t));
  const removedHeadings = previous.headings.map((h) => h.text).filter((t) => !currHeadings.has(t));

  const prevNav = new Set(previous.navItems);
  const newNavItems = current.navItems.filter((n) => !prevNav.has(n));

  const prevLinks = new Set(previous.links.map((l) => l.href));
  const newLinks = current.links.filter((l) => !prevLinks.has(l.href));

  const prevRssKeys = new Set(previous.rssItems.map((r) => `${r.title}|${r.link}`));
  const newRssItems = current.rssItems.filter((r) => !prevRssKeys.has(`${r.title}|${r.link}`));

  const prevCommitShas = new Set(previous.githubData?.commits.map((c) => c.sha) ?? []);
  const newGithubCommits = (current.githubData?.commits ?? []).filter((c) => !prevCommitShas.has(c.sha));

  const prevReleaseTags = new Set(previous.githubData?.releases.map((r) => r.tagName) ?? []);
  const newGithubReleases = (current.githubData?.releases ?? []).filter((r) => !prevReleaseTags.has(r.tagName));

  const textSimilarity = tokenJaccardSimilarity(previous.mainText, current.mainText);
  const titleChanged = previous.title !== current.title && current.title.length > 0;
  const metaChanged = previous.metaDescription !== current.metaDescription && current.metaDescription.length > 0;

  // Meaningful change criteria (ignores trivial timestamp/whitespace/ad changes)
  const significantTextShift = textSimilarity < 0.92 && Math.abs(current.mainText.length - previous.mainText.length) > 120;
  const meaningful =
    newPages.length > 0 ||
    removedPages.length > 0 ||
    newHeadings.length > 0 ||
    newNavItems.length > 0 ||
    newRssItems.length > 0 ||
    newGithubCommits.length > 0 ||
    newGithubReleases.length > 0 ||
    titleChanged ||
    metaChanged ||
    significantTextShift;

  const reasons: string[] = [];
  if (newPages.length > 0) reasons.push(`${newPages.length} new page(s) in sitemap`);
  if (removedPages.length > 0) reasons.push(`${removedPages.length} removed page(s)`);
  if (newHeadings.length > 0) reasons.push(`${newHeadings.length} new section heading(s)`);
  if (newNavItems.length > 0) reasons.push(`${newNavItems.length} new navigation item(s)`);
  if (newRssItems.length > 0) reasons.push(`${newRssItems.length} new RSS item(s)`);
  if (newGithubReleases.length > 0) reasons.push(`${newGithubReleases.length} new GitHub release(s)`);
  if (newGithubCommits.length > 0) reasons.push(`${newGithubCommits.length} new GitHub commit(s)`);
  if (titleChanged) reasons.push('Page title updated');
  if (metaChanged) reasons.push('Meta description updated');
  if (significantTextShift) reasons.push(`Substantial copy change (similarity ${(textSimilarity * 100).toFixed(1)}%)`);

  const changeSignature = JSON.stringify({
    newPages: newPages.slice(0, 10),
    removedPages: removedPages.slice(0, 10),
    newHeadings: newHeadings.slice(0, 10),
    newRssItems: newRssItems.map((r) => r.title).slice(0, 5),
    newGithubCommits: newGithubCommits.map((c) => c.sha).slice(0, 5),
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
    reason: reasons.length > 0 ? reasons.join('; ') : 'No meaningful change detected',
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
  };
}

export async function syncHubSitesOnly(): Promise<{ discovered: number; added: number; hubUrl: string }> {
  const hubUrl = (await getSetting('hub_url')) || DEFAULT_HUB_URL;
  const hubHost = new URL(hubUrl).hostname.toLowerCase();

  try {
    const res = await safeFetchText(hubUrl, { timeoutMs: 14000, retries: 2 });
    const $ = cheerio.load(res.text);
    const seenUrls = new Set<string>();
    const candidates: Array<{ name: string; url: string; githubRepo: string | null }> = [];

    const addCandidate = (rawHref: string, rawLabel: string) => {
      try {
        const abs = normalizeUrl(new URL(rawHref, hubUrl).toString());
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
      const hubRssUrl = new URL(rssHref, hubUrl).toString();
      const rssEntries = await fetchRssItems(hubRssUrl);
      for (const entry of rssEntries) {
        if (entry.link) addCandidate(entry.link, entry.title);
      }
    } catch {
      // ignore if hub has no RSS
    }

    // 3. Structured JSON-LD sameAs links
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const parsed = JSON.parse($(el).text()) as { sameAs?: unknown };
        if (Array.isArray(parsed.sameAs)) {
          for (const item of parsed.sameAs) {
            if (typeof item === 'string') addCandidate(item, '');
          }
        }
      } catch {
        // ignore malformed JSON-LD
      }
    });

    // Ensure hub itself is included if no external sites were found
    if (candidates.length === 0) {
      candidates.push({
        name: 'M R X Shahin Studio',
        url: normalizeUrl(hubUrl),
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
    const res = await safeFetchText(site.url, { timeoutMs: 14000, retries: 2 });
    const signals = extractPageSignals(res.text, res.finalUrl);

    const origin = new URL(res.finalUrl).origin;
    const hostLower = new URL(res.finalUrl).hostname.toLowerCase();
    const sitemapTarget = site.sitemapUrl || signals.discoveredSitemapUrl || `${origin}/sitemap.xml`;
    const rssTarget =
      site.rssUrl ||
      signals.discoveredRssUrl ||
      (hostLower.endsWith('.blogspot.com')
        ? `${origin}/feeds/posts/default?alt=rss`
        : hostLower.endsWith('.wordpress.com')
          ? `${origin}/feed/`
          : `${origin}/rss.xml`);

    let [sitemapUrls, rssItems, githubData] = await Promise.all([
      fetchSitemapUrls(sitemapTarget),
      fetchRssItems(rssTarget),
      site.githubRepo ? fetchGithubActivity(site.githubRepo) : Promise.resolve(null),
    ]);

    if (rssItems.length === 0 && !site.rssUrl && !signals.discoveredRssUrl && rssTarget.endsWith('/rss.xml')) {
      rssItems = await fetchRssItems(`${origin}/feed/`);
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
      pageUrl: res.finalUrl,
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

    for (const site of sites) {
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
