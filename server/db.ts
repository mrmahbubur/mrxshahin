import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { getDatabaseUrl } from './env.ts';
import { normalizeExternalUrl, validateExternalUrl } from './security.ts';
import type {
  AdHealthStatus,
  AdRecord,
  AdSlot,
  ChangeReport,
  DbEngine,
  GithubActivity,
  HeadingItem,
  ImageItem,
  LinkItem,
  LogLevel,
  LogRecord,
  PostRecord,
  PostStatus,
  PublicPostSummary,
  RssEntry,
  SiteRecord,
  SiteSource,
  SiteStatus,
  SnapshotRecord,
} from './types.ts';

const { Pool } = pg;

let pgPool: pg.Pool | null = null;
let sqliteDb: Database.Database | null = null;
let activeEngine: DbEngine = 'sqlite';

function nowIso(): string {
  return new Date().toISOString();
}

export function getDbEngine(): DbEngine {
  return activeEngine;
}

export async function closeDb(): Promise<void> {
  const errors: unknown[] = [];

  if (pgPool) {
    const pool = pgPool;
    pgPool = null;
    try {
      await pool.end();
    } catch (err) {
      errors.push(err);
    }
  }

  if (sqliteDb) {
    const db = sqliteDb;
    sqliteDb = null;
    try {
      db.close();
    } catch (err) {
      errors.push(err);
    }
  }

  if (errors.length > 0) {
    throw errors[0];
  }
}

export async function initDb(): Promise<DbEngine> {
  const databaseUrl = getDatabaseUrl();

  if (databaseUrl) {
    try {
      pgPool = new Pool({
        connectionString: databaseUrl,
        ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
          ? false
          : { rejectUnauthorized: false },
        max: 10,
      });

      await pgPool.query('SELECT 1');
      await createPostgresSchema(pgPool);
      activeEngine = 'postgres';
      await seedDefaultSettings();
      await seedDefaultAds();
      return activeEngine;
    } catch (err) {
      console.error('Postgres connection failed, falling back to SQLite:', err);
      pgPool = null;
    }
  }

  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'autoblog.db');
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
  createSqliteSchema(sqliteDb);
  activeEngine = 'sqlite';
  await seedDefaultSettings();
  await seedDefaultAds();
  return activeEngine;
}

async function createPostgresSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      rss_url TEXT,
      sitemap_url TEXT,
      github_repo TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_checked_at TEXT,
      last_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      theme_color TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      page_url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      meta_description TEXT NOT NULL DEFAULT '',
      headings_json TEXT NOT NULL DEFAULT '[]',
      main_text TEXT NOT NULL DEFAULT '',
      links_json TEXT NOT NULL DEFAULT '[]',
      images_json TEXT NOT NULL DEFAULT '[]',
      nav_items_json TEXT NOT NULL DEFAULT '[]',
      sitemap_urls_json TEXT NOT NULL DEFAULT '[]',
      rss_items_json TEXT NOT NULL DEFAULT '[]',
      github_data_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_site_created ON snapshots(site_id, id DESC);

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
      site_name TEXT NOT NULL,
      site_url TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      meta_description TEXT NOT NULL,
      summary TEXT NOT NULL,
      content_html TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL,
      change_hash TEXT NOT NULL,
      change_report_json TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      reading_time_minutes INTEGER NOT NULL DEFAULT 4,
      thumbnail_url TEXT NOT NULL,
      thumbnail_data BYTEA,
      published_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_posts_status_pub ON posts(status, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_change_hash ON posts(site_id, change_hash);

    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      level TEXT NOT NULL,
      site_id INTEGER,
      site_name TEXT,
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(id DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      slot TEXT NOT NULL DEFAULT 'inline',
      advertiser_name TEXT NOT NULL,
      display_domain TEXT NOT NULL,
      category_label TEXT NOT NULL,
      headline TEXT NOT NULL,
      description TEXT NOT NULL,
      cta_label TEXT NOT NULL,
      target_url TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      last_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ads_active_slot ON ads(active, slot, sort_order ASC, id ASC);
  `);
}

function createSqliteSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      rss_url TEXT,
      sitemap_url TEXT,
      github_repo TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      active INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      last_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      theme_color TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      page_url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      meta_description TEXT NOT NULL DEFAULT '',
      headings_json TEXT NOT NULL DEFAULT '[]',
      main_text TEXT NOT NULL DEFAULT '',
      links_json TEXT NOT NULL DEFAULT '[]',
      images_json TEXT NOT NULL DEFAULT '[]',
      nav_items_json TEXT NOT NULL DEFAULT '[]',
      sitemap_urls_json TEXT NOT NULL DEFAULT '[]',
      rss_items_json TEXT NOT NULL DEFAULT '[]',
      github_data_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_site_created ON snapshots(site_id, id DESC);

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
      site_name TEXT NOT NULL,
      site_url TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      meta_description TEXT NOT NULL,
      summary TEXT NOT NULL,
      content_html TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL,
      change_hash TEXT NOT NULL,
      change_report_json TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      reading_time_minutes INTEGER NOT NULL DEFAULT 4,
      thumbnail_url TEXT NOT NULL,
      thumbnail_data BLOB,
      published_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_posts_status_pub ON posts(status, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_change_hash ON posts(site_id, change_hash);

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      site_id INTEGER,
      site_name TEXT,
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(id DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot TEXT NOT NULL DEFAULT 'inline',
      advertiser_name TEXT NOT NULL,
      display_domain TEXT NOT NULL,
      category_label TEXT NOT NULL,
      headline TEXT NOT NULL,
      description TEXT NOT NULL,
      cta_label TEXT NOT NULL,
      target_url TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      last_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ads_active_slot ON ads(active, slot, sort_order ASC, id ASC);
  `);
}

async function seedDefaultSettings(): Promise<void> {
  const draftMode = await getSetting('draft_mode');
  if (draftMode === null) {
    await setSetting('draft_mode', 'false');
  }
  const hubUrl = await getSetting('hub_url');
  if (hubUrl === null) {
    await setSetting('hub_url', 'https://mrxshahin.ai.studio');
  }
  const aiAutopilot = await getSetting('ai_autopilot_enabled');
  if (aiAutopilot === null) {
    await setSetting('ai_autopilot_enabled', 'true');
  }
  const aiInterval = await getSetting('ai_recommended_interval_minutes');
  if (aiInterval === null) {
    await setSetting('ai_recommended_interval_minutes', '1');
  }
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapSiteRow(row: Record<string, unknown>): SiteRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    url: String(row.url),
    rssUrl: row.rss_url ? String(row.rss_url) : null,
    sitemapUrl: row.sitemap_url ? String(row.sitemap_url) : null,
    githubRepo: row.github_repo ? String(row.github_repo) : null,
    source: (row.source === 'hub' ? 'hub' : 'manual') as SiteSource,
    active: Boolean(row.active),
    lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
    lastStatus: (row.last_status as SiteStatus) || 'pending',
    lastError: row.last_error ? String(row.last_error) : null,
    themeColor: row.theme_color ? String(row.theme_color) : null,
    createdAt: String(row.created_at),
    postCount: row.post_count !== undefined ? Number(row.post_count) : undefined,
  };
}

