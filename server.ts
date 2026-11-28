import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  getAiControlStatus,
  getRecommendedIntervalMinutes,
  runAiMaintenanceAndControl,
  runAutonomousCycle,
  setAiAutopilotEnabled,
} from './server/aiController.ts';
import {
  addLog,
  claimAdminPasswordHashAtomic,
  closeDb,
  createAd,
  createManualSite,
  deleteAd,
  deletePost,
  deleteSite,
  getAdminStats,
  getDbEngine,
  getPostById,
  getPostBySlug,
  getRelatedPosts,
  getSetting,
  getThumbnailDataBySlug,
  initDb,
  listActiveAds,
  listAllAds,
  listAllPosts,
  listAllPublishedPostsForFeed,
  listLogs,
  listPostsMissingThumbnails,
  listPublishedPosts,
  listSites,
  getCategoriesWithCounts,
  getSiteById,
  recordAdClick,
  recordAdImpression,
  setPostThumbnail,
  setSetting,
  updateAd,
  updatePost,
  updateSite,
} from './server/db.ts';
import {
  getAdminPassword,
  resolveRuntimeEnvironment,
} from './server/env.ts';
import {
  emitPublicPostDeleted,
  emitPublicPostUpdated,
  subscribePublicPostEvents,
} from './server/events.ts';
import { regeneratePostContent, regeneratePostThumbnailOnly } from './server/generator.ts';
import { checkSingleSite, isCheckRunning, syncHubSitesOnly } from './server/monitor.ts';
import {
  escapeXml,
  hashPassword,
  normalizeExternalUrl,
  sanitizePostHtml,
  signSessionToken,
  slugify,
  validateExternalUrl,
  validateSlug,
  verifyEnvPassword,
  verifyPasswordHash,
  verifySessionToken,
} from './server/security.ts';
import { buildFallbackThumbnailPng, getThumbnailCachePath, saveThumbnailToDiskCache } from './server/thumbnails.ts';

const RUNTIME = resolveRuntimeEnvironment();
const PORT = RUNTIME.port;
const IS_PROD = RUNTIME.isProd;
const ADMIN_PATH = RUNTIME.adminPath;

function isAdminHtmlRequest(reqPath: string): boolean {
  const cleanPath = reqPath.split('?')[0].replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  return cleanPath === ADMIN_PATH || cleanPath.startsWith(`${ADMIN_PATH}/`);
}

