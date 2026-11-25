export type PostStatus = 'published' | 'draft';
export type SiteStatus = 'ok' | 'error' | 'pending';
export type LogLevel = 'info' | 'warn' | 'error' | 'success';

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
  status?: PostStatus;
  readingTimeMinutes: number;
  thumbnailUrl: string;
  publishedAt: string;
  updatedAt: string;
}

export interface FullPost extends PublicPostSummary {
  contentHtml: string;
  changeHash?: string;
  createdAt?: string;
}

export interface CategoryCount {
  category: string;
  count: number;
}

export interface PublicSite {
  id: number;
  name: string;
  url: string;
  source: 'hub' | 'manual';
  lastCheckedAt: string | null;
  lastStatus: SiteStatus;
  postCount: number;
}

export interface AdminSite extends PublicSite {
  rssUrl: string | null;
  sitemapUrl: string | null;
  githubRepo: string | null;
  active: boolean;
  lastError: string | null;
  createdAt: string;
}

export interface ActivityLog {
  id: number;
  level: LogLevel;
  siteId: number | null;
  siteName: string | null;
  action: string;
  message: string;
  details: string | null;
  createdAt: string;
}

export interface AdminStats {
  totalSites: number;
  activeSites: number;
  errorSites: number;
  publishedPosts: number;
  draftPosts: number;
  lastCheckAt: string | null;
  lastRunStatus: string | null;
  draftMode: boolean;
  dbEngine: 'postgres' | 'sqlite';
}

export interface AiControlStatus {
  autopilotEnabled: boolean;
  maintenanceRunning: boolean;
  systemHealth: 'healthy' | 'degraded' | 'recovering';
  recommendedIntervalMinutes: number;
  lastMaintenanceAt: string | null;
  headlineDirective: string;
  actionsExecuted: string[];
  usedAiReasoning: boolean;
  reasoningModel: string;
  fallbackReason?: string | null;
}

