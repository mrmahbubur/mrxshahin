import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import {
  addLog,
  claimAdminPasswordHashAtomic,
  createManualSite,
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
  listAllPosts,
  listAllPublishedPostsForFeed,
  listLogs,
  listPublishedPosts,
  listSites,
  getCategoriesWithCounts,
  setSetting,
  updatePost,
  updateSite,
} from './server/db.ts';
import { regeneratePostContent, regeneratePostThumbnailOnly } from './server/generator.ts';
import { checkSingleSite, isCheckRunning, runMonitoringCycle, syncHubSitesOnly } from './server/monitor.ts';
import {
  escapeXml,
  hashPassword,
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

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

function resolveBaseUrl(req: express.Request): string {
  const configured = process.env.SITE_URL?.trim() || process.env.APP_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
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

async function startServer(): Promise<void> {
  const dbEngine = await initDb();
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  // Health Check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      database: dbEngine,
      checkInProgress: isCheckRunning(),
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
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
      if (fs.existsSync(cachePath)) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(cachePath);
        return;
      }

      const record = await getThumbnailDataBySlug(safeSlug);
      if (!record) {
        res.status(404).send('Thumbnail not found');
        return;
      }

      const pngBuffer =
        record.data ?? (await buildFallbackThumbnailPng(record.title, record.siteName, safeSlug));
      saveThumbnailToDiskCache(safeSlug, pngBuffer);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
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
    </item>`;
        })
        .join('\n');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>M R S Auto Blog</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>Automated editorial publication tracking updates and innovations across monitored websites.</description>
    <language>en-us</language>
    <atom:link href="${escapeXml(baseUrl)}/rss.xml" rel="self" type="application/rss+xml" />
${itemsXml}
  </channel>
</rss>`;

      res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
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
      res.send(xml);
    } catch {
      res.status(500).send('Error generating sitemap');
    }
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

      res.json({ ...feed, categories });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load posts' });
    }
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
      res.json({ post, related });
    } catch {
      res.status(404).json({ error: 'Post not found' });
    }
  });

  app.get('/api/sites', async (_req, res) => {
    try {
      const sites = await listSites();
      res.json({
        sites: sites
          .filter((s) => s.active)
          .map((s) => ({
            id: s.id,
            name: s.name,
            url: s.url,
            source: s.source,
            lastCheckedAt: s.lastCheckedAt,
            lastStatus: s.lastStatus,
            postCount: s.postCount ?? 0,
          })),
      });
    } catch {
      res.status(500).json({ error: 'Failed to load sites' });
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
    if (process.env.ADMIN_PASSWORD?.trim()) return 'env';
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

      const envPass = process.env.ADMIN_PASSWORD?.trim();
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
      const [stats, sites, posts, logs] = await Promise.all([
        getAdminStats(),
        listSites(),
        listAllPosts(),
        listLogs(150),
      ]);
      res.json({
        stats,
        sites,
        posts,
        logs,
        checkInProgress: isCheckRunning(),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load dashboard' });
    }
  });

  app.post('/api/admin/check-now', requireAdmin, async (_req, res) => {
    try {
      const result = await runMonitoringCycle('manual');
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Monitoring check failed' });
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

      const validUrl = validateExternalUrl(rawUrl).toString().replace(/\/+$/, '');
      const validRss = rawRss ? validateExternalUrl(rawRss).toString() : null;
      const validSitemap = rawSitemap ? validateExternalUrl(rawSitemap).toString() : null;

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
      if (typeof req.body?.url === 'string') patch.url = validateExternalUrl(req.body.url).toString().replace(/\/+$/, '');
      if (req.body?.rssUrl !== undefined) {
        patch.rssUrl = req.body.rssUrl ? validateExternalUrl(String(req.body.rssUrl)).toString() : null;
      }
      if (req.body?.sitemapUrl !== undefined) {
        patch.sitemapUrl = req.body.sitemapUrl ? validateExternalUrl(String(req.body.sitemapUrl)).toString() : null;
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
      const ok = await deletePost(id);
      if (!ok) {
        res.status(404).json({ error: 'Post not found' });
        return;
      }
      res.json({ deleted: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete post' });
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

        const match = req.originalUrl.match(/^\/post\/([a-z0-9-]+)(?:\?.*)?$/i);
        if (match) {
          const post = await getPostBySlug(match[1].toLowerCase(), false);
          if (post) {
            template = injectPostSeoIntoHtml(template, resolveBaseUrl(req), post);
          }
        }

        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir, { index: false }));

    app.get('*', async (req, res) => {
      try {
        const indexPath = path.join(distDir, 'index.html');
        let html = fs.readFileSync(indexPath, 'utf-8');

        const match = req.originalUrl.match(/^\/post\/([a-z0-9-]+)(?:\?.*)?$/i);
        if (match) {
          const post = await getPostBySlug(match[1].toLowerCase(), false);
          if (post) {
            html = injectPostSeoIntoHtml(html, resolveBaseUrl(req), post);
          }
        }

        res.status(200).set({ 'Content-Type': 'text/html' }).send(html);
      } catch {
        res.status(500).send('Frontend build not found. Run npm run build first.');
      }
    });
  }

  // ---------------- Scheduler ----------------

  const rawInterval = Number(process.env.CHECK_INTERVAL_MINUTES || 10);
  const intervalMinutes = Number.isFinite(rawInterval) && rawInterval >= 1 ? Math.floor(rawInterval) : 10;
  const cronExpr = intervalMinutes < 60 ? `*/${intervalMinutes} * * * *` : '0 * * * *';

  cron.schedule(cronExpr, () => {
    runMonitoringCycle('scheduler').catch((err) => {
      console.error('Scheduled monitoring error:', err);
    });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`M R S Auto Blog listening on http://0.0.0.0:${PORT} (DB: ${getDbEngine()}, interval: ${intervalMinutes}m)`);

    // On first launch with empty sites list, perform non-blocking initial hub sync & check
    listSites()
      .then((sites) => {
        if (sites.length === 0) {
          setTimeout(() => {
            runMonitoringCycle('startup').catch((err) => {
              console.error('Initial startup monitoring error:', err);
            });
          }, 2000);
        }
      })
      .catch(() => {});
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