function mapSnapshotRow(row: Record<string, unknown>): SnapshotRecord {
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    pageUrl: String(row.page_url),
    contentHash: String(row.content_hash),
    title: String(row.title ?? ''),
    metaDescription: String(row.meta_description ?? ''),
    headings: safeJsonParse<HeadingItem[]>(row.headings_json as string, []),
    mainText: String(row.main_text ?? ''),
    links: safeJsonParse<LinkItem[]>(row.links_json as string, []),
    images: safeJsonParse<ImageItem[]>(row.images_json as string, []),
    navItems: safeJsonParse<string[]>(row.nav_items_json as string, []),
    sitemapUrls: safeJsonParse<string[]>(row.sitemap_urls_json as string, []),
    rssItems: safeJsonParse<RssEntry[]>(row.rss_items_json as string, []),
    githubData: safeJsonParse<GithubActivity | null>(row.github_data_json as string, null),
    createdAt: String(row.created_at),
  };
}

function normalizePostThumbnailUrl(rawUrl: unknown, slug: string): string {
  const trimmed = rawUrl ? String(rawUrl).trim() : '';
  return trimmed.startsWith('/thumbnails/') ? trimmed : `/thumbnails/${slug}.png`;
}

function mapPostRow(row: Record<string, unknown>): PostRecord {
  const slug = String(row.slug);
  return {
    id: Number(row.id),
    siteId: row.site_id !== null && row.site_id !== undefined ? Number(row.site_id) : null,
    siteName: String(row.site_name),
    siteUrl: String(row.site_url),
    title: String(row.title),
    slug,
    metaDescription: String(row.meta_description),
    summary: String(row.summary),
    contentHtml: String(row.content_html),
    tags: safeJsonParse<string[]>(row.tags_json as string, []),
    category: String(row.category),
    changeHash: String(row.change_hash),
    changeReport: safeJsonParse<ChangeReport | null>(row.change_report_json as string, null),
    status: (row.status === 'draft' ? 'draft' : 'published') as PostStatus,
    readingTimeMinutes: Number(row.reading_time_minutes || 4),
    thumbnailUrl: normalizePostThumbnailUrl(row.thumbnail_url, slug),
    publishedAt: String(row.published_at),
    updatedAt: String(row.updated_at),
    createdAt: String(row.created_at),
  };
}

function mapPublicPostSummaryRow(row: Record<string, unknown>): PublicPostSummary {
  const slug = String(row.slug);
  return {
    id: Number(row.id),
    siteId: row.site_id !== null && row.site_id !== undefined ? Number(row.site_id) : null,
    siteName: String(row.site_name),
    siteUrl: String(row.site_url),
    title: String(row.title),
    slug,
    metaDescription: String(row.meta_description),
    summary: String(row.summary),
    tags: safeJsonParse<string[]>(row.tags_json as string, []),
    category: String(row.category),
    status: (row.status === 'draft' ? 'draft' : 'published') as PostStatus,
    readingTimeMinutes: Number(row.reading_time_minutes || 4),
    thumbnailUrl: normalizePostThumbnailUrl(row.thumbnail_url, slug),
    publishedAt: String(row.published_at),
    updatedAt: String(row.updated_at),
  };
}

function mapLogRow(row: Record<string, unknown>): LogRecord {
  return {
    id: Number(row.id),
    level: (row.level as LogLevel) || 'info',
    siteId: row.site_id !== null && row.site_id !== undefined ? Number(row.site_id) : null,
    siteName: row.site_name ? String(row.site_name) : null,
    action: String(row.action),
    message: String(row.message),
    details: row.details ? String(row.details) : null,
    createdAt: String(row.created_at),
  };
}

// ---------------- Settings ----------------

export async function getSetting(key: string): Promise<string | null> {
  if (pgPool) {
    const res = await pgPool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return res.rows[0]?.value ?? null;
  }
  const row = sqliteDb!.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  if (pgPool) {
    await pgPool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, value]
    );
    return;
  }
  sqliteDb!
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export async function claimAdminPasswordHashAtomic(hash: string): Promise<boolean> {
  if (pgPool) {
    const res = await pgPool.query(
      "INSERT INTO settings (key, value) VALUES ('admin_password_hash', $1) ON CONFLICT (key) DO NOTHING RETURNING key",
      [hash]
    );
    return (res.rowCount ?? 0) > 0;
  }
  const res = sqliteDb!
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_password_hash', ?)")
    .run(hash);
  return res.changes > 0;
}

// ---------------- Sites ----------------

export async function listSites(): Promise<SiteRecord[]> {
  if (pgPool) {
    const res = await pgPool.query(`
      SELECT s.*, COALESCE(p.cnt, 0) AS post_count
      FROM sites s
      LEFT JOIN (
        SELECT site_id, COUNT(*) AS cnt FROM posts WHERE status = 'published' GROUP BY site_id
      ) p ON p.site_id = s.id
      ORDER BY s.source ASC, s.name ASC
    `);
    return res.rows.map(mapSiteRow);
  }
  const rows = sqliteDb!
    .prepare(`
      SELECT s.*, COALESCE(p.cnt, 0) AS post_count
      FROM sites s
      LEFT JOIN (
        SELECT site_id, COUNT(*) AS cnt FROM posts WHERE status = 'published' GROUP BY site_id
      ) p ON p.site_id = s.id
      ORDER BY s.source ASC, s.name ASC
    `)
    .all() as Record<string, unknown>[];
  return rows.map(mapSiteRow);
}

export async function listActiveSites(): Promise<SiteRecord[]> {
  if (pgPool) {
    const res = await pgPool.query('SELECT * FROM sites WHERE active = TRUE ORDER BY id ASC');
    return res.rows.map(mapSiteRow);
  }
  const rows = sqliteDb!.prepare('SELECT * FROM sites WHERE active = 1 ORDER BY id ASC').all() as Record<string, unknown>[];
  return rows.map(mapSiteRow);
}