function escapeForInlineScript(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function injectAdminRouteIntoHtml(html: string): string {
  const safePathJson = escapeForInlineScript(ADMIN_PATH);
  const adminMeta = `
    <title>Admin Console – M R S Auto Blog</title>
    <meta name="robots" content="noindex, nofollow" />
    <script>window.__MRS_ADMIN_PATH__ = ${safePathJson};</script>
  `;
  return html
    .replace(/<title>[\s\S]*?<\/title>/gi, '')
    .replace(/<meta\s+[^>]*name=["'](?:description|robots)["'][^>]*>/gi, '')
    .replace(/<meta\s+[^>]*property=["']og:[^"']*["'][^>]*>/gi, '')
    .replace(/<meta\s+[^>]*name=["']twitter:[^"']*["'][^>]*>/gi, '')
    .replace(/<link\s+[^>]*rel=["']canonical["'][^>]*>/gi, '')
    .replace(/<link\s+[^>]*type=["']application\/rss\+xml["'][^>]*>/gi, '')
    .replace(/<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace('</head>', `${adminMeta}\n  </head>`);
}

function resolveBaseUrl(req: express.Request): string {
  if (RUNTIME.publicBaseUrl) {
    return RUNTIME.publicBaseUrl;
  }
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function escapeHtmlAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function injectPostSeoIntoHtml(html: string, baseUrl: string, post: {
  title: string;
  metaDescription: string;
  slug: string;
  siteName: string;
  publishedAt: string;
  updatedAt: string;
}): string {
  const fullTitle = `${post.title} – M R S Auto Blog`;
  const postUrl = `${baseUrl}/post/${post.slug}`;
  const thumbUrl = `${baseUrl}/thumbnails/${post.slug}.png`;

  const ldJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.metaDescription,
    image: thumbUrl,
    url: postUrl,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    publisher: {
      '@type': 'Organization',
      name: 'M R S Auto Blog',
    },
    about: {
      '@type': 'WebSite',
      name: post.siteName,
    },
  });

  const metaBlock = `
    <title>${escapeHtmlAttr(fullTitle)}</title>
    <meta name="description" content="${escapeHtmlAttr(post.metaDescription)}" />
    <link rel="canonical" href="${escapeHtmlAttr(postUrl)}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escapeHtmlAttr(fullTitle)}" />
    <meta property="og:description" content="${escapeHtmlAttr(post.metaDescription)}" />
    <meta property="og:url" content="${escapeHtmlAttr(postUrl)}" />
    <meta property="og:image" content="${escapeHtmlAttr(thumbUrl)}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1280" />
    <meta property="og:image:height" content="720" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtmlAttr(fullTitle)}" />
    <meta name="twitter:description" content="${escapeHtmlAttr(post.metaDescription)}" />
    <meta name="twitter:image" content="${escapeHtmlAttr(thumbUrl)}" />
    <script type="application/ld+json">${ldJson.replace(/</g, '\\u003c')}</script>
  `;

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name="description"[\s\S]*?\/>/i, '')
    .replace(/<meta\s+property="og:title"[\s\S]*?\/>/i, '')
    .replace(/<meta\s+property="og:description"[\s\S]*?\/>/i, '')
    .replace(/<meta\s+property="og:type"[\s\S]*?\/>/i, '')
    .replace(/<meta\s+name="twitter:title"[\s\S]*?\/>/i, '')
    .replace(/<meta\s+name="twitter:description"[\s\S]*?\/>/i, '')
    .replace('</head>', `${metaBlock}\n  </head>`);
}

async function backfillMissingThumbnails(): Promise<void> {
  try {
    const missing = await listPostsMissingThumbnails();
    for (const item of missing) {
      try {
        const safeSlug = validateSlug(item.slug);
        const site = item.siteId ? await getSiteById(item.siteId) : null;
        const pngBuffer = await buildFallbackThumbnailPng(
          item.title,
          item.siteName,
          safeSlug,
          site?.themeColor
        );
        saveThumbnailToDiskCache(safeSlug, pngBuffer);
        await setPostThumbnail(item.id, `/thumbnails/${safeSlug}.png`, pngBuffer);
      } catch (err) {
        console.warn(`Thumbnail backfill skipped for post ${item.id}:`, err);
      }
    }
  } catch (err) {
    console.warn('Thumbnail startup backfill warning:', err);
  }
}

async function startServer(): Promise<void> {
  const dbEngine = await initDb();
  await backfillMissingThumbnails();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  const activeSseClients = new Set<express.Response>();

  function setStrictNoCacheHeaders(res: express.Response): void {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }

  // Health Check (minimal response with no internal details)
  app.get('/health', (_req, res) => {
    setStrictNoCacheHeaders(res);
    res.json({ status: 'ok' });
  });

  // Robots.txt disallowing hidden admin route and admin APIs
  app.get('/robots.txt', (req, res) => {
    const baseUrl = resolveBaseUrl(req);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    setStrictNoCacheHeaders(res);
    res.send(
      `User-agent: *\nDisallow: ${ADMIN_PATH}\nDisallow: /api/admin\nSitemap: ${baseUrl}/sitemap.xml\n`
    );
  });

  // Persistent / Cached Thumbnail Serving
  app.get('/thumbnails/:filename', async (req, res) => {
    const raw = req.params.filename;
    if (!raw.endsWith('.png')) {
      res.status(404).send('Not found');
      return;
    }
    let safeSlug: string;
    try {
      safeSlug = validateSlug(raw.slice(0, -4));
    } catch {
      res.status(400).send('Invalid thumbnail name');
      return;
    }

    try {
      const cachePath = getThumbnailCachePath(safeSlug);
      if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
        res.sendFile(cachePath);
        return;
      }

      const record = await getThumbnailDataBySlug(safeSlug);
      if (!record) {
        res.status(404).send('Thumbnail not found');
        return;
      }

      let pngBuffer = record.data && record.data.length > 100 ? record.data : null;
      if (!pngBuffer) {
        pngBuffer = await buildFallbackThumbnailPng(record.title, record.siteName, safeSlug);
        await setPostThumbnail(record.id, `/thumbnails/${safeSlug}.png`, pngBuffer);
      }

      saveThumbnailToDiskCache(safeSlug, pngBuffer);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      res.send(pngBuffer);
    } catch (err) {
      console.error('Thumbnail serve error:', err);
      res.status(500).send('Error serving thumbnail');
    }
  });

  // RSS 2.0 Feed
  app.get('/rss.xml', async (req, res) => {
    try {
      const baseUrl = resolveBaseUrl(req);
      const posts = await listAllPublishedPostsForFeed(40);
      const itemsXml = posts
        .map((post) => {
          const link = `${baseUrl}/post/${post.slug}`;
          const thumb = `${baseUrl}/thumbnails/${post.slug}.png`;
          return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>
      <category>${escapeXml(post.category)}</category>
      <description>${escapeXml(post.summary)}</description>
      <enclosure url="${escapeXml(thumb)}" type="image/png" length="0" />
      <media:thumbnail url="${escapeXml(thumb)}" width="1280" height="720" />
      <media:content url="${escapeXml(thumb)}" medium="image" type="image/png" width="1280" height="720" />
    </item>`;
        })
        .join('\n');

      const latestTs = posts.length > 0 ? new Date(posts[0].updatedAt || posts[0].publishedAt).toUTCString() : new Date().toUTCString();
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>M R S Auto Blog</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>Automated editorial publication tracking updates and innovations across monitored websites.</description>
    <language>en-us</language>
    <lastBuildDate>${latestTs}</lastBuildDate>
    <atom:link href="${escapeXml(baseUrl)}/rss.xml" rel="self" type="application/rss+xml" />
${itemsXml}
  </channel>
</rss>`;

      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      setStrictNoCacheHeaders(res);
      res.send(xml);
    } catch (err) {
      res.status(500).send('Error generating RSS feed');
    }
  });

  // XML Sitemap
  app.get('/sitemap.xml', async (req, res) => {
    try {
      const baseUrl = resolveBaseUrl(req);
      const posts = await listAllPublishedPostsForFeed(500);
      const urlsXml = [
        `  <url>\n    <loc>${escapeXml(baseUrl)}/</loc>\n    <changefreq>hourly</changefreq>\n    <priority>1.0</priority>\n  </url>`,
        ...posts.map(
          (p) =>
            `  <url>\n    <loc>${escapeXml(`${baseUrl}/post/${p.slug}`)}</loc>\n    <lastmod>${new Date(p.updatedAt).toISOString()}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`
        ),
      ].join('\n');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlsXml}
</urlset>`;

      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      setStrictNoCacheHeaders(res);
      res.send(xml);
    } catch {
      res.status(500).send('Error generating sitemap');
    }
  });

  // Enforce strict no-store caching across all dynamic public and admin API endpoints
  app.use('/api', (_req, res, next) => {
    setStrictNoCacheHeaders(res);
    next();
  });

  // ---------------- Public Blog API ----------------

  app.get('/api/posts', async (req, res) => {
    try {
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const page = Number(req.query.page || 1);
      const limit = Number(req.query.limit || 9);

      const [feed, categories] = await Promise.all([
        listPublishedPosts({ category, search, page, limit }),
        getCategoriesWithCounts(),
      ]);

      const publicPosts = feed.posts.map((p) => ({
        id: p.id,
        siteName: p.siteName,
        siteUrl: p.siteUrl,
        title: p.title,
        slug: p.slug,
        metaDescription: p.metaDescription,
        summary: p.summary,
        tags: p.tags,
        category: p.category,
        readingTimeMinutes: p.readingTimeMinutes,
        thumbnailUrl: p.thumbnailUrl,
        publishedAt: p.publishedAt,
        updatedAt: p.updatedAt,
      }));

      res.json({
        posts: publicPosts,
        total: feed.total,
        page: feed.page,
        totalPages: feed.totalPages,
        categories,
      });
    } catch {
      res.status(500).json({ error: 'Failed to load posts' });
    }
  });

  // Real-time Server-Sent Events stream for newly published/updated public posts only
  app.get('/api/posts/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(': connected\n\n');
    activeSseClients.add(res);

    const unsubscribe = subscribePublicPostEvents((event) => {
      try {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // ignore broken pipe; cleanup fires on close
      }
    });

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
        activeSseClients.delete(res);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      activeSseClients.delete(res);
    });
  });

  app.get('/api/posts/:slug', async (req, res) => {
    try {
      const safeSlug = validateSlug(req.params.slug);
      const post = await getPostBySlug(safeSlug, false);
      if (!post) {
        res.status(404).json({ error: 'Post not found' });
        return;
      }
      const related = await getRelatedPosts(post.id, post.category, 3);
      res.json({
        post: {
          id: post.id,
          siteName: post.siteName,
          siteUrl: post.siteUrl,
          title: post.title,
          slug: post.slug,
          metaDescription: post.metaDescription,
          summary: post.summary,
          contentHtml: post.contentHtml,
          tags: post.tags,
          category: post.category,
          readingTimeMinutes: post.readingTimeMinutes,
          thumbnailUrl: post.thumbnailUrl,
          publishedAt: post.publishedAt,
          updatedAt: post.updatedAt,
        },
        related: related.map((r) => ({
          id: r.id,
          siteName: r.siteName,
          siteUrl: r.siteUrl,
          title: r.title,
          slug: r.slug,
          metaDescription: r.metaDescription,
          summary: r.summary,
          tags: r.tags,
          category: r.category,
          readingTimeMinutes: r.readingTimeMinutes,
          thumbnailUrl: r.thumbnailUrl,
          publishedAt: r.publishedAt,
          updatedAt: r.updatedAt,
        })),
      });
    } catch {
      res.status(404).json({ error: 'Post not found' });
    }
  });

  // ---------------- Public Affiliate Ads API ----------------

  const adMetricsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  app.get('/api/ads', async (_req, res) => {
    try {
      const ads = await listActiveAds();
      res.json({
        ads: ads.map((ad) => ({
          id: ad.id,
          slot: ad.slot,
          advertiserName: ad.advertiserName,
          displayDomain: ad.displayDomain,
          categoryLabel: ad.categoryLabel,
          headline: ad.headline,
          description: ad.description,
          ctaLabel: ad.ctaLabel,
          targetUrl: ad.targetUrl,
        })),
      });
    } catch {
      res.status(500).json({ error: 'Failed to load advertisements' });
    }
  });

  app.post('/api/ads/:id/impression', adMetricsLimiter, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid ad ID' });
      return;
    }
    try {
      const updated = await recordAdImpression(id);
      if (!updated) {
        res.status(404).json({ error: 'Ad not found' });
        return;
      }
      res.json({ recorded: true });
    } catch {
      res.status(500).json({ error: 'Failed to record impression' });
    }
  });

  app.post('/api/ads/:id/click', adMetricsLimiter, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid ad ID' });
      return;
    }
    try {
      const updated = await recordAdClick(id);
      if (!updated) {
        res.status(404).json({ error: 'Ad not found' });
        return;
      }
      res.json({ recorded: true });
    } catch {
      res.status(500).json({ error: 'Failed to record click' });
    }
  });

  // ---------------- Admin Auth & Rate-Limited API ----------------

  const adminApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin requests, please slow down.' },
  });

  const adminAuthLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please wait 15 minutes.' },
  });

  app.use('/api/admin', adminApiLimiter);

  async function resolveAuthMode(): Promise<'env' | 'claimed' | 'bootstrap'> {
    if (getAdminPassword()) return 'env';
    const claimed = await getSetting('admin_password_hash');
    return claimed ? 'claimed' : 'bootstrap';
  }

  function extractBearer(req: express.Request): string | null {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return auth.slice(7).trim() || null;
  }

  app.get('/api/admin/auth/status', async (req, res) => {
    try {
      const mode = await resolveAuthMode();
      const token = extractBearer(req);
      const authenticated = token ? verifySessionToken(token) : false;
      res.json({ mode, authenticated });
    } catch {
      res.status(500).json({ error: 'Failed to check auth status' });
    }
  });

  app.post('/api/admin/auth/bootstrap', adminAuthLimiter, async (req, res) => {
    try {
      const mode = await resolveAuthMode();
      if (mode !== 'bootstrap') {
        res.status(403).json({ error: 'Admin password is already configured.' });
        return;
      }

      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters.' });
        return;
      }

      const hashed = hashPassword(password);
      const claimed = await claimAdminPasswordHashAtomic(hashed);
      if (!claimed) {
        res.status(403).json({ error: 'Admin password was already claimed.' });
        return;
      }

      await addLog({
        level: 'info',
        action: 'admin_bootstrap',
        message: 'Initial admin password configured via first-run setup',
      });

      const session = signSessionToken();
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Bootstrap failed' });
    }
  });

  app.post('/api/admin/auth/login', adminAuthLimiter, async (req, res) => {
    try {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!password) {
        res.status(400).json({ error: 'Password is required.' });
        return;
      }

      const envPass = getAdminPassword();
      let valid = false;

      if (envPass) {
        valid = verifyEnvPassword(password, envPass);
      } else {
        const storedHash = await getSetting('admin_password_hash');
        if (!storedHash) {
          res.status(403).json({ error: 'Admin password not initialized yet.' });
          return;
        }
        valid = verifyPasswordHash(password, storedHash);
      }

      if (!valid) {
        res.status(401).json({ error: 'Invalid admin password.' });
        return;
      }

      const session = signSessionToken();
      res.json(session);
    } catch {
      res.status(500).json({ error: 'Authentication failed' });
    }
  });

  const requireAdmin: express.RequestHandler = (req, res, next) => {
    const token = extractBearer(req);
    if (!token || !verifySessionToken(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
    try {
      const [stats, sites, posts, logs, aiControl, ads] = await Promise.all([
        getAdminStats(),
        listSites(),
        listAllPosts(),
        listLogs(150),
        getAiControlStatus(),
        listAllAds(),
      ]);
      res.json({
        stats,
        sites,
        posts,
        logs,
        ads,
        checkInProgress: isCheckRunning(),
        aiControl,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load dashboard' });
    }
  });

  app.post('/api/admin/check-now', requireAdmin, async (_req, res) => {
    try {
      const result = await runAutonomousCycle('manual');
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Monitoring check failed' });
    }
  });

  app.post('/api/admin/ai/run-maintenance', requireAdmin, async (_req, res) => {
    try {
      const aiControl = await runAiMaintenanceAndControl('manual');
      res.json({ aiControl });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'AI maintenance failed' });
    }
  });

  app.post('/api/admin/ai/autopilot', requireAdmin, async (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      const aiControl = await setAiAutopilotEnabled(enabled);
      res.json({ aiControl });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update AI autopilot' });
    }
  });

  app.post('/api/admin/sync-hub', requireAdmin, async (_req, res) => {
    try {
      const result = await syncHubSitesOnly();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Hub sync failed' });
    }
  });

  app.post('/api/admin/settings/draft-mode', requireAdmin, async (req, res) => {
    try {
      const draftMode = Boolean(req.body?.draftMode);
      await setSetting('draft_mode', draftMode ? 'true' : 'false');
      await addLog({
        level: 'info',
        action: 'settings_updated',
        message: `Publishing mode set to ${draftMode ? 'Draft mode (review first)' : 'Auto-publish'}`,
      });
      res.json({ draftMode });
    } catch {
      res.status(500).json({ error: 'Failed to update draft mode' });
    }
  });

  app.post('/api/admin/sites', requireAdmin, async (req, res) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      const rawRss = typeof req.body?.rssUrl === 'string' ? req.body.rssUrl.trim() : '';
      const rawSitemap = typeof req.body?.sitemapUrl === 'string' ? req.body.sitemapUrl.trim() : '';
      const githubRepo = typeof req.body?.githubRepo === 'string' ? req.body.githubRepo.trim() : '';

      if (!name || !rawUrl) {
        res.status(400).json({ error: 'Site name and URL are required.' });
        return;
      }

      const validUrl = normalizeExternalUrl(rawUrl);
      const validRss = rawRss ? normalizeExternalUrl(rawRss) : null;
      const validSitemap = rawSitemap ? normalizeExternalUrl(rawSitemap) : null;

      const site = await createManualSite({
        name,
        url: validUrl,
        rssUrl: validRss,
        sitemapUrl: validSitemap,
        githubRepo: githubRepo || null,
      });

      await addLog({
        level: 'info',
        siteId: site.id,
        siteName: site.name,
        action: 'site_added',
        message: `Added monitored site "${site.name}" (${site.url})`,
      });

      res.status(201).json({ site });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add site' });
    }
  });

  app.patch('/api/admin/sites/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        res.status(400).json({ error: 'Invalid site ID' });
        return;
      }

      const patch: Record<string, unknown> = {};
      if (typeof req.body?.name === 'string') patch.name = req.body.name.trim();
      if (typeof req.body?.url === 'string') patch.url = normalizeExternalUrl(req.body.url);
      if (req.body?.rssUrl !== undefined) {
        patch.rssUrl = req.body.rssUrl ? normalizeExternalUrl(String(req.body.rssUrl)) : null;
      }
      if (req.body?.sitemapUrl !== undefined) {
        patch.sitemapUrl = req.body.sitemapUrl ? normalizeExternalUrl(String(req.body.sitemapUrl)) : null;
      }
      if (req.body?.githubRepo !== undefined) {
        patch.githubRepo = req.body.githubRepo ? String(req.body.githubRepo).trim() : null;
      }
      if (typeof req.body?.active === 'boolean') {
        patch.active = req.body.active;
      }

      const site = await updateSite(id, patch);
      if (!site) {
        res.status(404).json({ error: 'Site not found' });
        return;
      }
      res.json({ site });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update site' });
    }
  });

  app.post('/api/admin/sites/:id/check', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const forcePost = Boolean(req.body?.forcePost);
      const result = await checkSingleSite(id, { forcePost });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Site check failed' });
    }
  });

  app.delete('/api/admin/sites/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const ok = await deleteSite(id);
      if (!ok) {
        res.status(404).json({ error: 'Site not found' });
        return;
      }
      res.json({ deleted: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete site' });
    }
  });

  app.patch('/api/admin/posts/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await getPostById(id);
      if (!existing) {
        res.status(404).json({ error: 'Post not found' });
        return;
      }

      const patch: Parameters<typeof updatePost>[1] = {};
      if (typeof req.body?.title === 'string' && req.body.title.trim()) patch.title = req.body.title.trim();
      if (typeof req.body?.slug === 'string' && req.body.slug.trim()) patch.slug = validateSlug(slugify(req.body.slug));
      if (typeof req.body?.metaDescription === 'string') patch.metaDescription = req.body.metaDescription.trim();
      if (typeof req.body?.summary === 'string') patch.summary = req.body.summary.trim();
      if (typeof req.body?.category === 'string' && req.body.category.trim()) patch.category = req.body.category.trim();
      if (Array.isArray(req.body?.tags)) {
        patch.tags = req.body.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean);
      }
      if (req.body?.status === 'published' || req.body?.status === 'draft') {
        patch.status = req.body.status;
      }
      if (typeof req.body?.contentHtml === 'string') {
        patch.contentHtml = sanitizePostHtml(req.body.contentHtml);
        const words = patch.contentHtml.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
        patch.readingTimeMinutes = Math.max(1, Math.ceil(words / 220));
      }

      const updated = await updatePost(id, patch);
      if (updated) {
        emitPublicPostUpdated(updated);
      }
      res.json({ post: updated });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update post' });
    }
  });

  app.post('/api/admin/posts/:id/regenerate', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const post = await regeneratePostContent(id);
      res.json({ post });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Post regeneration failed' });
    }
  });

  app.post('/api/admin/posts/:id/regenerate-thumbnail', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const post = await regeneratePostThumbnailOnly(id);
      res.json({ post });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Thumbnail regeneration failed' });
    }
  });

  app.delete('/api/admin/posts/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await getPostById(id);
      const ok = await deletePost(id);
      if (!ok) {
        res.status(404).json({ error: 'Post not found' });
        return;
      }
      emitPublicPostDeleted(id, existing?.slug);
      res.json({ deleted: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete post' });
    }
  });

  app.post('/api/admin/ads', requireAdmin, async (req, res) => {
    try {
      const slot = req.body?.slot === 'sidebar' ? 'sidebar' : 'inline';
      const advertiserName = typeof req.body?.advertiserName === 'string' ? req.body.advertiserName.trim() : '';
      const displayDomain = typeof req.body?.displayDomain === 'string' ? req.body.displayDomain.trim() : '';
      const categoryLabel = typeof req.body?.categoryLabel === 'string' ? req.body.categoryLabel.trim() : '';
      const headline = typeof req.body?.headline === 'string' ? req.body.headline.trim() : '';
      const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
      const ctaLabel = typeof req.body?.ctaLabel === 'string' ? req.body.ctaLabel.trim() : '';
      const targetUrl = typeof req.body?.targetUrl === 'string' ? req.body.targetUrl.trim() : '';

      if (!advertiserName || !headline || !targetUrl) {
        res.status(400).json({ error: 'Advertiser name, headline, and affiliate URL are required.' });
        return;
      }

      const parsedUrl = validateExternalUrl(targetUrl);
      const ad = await createAd({
        slot,
        advertiserName,
        displayDomain: displayDomain || parsedUrl.hostname.replace(/^www\./, ''),
        categoryLabel: categoryLabel || 'Partner Offer',
        headline,
        description: description || `${advertiserName} affiliate partner spotlight.`,
        ctaLabel: ctaLabel || 'Visit Offer',
        targetUrl,
        sortOrder: Number.isFinite(req.body?.sortOrder) ? Number(req.body.sortOrder) : 0,
        active: req.body?.active !== false,
      });

      await addLog({
        level: 'info',
        action: 'ad_created',
        message: `Added affiliate ad "${ad.advertiserName}" (${ad.slot})`,
      });
      res.status(201).json({ ad });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create advertisement' });
    }
  });

  app.patch('/api/admin/ads/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid ad ID' });
        return;
      }

      const patch: Parameters<typeof updateAd>[1] = {};
      if (req.body?.slot === 'inline' || req.body?.slot === 'sidebar') patch.slot = req.body.slot;
      if (typeof req.body?.advertiserName === 'string') patch.advertiserName = req.body.advertiserName;
      if (typeof req.body?.displayDomain === 'string') patch.displayDomain = req.body.displayDomain;
      if (typeof req.body?.categoryLabel === 'string') patch.categoryLabel = req.body.categoryLabel;
      if (typeof req.body?.headline === 'string') patch.headline = req.body.headline;
      if (typeof req.body?.description === 'string') patch.description = req.body.description;
      if (typeof req.body?.ctaLabel === 'string') patch.ctaLabel = req.body.ctaLabel;
      if (typeof req.body?.targetUrl === 'string') patch.targetUrl = req.body.targetUrl;
      if (typeof req.body?.active === 'boolean') patch.active = req.body.active;
      if (Number.isFinite(req.body?.sortOrder)) patch.sortOrder = Number(req.body.sortOrder);

      const ad = await updateAd(id, patch);
      if (!ad) {
        res.status(404).json({ error: 'Advertisement not found' });
        return;
      }
      res.json({ ad });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update advertisement' });
    }
  });

  app.delete('/api/admin/ads/:id', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid ad ID' });
        return;
      }
      const ok = await deleteAd(id);
      if (!ok) {
        res.status(404).json({ error: 'Advertisement not found' });
        return;
      }
      res.json({ deleted: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete advertisement' });
    }
  });

  // ---------------- Frontend Serving & Dynamic Post SEO ----------------

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);

    app.use('*', async (req, res, next) => {
      if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/thumbnails/')) {
        next();
        return;
      }
      try {
        const templatePath = path.resolve(process.cwd(), 'index.html');
        let template = fs.readFileSync(templatePath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);

        if (isAdminHtmlRequest(req.originalUrl)) {
          template = injectAdminRouteIntoHtml(template);
          res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        } else {
          const match = req.originalUrl.match(/^\/post\/([a-z0-9-]+)(?:\?.*)?$/i);
          if (match) {
            const post = await getPostBySlug(match[1].toLowerCase(), false);
            if (post) {
              template = injectPostSeoIntoHtml(template, resolveBaseUrl(req), post);
            }
          }
        }

        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
  } else {
    const distDir = RUNTIME.distDir;
    if (!RUNTIME.hasBuiltDist) {
      console.warn('Production mode active, but dist/index.html was not found. Run "npm run build" before starting.');
    }
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), {
        immutable: true,
        maxAge: '1y',
      })
    );
    app.use(express.static(distDir, { index: false }));

    app.get('*', async (req, res) => {
      try {
        const indexPath = path.join(distDir, 'index.html');
        let html = fs.readFileSync(indexPath, 'utf-8');

        if (isAdminHtmlRequest(req.originalUrl)) {
          html = injectAdminRouteIntoHtml(html);
          res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        } else {
          const match = req.originalUrl.match(/^\/post\/([a-z0-9-]+)(?:\?.*)?$/i);
          if (match) {
            const post = await getPostBySlug(match[1].toLowerCase(), false);
            if (post) {
              html = injectPostSeoIntoHtml(html, resolveBaseUrl(req), post);
            }
          }
        }

        res
          .status(200)
          .set({
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache',
          })
          .send(html);
      } catch {
        res.status(500).send('Frontend build not found. Run npm run build first.');
      }
    });
  }

  // ---------------- Autonomous Backend AI Scheduler ----------------

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let adaptiveTimer: ReturnType<typeof setTimeout> | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;

  const scheduleNextAdaptiveCycle = async () => {
    if (shuttingDown || RUNTIME.checkIntervalSeconds !== null) return;
    let nextMinutes = RUNTIME.checkIntervalMinutes;
    try {
      nextMinutes = await getRecommendedIntervalMinutes();
    } catch {
      nextMinutes = RUNTIME.checkIntervalMinutes;
    }
    const delayMs = Math.max(1, nextMinutes) * 60 * 1000;
    adaptiveTimer = setTimeout(async () => {
      try {
        await runAutonomousCycle('scheduler');
      } catch (err) {
        console.error('Scheduled autonomous AI cycle error:', err);
      } finally {
        void scheduleNextAdaptiveCycle();
      }
    }, delayMs);
  };

  if (RUNTIME.checkIntervalSeconds !== null) {
    const intervalSec = RUNTIME.checkIntervalSeconds;
    intervalHandle = setInterval(() => {
      runAutonomousCycle('scheduler').catch((err) => {
        console.error('Scheduled autonomous AI cycle error:', err);
      });
    }, intervalSec * 1000);
  }

  const cadenceLabel =
    RUNTIME.checkIntervalSeconds !== null
      ? `${RUNTIME.checkIntervalSeconds}s`
      : 'AI-adaptive (1-15m)';

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `M R S Auto Blog listening on http://0.0.0.0:${PORT} (mode: ${IS_PROD ? 'production' : 'development'}, DB: ${getDbEngine()}, controller: AI autonomous, cadence: ${cadenceLabel})`
    );

    // Run non-blocking hub sync, monitoring, and AI self-healing maintenance immediately on startup
    startupTimer = setTimeout(async () => {
      try {
        await runAutonomousCycle('startup');
      } catch (err) {
        console.error('Initial startup autonomous AI error:', err);
      } finally {
        void scheduleNextAdaptiveCycle();
      }
    }, 1500);
  });

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);

    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    if (adaptiveTimer) {
      clearTimeout(adaptiveTimer);
      adaptiveTimer = null;
    }

    for (const sseRes of activeSseClients) {
      try {
        sseRes.end();
      } catch {
        // ignore closed streams
      }
    }
    activeSseClients.clear();

    const forceTimer = setTimeout(() => {
      console.warn('Graceful shutdown timed out; forcing exit.');
      process.exit(1);
    }, 8000);
    forceTimer.unref();

    server.close(async () => {
      try {
        await closeDb();
      } catch (err) {
        console.error('Error closing database:', err);
      } finally {
        clearTimeout(forceTimer);
        process.exit(0);
      }
    });
    server.closeIdleConnections?.();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
