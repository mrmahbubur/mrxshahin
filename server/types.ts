export type DbEngine = 'postgres' | 'sqlite';

export type SiteSource = 'hub' | 'manual';
export type SiteStatus = 'ok' | 'error' | 'pending';
export type PostStatus = 'published' | 'draft';
export type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface SiteRecord {
  id: number;
  name: string;
  url: string;
  rssUrl: string | null;
  sitemapUrl: string | null;
  githubRepo: string | null;
  source: SiteSource;
  active: boolean;
  lastCheckedAt: string | null;
  lastStatus: SiteStatus;
  lastError: string | null;
  themeColor: string | null;
  createdAt: string;
  postCount?: number;
}

export interface HeadingItem {
  level: string;
  text: string;
}

export interface LinkItem {
  href: string;
  text: string;
}

export interface ImageItem {
  src: string;
  alt: string;
}

export interface RssEntry {
  title: string;
  link: string;
  pubDate: string;
  summary: string;
}

export interface GithubCommitEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface GithubReleaseEntry {
  tagName: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
}

export interface GithubActivity {
  commits: GithubCommitEntry[];
  releases: GithubReleaseEntry[];
}

export interface SnapshotRecord {
  id: number;
  siteId: number;
  pageUrl: string;
  contentHash: string;
  title: string;
  metaDescription: string;
  headings: HeadingItem[];
  mainText: string;
  links: LinkItem[];
  images: ImageItem[];
  navItems: string[];
  sitemapUrls: string[];
  rssItems: RssEntry[];
  githubData: GithubActivity | null;
  createdAt: string;
}

export interface ChangeReport {
  siteId: number;
  siteName: string;
  siteUrl: string;
  isInitial: boolean;
  meaningful: boolean;
  reason: string;
  changeHash: string;
  newPages: string[];
  removedPages: string[];
  newHeadings: string[];
  removedHeadings: string[];
  newNavItems: string[];
  newLinks: LinkItem[];
  newRssItems: RssEntry[];
  newGithubCommits: GithubCommitEntry[];
  newGithubReleases: GithubReleaseEntry[];
  beforeSummary: string;
  afterSummary: string;
  textDiffSnippet: string;
  currentTitle: string;
  currentMetaDescription: string;
  currentHeadings: HeadingItem[];
  currentMainTextExcerpt: string;
  heroImageUrl?: string | null;
}

export interface PostRecord {
  id: number;
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
  publishedAt: string;
  updatedAt: string;
  createdAt: string;
}

export interface PublicPostSummary {
  id: number;
  siteId: number | null;
  siteName: string;
  siteUrl: string;
  title: string;
  slug: string;
  metaDescription: string;
  summary: string;
  tags: string[];
  category: string;
  status: PostStatus;
  readingTimeMinutes: number;
  thumbnailUrl: string;
  publishedAt: string;
  updatedAt: string;
}

export interface LogRecord {
  id: number;
  level: LogLevel;
  siteId: number | null;
  siteName: string | null;
  action: string;
  message: string;
  details: string | null;
  createdAt: string;
}