export async function getSiteById(id: number): Promise<SiteRecord | null> {
  if (pgPool) {
    const res = await pgPool.query('SELECT * FROM sites WHERE id = $1', [id]);
    return res.rows[0] ? mapSiteRow(res.rows[0]) : null;
  }
  const row = sqliteDb!.prepare('SELECT * FROM sites WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapSiteRow(row) : null;
}

export async function upsertHubSite(input: {
  name: string;
  url: string;
  githubRepo?: string | null;
}): Promise<{ site: SiteRecord; created: boolean }> {
  const normalizedUrl = normalizeExternalUrl(input.url);
  const createdAt = nowIso();
  if (pgPool) {
    const existing = await pgPool.query('SELECT * FROM sites WHERE url = $1', [normalizedUrl]);
    if (existing.rows[0]) {
      const updated = await pgPool.query(
        'UPDATE sites SET name = COALESCE(NULLIF($1, \'\'), name), github_repo = COALESCE($2, github_repo) WHERE id = $3 RETURNING *',
        [input.name, input.githubRepo ?? null, existing.rows[0].id]
      );
      return { site: mapSiteRow(updated.rows[0]), created: false };
    }
    const inserted = await pgPool.query(
      `INSERT INTO sites (name, url, github_repo, source, active, last_status, created_at)
       VALUES ($1, $2, $3, 'hub', TRUE, 'pending', $4) RETURNING *`,
      [input.name, normalizedUrl, input.githubRepo ?? null, createdAt]
    );
    return { site: mapSiteRow(inserted.rows[0]), created: true };
  }

  const existing = sqliteDb!.prepare('SELECT * FROM sites WHERE url = ?').get(normalizedUrl) as Record<string, unknown> | undefined;
  if (existing) {
    sqliteDb!
      .prepare("UPDATE sites SET name = COALESCE(NULLIF(?, ''), name), github_repo = COALESCE(?, github_repo) WHERE id = ?")
      .run(input.name, input.githubRepo ?? null, existing.id);
    const updated = sqliteDb!.prepare('SELECT * FROM sites WHERE id = ?').get(existing.id) as Record<string, unknown>;
    return { site: mapSiteRow(updated), created: false };
  }
  const info = sqliteDb!
    .prepare(
      "INSERT INTO sites (name, url, github_repo, source, active, last_status, created_at) VALUES (?, ?, ?, 'hub', 1, 'pending', ?)"
    )
    .run(input.name, normalizedUrl, input.githubRepo ?? null, createdAt);
  const created = sqliteDb!.prepare('SELECT * FROM sites WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
  return { site: mapSiteRow(created), created: true };
}

export async function createManualSite(input: {
  name: string;
  url: string;
  rssUrl?: string | null;
  sitemapUrl?: string | null;
  githubRepo?: string | null;
}): Promise<SiteRecord> {
  const normalizedUrl = normalizeExternalUrl(input.url);
  const normalizedRss = input.rssUrl ? normalizeExternalUrl(input.rssUrl) : null;
  const normalizedSitemap = input.sitemapUrl ? normalizeExternalUrl(input.sitemapUrl) : null;
  const createdAt = nowIso();
  if (pgPool) {
    const res = await pgPool.query(
      `INSERT INTO sites (name, url, rss_url, sitemap_url, github_repo, source, active, last_status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'manual', TRUE, 'pending', $6)
       RETURNING *`,
      [input.name, normalizedUrl, normalizedRss, normalizedSitemap, input.githubRepo ?? null, createdAt]
    );
    return mapSiteRow(res.rows[0]);
  }
  const info = sqliteDb!
    .prepare(
      `INSERT INTO sites (name, url, rss_url, sitemap_url, github_repo, source, active, last_status, created_at)
       VALUES (?, ?, ?, ?, ?, 'manual', 1, 'pending', ?)`
    )
    .run(input.name, normalizedUrl, normalizedRss, normalizedSitemap, input.githubRepo ?? null, createdAt);
  const row = sqliteDb!.prepare('SELECT * FROM sites WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
  return mapSiteRow(row);
}

export async function updateSite(
  id: number,
  patch: Partial<{
    name: string;
    url: string;
    rssUrl: string | null;
    sitemapUrl: string | null;
    githubRepo: string | null;
    active: boolean;
  }>
): Promise<SiteRecord | null> {
  const current = await getSiteById(id);
  if (!current) return null;

  const next = {
    name: patch.name ?? current.name,
    url: patch.url ? normalizeExternalUrl(patch.url) : current.url,
    rssUrl: patch.rssUrl !== undefined ? (patch.rssUrl ? normalizeExternalUrl(patch.rssUrl) : null) : current.rssUrl,
    sitemapUrl:
      patch.sitemapUrl !== undefined
        ? patch.sitemapUrl
          ? normalizeExternalUrl(patch.sitemapUrl)
          : null
        : current.sitemapUrl,
    githubRepo: patch.githubRepo !== undefined ? patch.githubRepo : current.githubRepo,
    active: patch.active !== undefined ? patch.active : current.active,
  };

  if (pgPool) {
    const res = await pgPool.query(
      `UPDATE sites SET name = $1, url = $2, rss_url = $3, sitemap_url = $4, github_repo = $5, active = $6 WHERE id = $7 RETURNING *`,
      [next.name, next.url, next.rssUrl, next.sitemapUrl, next.githubRepo, next.active, id]
    );
    return res.rows[0] ? mapSiteRow(res.rows[0]) : null;
  }

  sqliteDb!
    .prepare(
      `UPDATE sites SET name = ?, url = ?, rss_url = ?, sitemap_url = ?, github_repo = ?, active = ? WHERE id = ?`
    )
    .run(next.name, next.url, next.rssUrl, next.sitemapUrl, next.githubRepo, next.active ? 1 : 0, id);
  return getSiteById(id);
}

export async function updateSiteStatus(
  id: number,
  status: SiteStatus,
  error: string | null,
  themeColor?: string | null
): Promise<void> {
  const ts = nowIso();
  if (pgPool) {
    await pgPool.query(
      'UPDATE sites SET last_checked_at = $1, last_status = $2, last_error = $3, theme_color = COALESCE($4, theme_color) WHERE id = $5',
      [ts, status, error, themeColor ?? null, id]
    );
    return;
  }
  sqliteDb!
    .prepare(
      'UPDATE sites SET last_checked_at = ?, last_status = ?, last_error = ?, theme_color = COALESCE(?, theme_color) WHERE id = ?'
    )
    .run(ts, status, error, themeColor ?? null, id);
}

export async function updateSiteDiscoveredMetadata(
  id: number,
  discovered: {
    rssUrl?: string | null;
    sitemapUrl?: string | null;
    githubRepo?: string | null;
  }
): Promise<void> {
  const current = await getSiteById(id);
  if (!current) return;

  const nextRss = !current.rssUrl && discovered.rssUrl ? normalizeExternalUrl(discovered.rssUrl) : current.rssUrl;
  const nextSitemap =
    !current.sitemapUrl && discovered.sitemapUrl ? normalizeExternalUrl(discovered.sitemapUrl) : current.sitemapUrl;
  const nextGithub = !current.githubRepo && discovered.githubRepo ? discovered.githubRepo.trim() : current.githubRepo;

  if (nextRss === current.rssUrl && nextSitemap === current.sitemapUrl && nextGithub === current.githubRepo) {
    return;
  }

  if (pgPool) {
    await pgPool.query('UPDATE sites SET rss_url = $1, sitemap_url = $2, github_repo = $3 WHERE id = $4', [
      nextRss,
      nextSitemap,
      nextGithub,
      id,
    ]);
    return;
  }

  sqliteDb!
    .prepare('UPDATE sites SET rss_url = ?, sitemap_url = ?, github_repo = ? WHERE id = ?')
    .run(nextRss, nextSitemap, nextGithub, id);
}

export async function deleteSite(id: number): Promise<boolean> {
  if (pgPool) {
    const res = await pgPool.query('DELETE FROM sites WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
  const res = sqliteDb!.prepare('DELETE FROM sites WHERE id = ?').run(id);
  return res.changes > 0;
}

// ---------------- Snapshots ----------------

export async function getLatestSnapshot(siteId: number): Promise<SnapshotRecord | null> {
  if (pgPool) {
    const res = await pgPool.query('SELECT * FROM snapshots WHERE site_id = $1 ORDER BY id DESC LIMIT 1', [siteId]);
    return res.rows[0] ? mapSnapshotRow(res.rows[0]) : null;
  }
  const row = sqliteDb!
    .prepare('SELECT * FROM snapshots WHERE site_id = ? ORDER BY id DESC LIMIT 1')
    .get(siteId) as Record<string, unknown> | undefined;
  return row ? mapSnapshotRow(row) : null;
}

export async function saveSnapshot(input: Omit<SnapshotRecord, 'id' | 'createdAt'>): Promise<SnapshotRecord> {
  const createdAt = nowIso();
  const headingsJson = JSON.stringify(input.headings);
  const linksJson = JSON.stringify(input.links);
  const imagesJson = JSON.stringify(input.images);
  const navItemsJson = JSON.stringify(input.navItems);
  const sitemapUrlsJson = JSON.stringify(input.sitemapUrls);
  const rssItemsJson = JSON.stringify(input.rssItems);
  const githubDataJson = input.githubData ? JSON.stringify(input.githubData) : null;

  if (pgPool) {
    const res = await pgPool.query(
      `INSERT INTO snapshots (
        site_id, page_url, content_hash, title, meta_description,
        headings_json, main_text, links_json, images_json, nav_items_json,
        sitemap_urls_json, rss_items_json, github_data_json, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        input.siteId,
        input.pageUrl,
        input.contentHash,
        input.title,
        input.metaDescription,
        headingsJson,
        input.mainText,
        linksJson,
        imagesJson,
        navItemsJson,
        sitemapUrlsJson,
        rssItemsJson,
        githubDataJson,
        createdAt,
      ]
    );
    return mapSnapshotRow(res.rows[0]);
  }

  const info = sqliteDb!
    .prepare(
      `INSERT INTO snapshots (
        site_id, page_url, content_hash, title, meta_description,
        headings_json, main_text, links_json, images_json, nav_items_json,
        sitemap_urls_json, rss_items_json, github_data_json, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.siteId,
      input.pageUrl,
      input.contentHash,
      input.title,
      input.metaDescription,
      headingsJson,
      input.mainText,
      linksJson,
      imagesJson,
      navItemsJson,
      sitemapUrlsJson,
      rssItemsJson,
      githubDataJson,
      createdAt
    );

  const row = sqliteDb!.prepare('SELECT * FROM snapshots WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
  return mapSnapshotRow(row);
}

// ---------------- Posts ----------------

export async function listPublishedPosts(options: {
  category?: string;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<{ posts: PublicPostSummary[]; total: number; page: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(50, Math.max(1, options.limit ?? 9));
  const offset = (page - 1) * limit;
  const category = options.category?.trim() || '';
  const search = options.search?.trim() || '';

  if (pgPool) {
    const conditions: string[] = ["status = 'published'"];
    const params: unknown[] = [];
    if (category && category.toLowerCase() !== 'all') {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      conditions.push(`(title ILIKE $${idx} OR summary ILIKE $${idx} OR site_name ILIKE $${idx} OR tags_json ILIKE $${idx})`);
    }
    const whereSql = conditions.join(' AND ');
    const countRes = await pgPool.query(`SELECT COUNT(*) AS cnt FROM posts WHERE ${whereSql}`, params);
    const total = Number(countRes.rows[0]?.cnt ?? 0);

    params.push(limit, offset);
    const rowsRes = await pgPool.query(
      `SELECT id, site_id, site_name, site_url, title, slug, meta_description, summary, tags_json, category, status, reading_time_minutes, thumbnail_url, published_at, updated_at
       FROM posts WHERE ${whereSql}
       ORDER BY published_at DESC, id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      posts: rowsRes.rows.map(mapPublicPostSummaryRow),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  const conditions: string[] = ["status = 'published'"];
  const params: unknown[] = [];
  if (category && category.toLowerCase() !== 'all') {
    conditions.push('category = ?');
    params.push(category);
  }
  if (search) {
    const like = `%${search.toLowerCase()}%`;
    conditions.push('(LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(site_name) LIKE ? OR LOWER(tags_json) LIKE ?)');
    params.push(like, like, like, like);
  }
  const whereSql = conditions.join(' AND ');
  const countRow = sqliteDb!.prepare(`SELECT COUNT(*) AS cnt FROM posts WHERE ${whereSql}`).get(...params) as { cnt: number };
  const total = Number(countRow?.cnt ?? 0);

  const rows = sqliteDb!
    .prepare(
      `SELECT id, site_id, site_name, site_url, title, slug, meta_description, summary, tags_json, category, status, reading_time_minutes, thumbnail_url, published_at, updated_at
       FROM posts WHERE ${whereSql}
       ORDER BY published_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return {
    posts: rows.map(mapPublicPostSummaryRow),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function listAllPosts(): Promise<PostRecord[]> {
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT id, site_id, site_name, site_url, title, slug, meta_description, summary, content_html, tags_json, category, change_hash, change_report_json, status, reading_time_minutes, thumbnail_url, published_at, updated_at, created_at
       FROM posts ORDER BY published_at DESC, id DESC`
    );
    return res.rows.map(mapPostRow);
  }
  const rows = sqliteDb!
    .prepare(
      `SELECT id, site_id, site_name, site_url, title, slug, meta_description, summary, content_html, tags_json, category, change_hash, change_report_json, status, reading_time_minutes, thumbnail_url, published_at, updated_at, created_at
       FROM posts ORDER BY published_at DESC, id DESC`
    )
    .all() as Record<string, unknown>[];
  return rows.map(mapPostRow);
}

export async function listAllPublishedPostsForFeed(limit = 50): Promise<PostRecord[]> {
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT id, site_id, site_name, site_url, title, slug, meta_description, summary, content_html, tags_json, category, change_hash, change_report_json, status, reading_time_minutes, thumbnail_url, published_at, updated_at, created_at
       FROM posts WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map(mapPostRow);
  }
  const rows = sqliteDb!
    .prepare(
      `SELECT id, site_id, site_name, site_url, title, slug, meta_description, summary, content_html, tags_json, category, change_hash, change_report_json, status, reading_time_minutes, thumbnail_url, published_at, updated_at, created_at
       FROM posts WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(mapPostRow);
}

export async function getCategoriesWithCounts(): Promise<Array<{ category: string; count: number }>> {
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT category, COUNT(*) AS cnt FROM posts WHERE status = 'published' GROUP BY category ORDER BY cnt DESC, category ASC`
    );
    return res.rows.map((r) => ({ category: String(r.category), count: Number(r.cnt) }));
  }
  const rows = sqliteDb!
    .prepare(
      `SELECT category, COUNT(*) AS cnt FROM posts WHERE status = 'published' GROUP BY category ORDER BY cnt DESC, category ASC`
    )
    .all() as Array<{ category: string; cnt: number }>;
  return rows.map((r) => ({ category: String(r.category), count: Number(r.cnt) }));
}

export async function getPostBySlug(slug: string, includeDrafts = false): Promise<PostRecord | null> {
  if (pgPool) {
    const sql = includeDrafts
      ? 'SELECT * FROM posts WHERE slug = $1'
      : "SELECT * FROM posts WHERE slug = $1 AND status = 'published'";
    const res = await pgPool.query(sql, [slug]);
    return res.rows[0] ? mapPostRow(res.rows[0]) : null;
  }
  const sql = includeDrafts
    ? 'SELECT * FROM posts WHERE slug = ?'
    : "SELECT * FROM posts WHERE slug = ? AND status = 'published'";
  const row = sqliteDb!.prepare(sql).get(slug) as Record<string, unknown> | undefined;
  return row ? mapPostRow(row) : null;
}

export async function getPostById(id: number): Promise<PostRecord | null> {
  if (pgPool) {
    const res = await pgPool.query('SELECT * FROM posts WHERE id = $1', [id]);
    return res.rows[0] ? mapPostRow(res.rows[0]) : null;
  }
  const row = sqliteDb!.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapPostRow(row) : null;
}

export async function getRelatedPosts(postId: number, category: string, limit = 3): Promise<PublicPostSummary[]> {
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT id, site_id, site_name, site_url, title, slug, meta_description, summary, tags_json, category, status, reading_time_minutes, thumbnail_url, published_at, updated_at
       FROM posts
       WHERE status = 'published' AND id != $1
       ORDER BY (CASE WHEN category = $2 THEN 0 ELSE 1 END), published_at DESC
       LIMIT $3`,
      [postId, category, limit]
    );
    return res.rows.map(mapPublicPostSummaryRow);
  }
  const rows = sqliteDb!
    .prepare(
      `SELECT id, site_id, site_name, site_url, title, slug, meta_description, summary, tags_json, category, status, reading_time_minutes, thumbnail_url, published_at, updated_at
       FROM posts
       WHERE status = 'published' AND id != ?
       ORDER BY (CASE WHEN category = ? THEN 0 ELSE 1 END), published_at DESC
       LIMIT ?`
    )
    .all(postId, category, limit) as Record<string, unknown>[];
  return rows.map(mapPublicPostSummaryRow);
}

export async function hasPostWithChangeHash(siteId: number, changeHash: string): Promise<boolean> {
  if (pgPool) {
    const res = await pgPool.query('SELECT 1 FROM posts WHERE site_id = $1 AND change_hash = $2 LIMIT 1', [
      siteId,
      changeHash,
    ]);
    return (res.rowCount ?? 0) > 0;
  }
  const row = sqliteDb!
    .prepare('SELECT 1 FROM posts WHERE site_id = ? AND change_hash = ? LIMIT 1')
    .get(siteId, changeHash);
  return Boolean(row);
}

export async function countPostsForSite(siteId: number): Promise<number> {
  if (pgPool) {
    const res = await pgPool.query('SELECT COUNT(*) AS cnt FROM posts WHERE site_id = $1', [siteId]);
    return Number(res.rows[0]?.cnt ?? 0);
  }
  const row = sqliteDb!.prepare('SELECT COUNT(*) AS cnt FROM posts WHERE site_id = ?').get(siteId) as { cnt: number };
  return Number(row?.cnt ?? 0);
}

export async function ensureUniqueSlug(desiredSlug: string): Promise<string> {
  let candidate = desiredSlug;
  let counter = 2;
  while (true) {
    const exists = await getPostBySlug(candidate, true);
    if (!exists) return candidate;
    candidate = `${desiredSlug}-${counter}`;
    counter++;
  }
}

export async function createPost(input: {
  siteId: number | null;
  siteName: string;
  siteUrl: string;
  title: string;
  slug: string;
  metaDescription: string;
  summary: string;
  contentHtml: string;
  tags: string[];
  category: string;
  changeHash: string;
  changeReport: ChangeReport | null;
  status: PostStatus;
  readingTimeMinutes: number;
  thumbnailUrl: string;
  thumbnailData: Buffer;
}): Promise<PostRecord> {
  const ts = nowIso();
  const tagsJson = JSON.stringify(input.tags);
  const reportJson = input.changeReport ? JSON.stringify(input.changeReport) : null;

  if (pgPool) {
    const res = await pgPool.query(
      `INSERT INTO posts (
        site_id, site_name, site_url, title, slug, meta_description, summary, content_html,
        tags_json, category, change_hash, change_report_json, status, reading_time_minutes,
        thumbnail_url, thumbnail_data, published_at, updated_at, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *`,
      [
        input.siteId,
        input.siteName,
        input.siteUrl,
        input.title,
        input.slug,
        input.metaDescription,
        input.summary,
        input.contentHtml,
        tagsJson,
        input.category,
        input.changeHash,
        reportJson,
        input.status,
        input.readingTimeMinutes,
        input.thumbnailUrl,
        input.thumbnailData,
        ts,
        ts,
        ts,
      ]
    );
    return mapPostRow(res.rows[0]);
  }

  const info = sqliteDb!
    .prepare(
      `INSERT INTO posts (
        site_id, site_name, site_url, title, slug, meta_description, summary, content_html,
        tags_json, category, change_hash, change_report_json, status, reading_time_minutes,
        thumbnail_url, thumbnail_data, published_at, updated_at, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.siteId,
      input.siteName,
      input.siteUrl,
      input.title,
      input.slug,
      input.metaDescription,
      input.summary,
      input.contentHtml,
      tagsJson,
      input.category,
      input.changeHash,
      reportJson,
      input.status,
      input.readingTimeMinutes,
      input.thumbnailUrl,
      input.thumbnailData,
      ts,
      ts,
      ts
    );

  const row = sqliteDb!.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
  return mapPostRow(row);
}

export async function updatePost(
  id: number,
  patch: Partial<{
    title: string;
    slug: string;
    metaDescription: string;
    summary: string;
    contentHtml: string;
    tags: string[];
    category: string;
    status: PostStatus;
    readingTimeMinutes: number;
    thumbnailUrl: string;
    thumbnailData: Buffer;
  }>
): Promise<PostRecord | null> {
  const existing = await getPostById(id);
  if (!existing) return null;

  const updatedAt = nowIso();
  const publishedAt =
    existing.status === 'draft' && patch.status === 'published' ? updatedAt : existing.publishedAt;

  const nextSlug = patch.slug ?? existing.slug;
  const next = {
    title: patch.title ?? existing.title,
    slug: nextSlug,
    metaDescription: patch.metaDescription ?? existing.metaDescription,
    summary: patch.summary ?? existing.summary,
    contentHtml: patch.contentHtml ?? existing.contentHtml,
    tagsJson: JSON.stringify(patch.tags ?? existing.tags),
    category: patch.category ?? existing.category,
    status: patch.status ?? existing.status,
    readingTimeMinutes: patch.readingTimeMinutes ?? existing.readingTimeMinutes,
    thumbnailUrl:
      patch.thumbnailUrl ??
      (patch.slug && patch.slug !== existing.slug ? `/thumbnails/${nextSlug}.png` : existing.thumbnailUrl),
  };

  if (pgPool) {
    if (patch.thumbnailData) {
      const res = await pgPool.query(
        `UPDATE posts SET title=$1, slug=$2, meta_description=$3, summary=$4, content_html=$5,
         tags_json=$6, category=$7, status=$8, reading_time_minutes=$9, thumbnail_url=$10,
         thumbnail_data=$11, published_at=$12, updated_at=$13 WHERE id=$14 RETURNING *`,
        [
          next.title,
          next.slug,
          next.metaDescription,
          next.summary,
          next.contentHtml,
          next.tagsJson,
          next.category,
          next.status,
          next.readingTimeMinutes,
          next.thumbnailUrl,
          patch.thumbnailData,
          publishedAt,
          updatedAt,
          id,
        ]
      );
      return res.rows[0] ? mapPostRow(res.rows[0]) : null;
    }

    const res = await pgPool.query(
      `UPDATE posts SET title=$1, slug=$2, meta_description=$3, summary=$4, content_html=$5,
       tags_json=$6, category=$7, status=$8, reading_time_minutes=$9, thumbnail_url=$10,
       published_at=$11, updated_at=$12 WHERE id=$13 RETURNING *`,
      [
        next.title,
        next.slug,
        next.metaDescription,
        next.summary,
        next.contentHtml,
        next.tagsJson,
        next.category,
        next.status,
        next.readingTimeMinutes,
        next.thumbnailUrl,
        publishedAt,
        updatedAt,
        id,
      ]
    );
    return res.rows[0] ? mapPostRow(res.rows[0]) : null;
  }

  if (patch.thumbnailData) {
    sqliteDb!
      .prepare(
        `UPDATE posts SET title=?, slug=?, meta_description=?, summary=?, content_html=?,
         tags_json=?, category=?, status=?, reading_time_minutes=?, thumbnail_url=?,
         thumbnail_data=?, published_at=?, updated_at=? WHERE id=?`
      )
      .run(
        next.title,
        next.slug,
        next.metaDescription,
        next.summary,
        next.contentHtml,
        next.tagsJson,
        next.category,
        next.status,
        next.readingTimeMinutes,
        next.thumbnailUrl,
        patch.thumbnailData,
        publishedAt,
        updatedAt,
        id
      );
  } else {
    sqliteDb!
      .prepare(
        `UPDATE posts SET title=?, slug=?, meta_description=?, summary=?, content_html=?,
         tags_json=?, category=?, status=?, reading_time_minutes=?, thumbnail_url=?,
         published_at=?, updated_at=? WHERE id=?`
      )
      .run(
        next.title,
        next.slug,
        next.metaDescription,
        next.summary,
        next.contentHtml,
        next.tagsJson,
        next.category,
        next.status,
        next.readingTimeMinutes,
        next.thumbnailUrl,
        publishedAt,
        updatedAt,
        id
      );
  }

  return getPostById(id);
}

export async function getThumbnailDataBySlug(
  slug: string
): Promise<{ id: number; data: Buffer | null; title: string; siteName: string } | null> {
  if (pgPool) {
    const res = await pgPool.query(
      'SELECT id, thumbnail_data, title, site_name FROM posts WHERE slug = $1 LIMIT 1',
      [slug]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      data: row.thumbnail_data ? Buffer.from(row.thumbnail_data) : null,
      title: String(row.title),
      siteName: String(row.site_name),
    };
  }
  const row = sqliteDb!
    .prepare('SELECT id, thumbnail_data, title, site_name FROM posts WHERE slug = ? LIMIT 1')
    .get(slug) as { id: number; thumbnail_data: Buffer | null; title: string; site_name: string } | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    data: row.thumbnail_data ? Buffer.from(row.thumbnail_data) : null,
    title: String(row.title),
    siteName: String(row.site_name),
  };
}

export async function listPostsMissingThumbnails(): Promise<
  Array<{ id: number; slug: string; title: string; siteName: string; siteId: number | null }>
> {
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT id, slug, title, site_name, site_id
       FROM posts
       WHERE thumbnail_data IS NULL
          OR octet_length(thumbnail_data) < 100
          OR thumbnail_url IS NULL
          OR thumbnail_url NOT LIKE '/thumbnails/%'`
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      slug: String(r.slug),
      title: String(r.title),
      siteName: String(r.site_name),
      siteId: r.site_id !== null && r.site_id !== undefined ? Number(r.site_id) : null,
    }));
  }
  const rows = sqliteDb!
    .prepare(
      `SELECT id, slug, title, site_name, site_id
       FROM posts
       WHERE thumbnail_data IS NULL
          OR length(thumbnail_data) < 100
          OR thumbnail_url IS NULL
          OR thumbnail_url NOT LIKE '/thumbnails/%'`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: Number(r.id),
    slug: String(r.slug),
    title: String(r.title),
    siteName: String(r.site_name),
    siteId: r.site_id !== null && r.site_id !== undefined ? Number(r.site_id) : null,
  }));
}

export async function setPostThumbnail(id: number, thumbnailUrl: string, thumbnailData: Buffer): Promise<void> {
  if (pgPool) {
    await pgPool.query('UPDATE posts SET thumbnail_url = $1, thumbnail_data = $2 WHERE id = $3', [
      thumbnailUrl,
      thumbnailData,
      id,
    ]);
    return;
  }
  sqliteDb!
    .prepare('UPDATE posts SET thumbnail_url = ?, thumbnail_data = ? WHERE id = ?')
    .run(thumbnailUrl, thumbnailData, id);
}

export async function deletePost(id: number): Promise<boolean> {
  if (pgPool) {
    const res = await pgPool.query('DELETE FROM posts WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
  const res = sqliteDb!.prepare('DELETE FROM posts WHERE id = ?').run(id);
  return res.changes > 0;
}

// ---------------- Logs ----------------

export async function addLog(entry: {
  level: LogLevel;
  siteId?: number | null;
  siteName?: string | null;
  action: string;
  message: string;
  details?: string | null;
}): Promise<void> {
  const createdAt = nowIso();
  if (pgPool) {
    await pgPool.query(
      'INSERT INTO logs (level, site_id, site_name, action, message, details, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [entry.level, entry.siteId ?? null, entry.siteName ?? null, entry.action, entry.message, entry.details ?? null, createdAt]
    );
    return;
  }
  sqliteDb!
    .prepare('INSERT INTO logs (level, site_id, site_name, action, message, details, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(entry.level, entry.siteId ?? null, entry.siteName ?? null, entry.action, entry.message, entry.details ?? null, createdAt);
}

export async function listLogs(limit = 100, level?: string): Promise<LogRecord[]> {
  const safeLimit = Math.min(300, Math.max(1, limit));
  if (pgPool) {
    if (level && level !== 'all') {
      const res = await pgPool.query('SELECT * FROM logs WHERE level = $1 ORDER BY id DESC LIMIT $2', [level, safeLimit]);
      return res.rows.map(mapLogRow);
    }
    const res = await pgPool.query('SELECT * FROM logs ORDER BY id DESC LIMIT $1', [safeLimit]);
    return res.rows.map(mapLogRow);
  }
  if (level && level !== 'all') {
    const rows = sqliteDb!
      .prepare('SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?')
      .all(level, safeLimit) as Record<string, unknown>[];
    return rows.map(mapLogRow);
  }
  const rows = sqliteDb!.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(safeLimit) as Record<string, unknown>[];
  return rows.map(mapLogRow);
}

export async function pruneOldLogs(keepCount = 500): Promise<number> {
  const safeKeep = Math.max(100, keepCount);
  if (pgPool) {
    const res = await pgPool.query(
      `DELETE FROM logs
       WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT $1)`,
      [safeKeep]
    );
    return res.rowCount ?? 0;
  }
  const res = sqliteDb!
    .prepare(
      `DELETE FROM logs
       WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)`
    )
    .run(safeKeep);
  return res.changes;
}

export async function getAdminStats(): Promise<{
  totalSites: number;
  activeSites: number;
  errorSites: number;
  publishedPosts: number;
  draftPosts: number;
  lastCheckAt: string | null;
  lastRunStatus: string | null;
  draftMode: boolean;
  dbEngine: DbEngine;
}> {
  const lastCheckAt = await getSetting('last_run_at');
  const lastRunStatus = await getSetting('last_run_status');
  const draftMode = (await getSetting('draft_mode')) === 'true';

  if (pgPool) {
    const sitesRes = await pgPool.query(`
      SELECT
        COUNT(*) AS total_sites,
        COUNT(*) FILTER (WHERE active = TRUE) AS active_sites,
        COUNT(*) FILTER (WHERE last_status = 'error') AS error_sites
      FROM sites
    `);
    const postsRes = await pgPool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'published') AS published_posts,
        COUNT(*) FILTER (WHERE status = 'draft') AS draft_posts
      FROM posts
    `);
    return {
      totalSites: Number(sitesRes.rows[0]?.total_sites ?? 0),
      activeSites: Number(sitesRes.rows[0]?.active_sites ?? 0),
      errorSites: Number(sitesRes.rows[0]?.error_sites ?? 0),
      publishedPosts: Number(postsRes.rows[0]?.published_posts ?? 0),
      draftPosts: Number(postsRes.rows[0]?.draft_posts ?? 0),
      lastCheckAt,
      lastRunStatus,
      draftMode,
      dbEngine: activeEngine,
    };
  }

  const siteStats = sqliteDb!
    .prepare(
      `SELECT
        COUNT(*) AS total_sites,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active_sites,
        SUM(CASE WHEN last_status = 'error' THEN 1 ELSE 0 END) AS error_sites
       FROM sites`
    )
    .get() as { total_sites: number; active_sites: number; error_sites: number };

  const postStats = sqliteDb!
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published_posts,
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_posts
       FROM posts`
    )
    .get() as { published_posts: number; draft_posts: number };

  return {
    totalSites: Number(siteStats?.total_sites ?? 0),
    activeSites: Number(siteStats?.active_sites ?? 0),
    errorSites: Number(siteStats?.error_sites ?? 0),
    publishedPosts: Number(postStats?.published_posts ?? 0),
    draftPosts: Number(postStats?.draft_posts ?? 0),
    lastCheckAt,
    lastRunStatus,
    draftMode,
    dbEngine: activeEngine,
  };
}

// ---------------- Affiliate Advertisements ----------------

function mapAdRow(row: Record<string, unknown>): AdRecord {
  return {
    id: Number(row.id),
    slot: (row.slot === 'sidebar' ? 'sidebar' : 'inline') as AdSlot,
    advertiserName: String(row.advertiser_name),
    displayDomain: String(row.display_domain),
    categoryLabel: String(row.category_label),
    headline: String(row.headline),
    description: String(row.description),
    ctaLabel: String(row.cta_label),
    targetUrl: String(row.target_url),
    active: Boolean(row.active),
    sortOrder: Number(row.sort_order ?? 0),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
    lastStatus: (row.last_status as AdHealthStatus) || 'pending',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function validateAffiliateTargetUrl(rawUrl: string): string {
  const parsed = validateExternalUrl(rawUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Affiliate link must use http:// or https://');
  }
  return rawUrl.trim();
}

async function seedDefaultAds(): Promise<void> {
  const defaults: Array<{
    slot: AdSlot;
    advertiserName: string;
    displayDomain: string;
    categoryLabel: string;
    headline: string;
    description: string;
    ctaLabel: string;
    targetUrl: string;
    sortOrder: number;
  }> = [
    {
      slot: 'inline',
      advertiserName: 'Alibaba.com',
      displayDomain: 'alibaba.com',
      categoryLabel: 'Global B2B Sourcing',
      headline: 'Source Direct From Verified Global Manufacturers',
      description:
        'Connect with OEM suppliers, wholesalers, and trade-assured bulk procurement partners across global manufacturing hubs.',
      ctaLabel: 'Browse Suppliers',
      targetUrl: 'https://rzekl.com/g/pm1aev55clcb5002cfdd219aa26f6f/',
      sortOrder: 1,
    },
    {
      slot: 'sidebar',
      advertiserName: 'AliExpress',
      displayDomain: 'aliexpress.com',
      categoryLabel: 'Tech, Tools & Gear',
      headline: 'Direct Deals on Electronics, Tools & Everyday Tech',
      description:
        'Shop consumer electronics, maker hardware, phone accessories, tools, and automotive gear shipped worldwide.',
      ctaLabel: 'Explore Deals',
      targetUrl: 'https://rzekl.com/g/1e8d114494cb5002cfdd16525dc3e8/',
      sortOrder: 2,
    },
  ];

  const ts = nowIso();
  for (const ad of defaults) {
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO ads (
          slot, advertiser_name, display_domain, category_label, headline, description,
          cta_label, target_url, active, sort_order, impressions, clicks, last_status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,0,0,'pending',$10,$11)
        ON CONFLICT (target_url) DO NOTHING`,
        [
          ad.slot,
          ad.advertiserName,
          ad.displayDomain,
          ad.categoryLabel,
          ad.headline,
          ad.description,
          ad.ctaLabel,
          ad.targetUrl,
          ad.sortOrder,
          ts,
          ts,
        ]
      );
    } else {
      sqliteDb!
        .prepare(
          `INSERT OR IGNORE INTO ads (
            slot, advertiser_name, display_domain, category_label, headline, description,
            cta_label, target_url, active, sort_order, impressions, clicks, last_status, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,1,?,0,0,'pending',?,?)`
        )
        .run(
          ad.slot,
          ad.advertiserName,
          ad.displayDomain,
          ad.categoryLabel,
          ad.headline,
          ad.description,
          ad.ctaLabel,
          ad.targetUrl,
          ad.sortOrder,
          ts,
          ts
        );
    }
  }
}

export async function listActiveAds(): Promise<AdRecord[]> {
  if (pgPool) {
    const res = await pgPool.query(
      'SELECT * FROM ads WHERE active = TRUE ORDER BY sort_order ASC, id ASC'
    );
    return res.rows.map(mapAdRow);
  }
  const rows = sqliteDb!
    .prepare('SELECT * FROM ads WHERE active = 1 ORDER BY sort_order ASC, id ASC')
    .all() as Record<string, unknown>[];
  return rows.map(mapAdRow);
}

export async function listAllAds(): Promise<AdRecord[]> {
  if (pgPool) {
    const res = await pgPool.query('SELECT * FROM ads ORDER BY sort_order ASC, id ASC');
    return res.rows.map(mapAdRow);
  }
  const rows = sqliteDb!
    .prepare('SELECT * FROM ads ORDER BY sort_order ASC, id ASC')
    .all() as Record<string, unknown>[];
  return rows.map(mapAdRow);
}

export async function getAdById(id: number): Promise<AdRecord | null> {
  if (pgPool) {
    const res = await pgPool.query('SELECT * FROM ads WHERE id = $1', [id]);
    return res.rows[0] ? mapAdRow(res.rows[0]) : null;
  }
  const row = sqliteDb!.prepare('SELECT * FROM ads WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapAdRow(row) : null;
}

export async function createAd(input: {
  slot: AdSlot;
  advertiserName: string;
  displayDomain: string;
  categoryLabel: string;
  headline: string;
  description: string;
  ctaLabel: string;
  targetUrl: string;
  sortOrder?: number;
  active?: boolean;
}): Promise<AdRecord> {
  const safeUrl = validateAffiliateTargetUrl(input.targetUrl);
  const ts = nowIso();
  const slot: AdSlot = input.slot === 'sidebar' ? 'sidebar' : 'inline';
  const active = input.active !== false;
  const sortOrder = Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0;

  if (pgPool) {
    const res = await pgPool.query(
      `INSERT INTO ads (
        slot, advertiser_name, display_domain, category_label, headline, description,
        cta_label, target_url, active, sort_order, impressions, clicks, last_status, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,0,'pending',$11,$12)
      RETURNING *`,
      [
        slot,
        input.advertiserName.trim(),
        input.displayDomain.trim(),
        input.categoryLabel.trim(),
        input.headline.trim(),
        input.description.trim(),
        input.ctaLabel.trim(),
        safeUrl,
        active,
        sortOrder,
        ts,
        ts,
      ]
    );
    return mapAdRow(res.rows[0]);
  }

  const info = sqliteDb!
    .prepare(
      `INSERT INTO ads (
        slot, advertiser_name, display_domain, category_label, headline, description,
        cta_label, target_url, active, sort_order, impressions, clicks, last_status, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,'pending',?,?)`
    )
    .run(
      slot,
      input.advertiserName.trim(),
      input.displayDomain.trim(),
      input.categoryLabel.trim(),
      input.headline.trim(),
      input.description.trim(),
      input.ctaLabel.trim(),
      safeUrl,
      active ? 1 : 0,
      sortOrder,
      ts,
      ts
    );

  const created = sqliteDb!.prepare('SELECT * FROM ads WHERE id = ?').get(info.lastInsertRowid) as Record<
    string,
    unknown
  >;
  return mapAdRow(created);
}

export async function updateAd(
  id: number,
  patch: Partial<{
    slot: AdSlot;
    advertiserName: string;
    displayDomain: string;
    categoryLabel: string;
    headline: string;
    description: string;
    ctaLabel: string;
    targetUrl: string;
    active: boolean;
    sortOrder: number;
  }>
): Promise<AdRecord | null> {
  const existing = await getAdById(id);
  if (!existing) return null;

  const next = {
    slot: patch.slot ? (patch.slot === 'sidebar' ? 'sidebar' : 'inline') : existing.slot,
    advertiserName: patch.advertiserName?.trim() || existing.advertiserName,
    displayDomain: patch.displayDomain?.trim() || existing.displayDomain,
    categoryLabel: patch.categoryLabel?.trim() || existing.categoryLabel,
    headline: patch.headline?.trim() || existing.headline,
    description: patch.description?.trim() || existing.description,
    ctaLabel: patch.ctaLabel?.trim() || existing.ctaLabel,
    targetUrl: patch.targetUrl ? validateAffiliateTargetUrl(patch.targetUrl) : existing.targetUrl,
    active: patch.active !== undefined ? patch.active : existing.active,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : existing.sortOrder,
    updatedAt: nowIso(),
  };

  if (pgPool) {
    const res = await pgPool.query(
      `UPDATE ads SET
        slot = $1, advertiser_name = $2, display_domain = $3, category_label = $4,
        headline = $5, description = $6, cta_label = $7, target_url = $8,
        active = $9, sort_order = $10, updated_at = $11
       WHERE id = $12 RETURNING *`,
      [
        next.slot,
        next.advertiserName,
        next.displayDomain,
        next.categoryLabel,
        next.headline,
        next.description,
        next.ctaLabel,
        next.targetUrl,
        next.active,
        next.sortOrder,
        next.updatedAt,
        id,
      ]
    );
    return res.rows[0] ? mapAdRow(res.rows[0]) : null;
  }

  sqliteDb!
    .prepare(
      `UPDATE ads SET
        slot = ?, advertiser_name = ?, display_domain = ?, category_label = ?,
        headline = ?, description = ?, cta_label = ?, target_url = ?,
        active = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.slot,
      next.advertiserName,
      next.displayDomain,
      next.categoryLabel,
      next.headline,
      next.description,
      next.ctaLabel,
      next.targetUrl,
      next.active ? 1 : 0,
      next.sortOrder,
      next.updatedAt,
      id
    );
  return getAdById(id);
}

export async function deleteAd(id: number): Promise<boolean> {
  if (pgPool) {
    const res = await pgPool.query('DELETE FROM ads WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
  const res = sqliteDb!.prepare('DELETE FROM ads WHERE id = ?').run(id);
  return res.changes > 0;
}

export async function recordAdImpression(id: number): Promise<boolean> {
  if (pgPool) {
    const res = await pgPool.query(
      'UPDATE ads SET impressions = impressions + 1 WHERE id = $1 AND active = TRUE',
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  }
  const res = sqliteDb!
    .prepare('UPDATE ads SET impressions = impressions + 1 WHERE id = ? AND active = 1')
    .run(id);
  return res.changes > 0;
}

export async function recordAdClick(id: number): Promise<boolean> {
  if (pgPool) {
    const res = await pgPool.query(
      'UPDATE ads SET clicks = clicks + 1 WHERE id = $1 AND active = TRUE',
      [id]
    );
    return (res.rowCount ?? 0) > 0;
  }
  const res = sqliteDb!
    .prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ? AND active = 1')
    .run(id);
  return res.changes > 0;
}

export async function updateAdHealth(id: number, status: AdHealthStatus): Promise<void> {
  const ts = nowIso();
  if (pgPool) {
    await pgPool.query('UPDATE ads SET last_checked_at = $1, last_status = $2 WHERE id = $3', [
      ts,
      status,
      id,
    ]);
    return;
  }
  sqliteDb!
    .prepare('UPDATE ads SET last_checked_at = ?, last_status = ? WHERE id = ?')
    .run(ts, status, id);
}
