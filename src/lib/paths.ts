import type { CategoryCount, FullPost, PublicAd, PublicPostSummary } from '../types';

interface StaticPostsPayload {
  posts: FullPost[];
  categories?: CategoryCount[];
}

let staticModeDetected = false;
let cachedStaticPosts: StaticPostsPayload | null = null;
let cachedStaticAds: PublicAd[] | null = null;

export function getBasePath(): string {
  const raw = (import.meta.env.BASE_URL || '/').trim();
  if (!raw || raw === '/') return '/';
  if (raw === './' || raw === '.') return './';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

export function isRelativeBase(): boolean {
  return getBasePath() === './';
}

export function withBase(appPath: string): string {
  if (!appPath) return getBasePath();
  if (/^(?:https?:|mailto:|tel:|data:)/i.test(appPath)) {
    return appPath;
  }
  const base = getBasePath();
  const clean = appPath.startsWith('/') ? appPath.slice(1) : appPath;
  if (base === './') {
    return clean ? `./${clean}` : './';
  }
  return `${base}${clean}`;
}

export function toRouteHref(appPath: string): string {
  if (!isRelativeBase()) {
    return withBase(appPath);
  }
  if (appPath.startsWith('/#')) {
    return appPath.slice(1); // e.g. "#labels"
  }
  if (appPath.startsWith('#')) {
    return appPath;
  }
  const clean = appPath.startsWith('/') ? appPath : `/${appPath}`;
  return `#${clean}`;
}

export function stripBase(pathname: string): string {
  let clean = pathname || '/';
  const base = getBasePath();
  if (base !== '/' && base !== './') {
    const trimmedBase = base.slice(0, -1);
    if (clean === trimmedBase || clean === base) {
      clean = '/';
    } else if (clean.startsWith(base)) {
      clean = `/${clean.slice(base.length)}`;
    }
  }
  if (clean.endsWith('/index.html')) {
    clean = clean.slice(0, -'/index.html'.length) || '/';
  }
  return clean.startsWith('/') ? clean : `/${clean}`;
}

export function getRouteFromWindow(): { pathname: string; searchQuery: string } {
  if (typeof window === 'undefined') return { pathname: '/', searchQuery: '' };

  if (isRelativeBase() && window.location.hash.startsWith('#/')) {
    const rawRoute = window.location.hash.slice(1);
    const qIdx = rawRoute.indexOf('?');
    const pathPart = qIdx >= 0 ? rawRoute.slice(0, qIdx) : rawRoute;
    const queryPart = qIdx >= 0 ? rawRoute.slice(qIdx + 1) : '';
    const params = new URLSearchParams(queryPart);
    return {
      pathname: pathPart || '/',
      searchQuery: params.get('q') || '',
    };
  }

  const params = new URLSearchParams(window.location.search);
  return {
    pathname: isRelativeBase() ? '/' : stripBase(window.location.pathname || '/'),
    searchQuery: params.get('q') || '',
  };
}

export function updateSearchInUrl(baseRoute: string, query: string): void {
  if (typeof window === 'undefined') return;
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
  const target = `${baseRoute}${suffix}`;
  if (isRelativeBase()) {
    window.history.replaceState({}, '', `#${target}`);
    return;
  }
  window.history.replaceState({}, '', `${withBase(target)}${window.location.hash}`);
}

export function isStaticMode(): boolean {
  return staticModeDetected;
}

async function fetchJsonStrict<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || !contentType.toLowerCase().includes('application/json')) {
    throw new Error(`Unavailable JSON response (${res.status})`);
  }
  return (await res.json()) as T;
}

async function loadStaticPostsPayload(): Promise<StaticPostsPayload> {
  if (cachedStaticPosts) return cachedStaticPosts;
  const payload = await fetchJsonStrict<StaticPostsPayload>(withBase('/static-data/posts.json'));
  cachedStaticPosts = {
    posts: Array.isArray(payload.posts) ? payload.posts : [],
    categories: Array.isArray(payload.categories) ? payload.categories : [],
  };
  return cachedStaticPosts;
}

function buildCategoriesFromPosts(posts: FullPost[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const post of posts) {
    counts.set(post.category, (counts.get(post.category) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export async function fetchPostsWithFallback(options: {
  category?: string;
  search?: string;
  page?: number;
  limit?: number;
}): Promise<{
  posts: PublicPostSummary[];
  total: number;
  page: number;
  totalPages: number;
  categories: CategoryCount[];
}> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(50, Math.max(1, options.limit ?? 9));
  const category = options.category?.trim() || '';
  const search = options.search?.trim() || '';

  if (!staticModeDetected) {
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (category && category.toLowerCase() !== 'all') params.set('category', category);
      if (search) params.set('search', search);

      return await fetchJsonStrict(withBase(`/api/posts?${params.toString()}`));
    } catch {
      // Fall back cleanly to pre-exported static snapshot (e.g. GitHub Pages)
    }
  }

  const staticPayload = await loadStaticPostsPayload();
  staticModeDetected = true;

  const allPosts = staticPayload.posts;
  const categories =
    staticPayload.categories && staticPayload.categories.length > 0
      ? staticPayload.categories
      : buildCategoriesFromPosts(allPosts);

  const searchLower = search.toLowerCase();
  const filtered = allPosts.filter((p) => {
    if (category && category.toLowerCase() !== 'all' && p.category !== category) {
      return false;
    }
    if (searchLower) {
      const haystack = `${p.title} ${p.summary} ${p.siteName} ${p.tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(searchLower)) return false;
    }
    return true;
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * limit;

  return {
    posts: filtered.slice(offset, offset + limit),
    total,
    page: safePage,
    totalPages,
    categories,
  };
}

export async function fetchPostBySlugWithFallback(
  slug: string
): Promise<{ post: FullPost; related: PublicPostSummary[] }> {
  if (!staticModeDetected) {
    try {
      return await fetchJsonStrict(withBase(`/api/posts/${encodeURIComponent(slug)}`));
    } catch {
      // Fall back cleanly to static snapshot
    }
  }

  const staticPayload = await loadStaticPostsPayload();
  staticModeDetected = true;

  const post = staticPayload.posts.find((p) => p.slug === slug);
  if (!post) {
    throw new Error('Dispatch not found');
  }

  const related = staticPayload.posts
    .filter((p) => p.id !== post.id)
    .sort((a, b) => {
      const aMatch = a.category === post.category ? 0 : 1;
      const bMatch = b.category === post.category ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
    })
    .slice(0, 3);

  return { post, related };
}

export async function fetchAdsWithFallback(): Promise<PublicAd[]> {
  if (!staticModeDetected) {
    try {
      const data = await fetchJsonStrict<{ ads?: PublicAd[] }>(withBase('/api/ads'));
      return Array.isArray(data.ads) ? data.ads : [];
    } catch {
      // Fall back cleanly to static ads snapshot
    }
  }

  if (cachedStaticAds) return cachedStaticAds;
  try {
    const data = await fetchJsonStrict<{ ads?: PublicAd[] }>(withBase('/static-data/ads.json'));
    staticModeDetected = true;
    cachedStaticAds = Array.isArray(data.ads) ? data.ads : [];
    return cachedStaticAds;
  } catch {
    return [];
  }
}
