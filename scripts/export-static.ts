import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runAutonomousCycle } from '../server/aiController.ts';
import {
  closeDb,
  getCategoriesWithCounts,
  getSiteById,
  getThumbnailDataBySlug,
  initDb,
  listActiveAds,
  listAllPublishedPostsForFeed,
} from '../server/db.ts';
import { escapeXml, validateSlug } from '../server/security.ts';
import { buildFallbackThumbnailPng, getThumbnailCachePath } from '../server/thumbnails.ts';

function getArgValue(prefix: string): string | null {
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length).trim() : null;
}

async function main(): Promise<void> {
  const seedIfEmpty = process.argv.includes('--seed-if-empty');
  const rawSiteUrl =
    getArgValue('--site-url=') || process.env.SITE_URL || 'https://mrs-auto-blog.github.io';
  const baseUrl = rawSiteUrl.replace(/\/+$/, '');

  const distDir = path.resolve(process.cwd(), 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ directory not found. Run "npm run build" before exporting static files.');
  }

  await initDb();

  try {
    let posts = await listAllPublishedPostsForFeed(200);
    if (posts.length === 0 && seedIfEmpty) {
      console.log('No cached posts found; running live monitoring cycle for static export...');
      try {
        await runAutonomousCycle('startup');
      } catch (err) {
        console.warn('Live monitoring cycle completed with partial warnings:', err);
      }
      posts = await listAllPublishedPostsForFeed(200);
    }

    const [categories, ads] = await Promise.all([
      getCategoriesWithCounts(),
      listActiveAds(),
    ]);

    const staticDataDir = path.join(distDir, 'static-data');
    const thumbnailsDir = path.join(distDir, 'thumbnails');
    fs.mkdirSync(staticDataDir, { recursive: true });
    fs.mkdirSync(thumbnailsDir, { recursive: true });

    const exportedPosts = posts.map((p) => ({
      id: p.id,
      siteId: p.siteId,
      siteName: p.siteName,
      siteUrl: p.siteUrl,
      title: p.title,
      slug: p.slug,
      metaDescription: p.metaDescription,
      summary: p.summary,
      contentHtml: p.contentHtml,
      tags: p.tags,
      category: p.category,
      status: p.status,
      readingTimeMinutes: p.readingTimeMinutes,
      thumbnailUrl: p.thumbnailUrl,
      publishedAt: p.publishedAt,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
    }));

    fs.writeFileSync(
      path.join(staticDataDir, 'posts.json'),
      JSON.stringify({
        posts: exportedPosts,
        categories,
        exportedAt: new Date().toISOString(),
      }),
      'utf8'
    );

    const exportedAds = ads.map((ad) => ({
      id: ad.id,
      slot: ad.slot,
      advertiserName: ad.advertiserName,
      displayDomain: ad.displayDomain,
      categoryLabel: ad.categoryLabel,
      headline: ad.headline,
      description: ad.description,
      ctaLabel: ad.ctaLabel,
      targetUrl: ad.targetUrl,
    }));

    fs.writeFileSync(
      path.join(staticDataDir, 'ads.json'),
      JSON.stringify({ ads: exportedAds }),
      'utf8'
    );

    // Export 16:9 PNG thumbnails for every published post
    for (const post of posts) {
      try {
        const safeSlug = validateSlug(post.slug);
        const destPath = path.join(thumbnailsDir, `${safeSlug}.png`);
        const cachePath = getThumbnailCachePath(safeSlug);

        if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 100) {
          fs.copyFileSync(cachePath, destPath);
          continue;
        }

        const record = await getThumbnailDataBySlug(safeSlug);
        if (record?.data && record.data.length > 100) {
          fs.writeFileSync(destPath, record.data);
          continue;
        }

        const site = post.siteId ? await getSiteById(post.siteId) : null;
        const fallbackPng = await buildFallbackThumbnailPng(
          post.title,
          post.siteName,
          safeSlug,
          site?.themeColor
        );
        fs.writeFileSync(destPath, fallbackPng);
      } catch (err) {
        console.warn(`Skipped thumbnail export for ${post.slug}:`, err);
      }
    }

    // Export RSS 2.0 Feed
    const rssItemsXml = posts
      .slice(0, 40)
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

    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>M R S Auto Blog</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>Automated editorial publication tracking updates and innovations across monitored websites.</description>
    <language>en-us</language>
    <atom:link href="${escapeXml(baseUrl)}/rss.xml" rel="self" type="application/rss+xml" />
${rssItemsXml}
  </channel>
</rss>`;
    fs.writeFileSync(path.join(distDir, 'rss.xml'), rssXml, 'utf8');

    // Export XML Sitemap
    const sitemapUrls = [
      `  <url>\n    <loc>${escapeXml(baseUrl)}/</loc>\n    <changefreq>hourly</changefreq>\n    <priority>1.0</priority>\n  </url>`,
      ...posts.map(
        (p) =>
          `  <url>\n    <loc>${escapeXml(`${baseUrl}/post/${p.slug}`)}</loc>\n    <lastmod>${new Date(p.updatedAt).toISOString()}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`
      ),
    ].join('\n');
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapUrls}
</urlset>`;
    fs.writeFileSync(path.join(distDir, 'sitemap.xml'), sitemapXml, 'utf8');

    // GitHub Pages SPA deep-link fallback & Jekyll bypass
    const indexPath = path.join(distDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      fs.copyFileSync(indexPath, path.join(distDir, '404.html'));
    }
    fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');

    console.log(
      `Static export complete: ${exportedPosts.length} post(s), ${exportedAds.length} ad(s), thumbnails, rss.xml, sitemap.xml, 404.html, and .nojekyll written to dist/.`
    );
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error('Static export failed:', err);
  process.exit(1);
});
