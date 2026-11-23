import { ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { CategoryCount, PublicPostSummary, PublicSite } from '../types';
import { ThumbnailImage } from './ThumbnailImage';

interface HomePageProps {
  onNavigate: (path: string) => void;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function HomePage({ onNavigate }: HomePageProps) {
  const [posts, setPosts] = useState<PublicPostSummary[]>([]);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [sites, setSites] = useState<PublicSite[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalPosts, setTotalPosts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: '10',
      });
      if (selectedCategory !== 'all') params.set('category', selectedCategory);
      if (activeSearch) params.set('search', activeSearch);

      const [postsRes, sitesRes] = await Promise.all([
        fetch(`/api/posts?${params.toString()}`),
        fetch('/api/sites'),
      ]);

      if (!postsRes.ok) throw new Error('Failed to load dispatches');
      const postsJson = (await postsRes.json()) as {
        posts: PublicPostSummary[];
        total: number;
        page: number;
        totalPages: number;
        categories: CategoryCount[];
      };

      setPosts(postsJson.posts);
      setTotalPosts(postsJson.total);
      setTotalPages(postsJson.totalPages);
      setCategories(postsJson.categories || []);

      if (sitesRes.ok) {
        const sitesJson = (await sitesRes.json()) as { sites: PublicSite[] };
        setSites(sitesJson.sites || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load blog dispatches');
    } finally {
      setLoading(false);
    }
  }, [page, selectedCategory, activeSearch]);

  useEffect(() => {
    document.title = 'M R S Auto Blog – Automated Website Updates & Innovation Dispatches';
    loadData();
  }, [loadData]);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput.trim() !== activeSearch) {
        setPage(1);
        setActiveSearch(searchInput.trim());
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [searchInput, activeSearch]);

  const showFeatured = page === 1 && selectedCategory === 'all' && !activeSearch && posts.length > 0;
  const featuredPost = showFeatured ? posts[0] : null;
  const gridPosts = showFeatured ? posts.slice(1) : posts;

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-14 space-y-14">
      {/* Editorial Header & Featured Latest Post */}
      {loading && posts.length === 0 ? (
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          <div className="lg:col-span-7 aspect-video rounded-xl bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
          <div className="lg:col-span-5 flex flex-col justify-center space-y-4">
            <div className="h-4 w-44 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
            <div className="h-10 w-full rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
            <div className="h-10 w-3/4 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
            <div className="h-20 w-full rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
          </div>
        </section>
      ) : error ? (
        <section className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-8 text-center space-y-4">
          <p className="text-sm text-red-600 dark:text-red-400 font-medium">{error}</p>
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2 text-xs font-medium text-white dark:text-zinc-900"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>Retry</span>
          </button>
        </section>
      ) : featuredPost ? (
        <section aria-label="Featured Dispatch" className="border-b border-zinc-200 dark:border-zinc-800 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-stretch">
            <a
              href={`/post/${featuredPost.slug}`}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(`/post/${featuredPost.slug}`);
              }}
              className="group lg:col-span-7 block overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822]"
            >
              <ThumbnailImage
                src={featuredPost.thumbnailUrl}
                alt={featuredPost.title}
                title={featuredPost.title}
                siteName={featuredPost.siteName}
                className="lg:h-full"
                priority
              />
            </a>

            <div className="lg:col-span-5 flex flex-col justify-between py-1">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  <span className="text-blue-700 dark:text-blue-400 font-semibold">Latest Dispatch</span>
                  <span aria-hidden="true">·</span>
                  <span>{featuredPost.siteName}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={featuredPost.publishedAt} className="tabular-nums">
                    {formatDate(featuredPost.publishedAt)}
                  </time>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{featuredPost.readingTimeMinutes} min read</span>
                </div>

                <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 leading-[1.15] [text-wrap:balance]">
                  <a
                    href={`/post/${featuredPost.slug}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigate(`/post/${featuredPost.slug}`);
                    }}
                    className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
                  >
                    {featuredPost.title}
                  </a>
                </h1>

                <p className="text-base leading-relaxed text-zinc-600 dark:text-zinc-300">
                  {featuredPost.summary}
                </p>
              </div>

              <div className="pt-6 flex flex-wrap items-center gap-3">
                <a
                  href={`/post/${featuredPost.slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(`/post/${featuredPost.slug}`);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-5 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Read Dispatch</span>
                  <ArrowRight className="h-4 w-4" />
                </a>

                <a
                  href={featuredPost.siteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] px-4 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/70 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Visit Site</span>
                  <ArrowUpRight className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>
        </section>
      ) : posts.length === 0 && !activeSearch && selectedCategory === 'all' ? (
        <section className="border-b border-zinc-200 dark:border-zinc-800 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-stretch">
            <div className="lg:col-span-7 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-900">
              <img
                src="/src/assets/images/editorial_hero_abstract_1795437088233.jpg"
                alt="M R S Auto Blog architectural editorial banner"
                referrerPolicy="no-referrer"
                className="aspect-video w-full lg:h-full object-cover"
              />
            </div>
            <div className="lg:col-span-5 flex flex-col justify-center space-y-5">
              <p className="text-xs font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                Automated Editorial Publication
              </p>
              <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 leading-[1.15] [text-wrap:balance]">
                Tracking every release, redesign, and technical milestone automatically.
              </h1>
              <p className="text-base leading-relaxed text-zinc-600 dark:text-zinc-300">
                M R S Auto Blog monitors linked web properties continuously and publishes verified dispatches when meaningful updates appear. Run an initial check from the Admin Console or wait for the scheduled monitor.
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => onNavigate('/admin')}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-5 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Open Admin Console</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={loadData}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] px-4 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/70 transition-colors whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="h-4 w-4" />
                  <span>Refresh</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* Filter & Search Toolbar + Dispatches Archive */}
      <section aria-label="Dispatches Archive" className="space-y-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => {
                setSelectedCategory('all');
                setPage(1);
              }}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px] ${
                selectedCategory === 'all'
                  ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                  : 'border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              All Sites
            </button>
            {categories.map((cat) => (
              <button
                key={cat.category}
                type="button"
                onClick={() => {
                  setSelectedCategory(cat.category);
                  setPage(1);
                }}
                className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px] ${
                  selectedCategory === cat.category
                    ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                    : 'border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {cat.category} <span className="opacity-65 tabular-nums">({cat.count})</span>
              </button>
            ))}
          </div>

          <div className="relative w-full md:w-72 shrink-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search dispatches..."
              aria-label="Search dispatches"
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] pl-9 pr-9 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-blue-600 dark:focus:border-blue-400 focus:outline-none min-h-[40px]"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  setActiveSearch('');
                  setPage(1);
                }}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Grid of Post Cards */}
        {gridPosts.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-7">
            {gridPosts.map((post) => (
              <article
                key={post.id}
                className="group flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] overflow-hidden transition-colors hover:border-zinc-300 dark:hover:border-zinc-700"
              >
                <a
                  href={`/post/${post.slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(`/post/${post.slug}`);
                  }}
                  className="block border-b border-zinc-100 dark:border-zinc-800/80"
                >
                  <ThumbnailImage
                    src={post.thumbnailUrl}
                    alt={post.title}
                    title={post.title}
                    siteName={post.siteName}
                  />
                </a>

                <div className="flex flex-1 flex-col justify-between p-5 space-y-4">
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="font-medium text-blue-700 dark:text-blue-400">{post.siteName}</span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={post.publishedAt} className="tabular-nums">
                        {formatDate(post.publishedAt)}
                      </time>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{post.readingTimeMinutes} min</span>
                    </div>

                    <h2 className="font-display text-xl font-semibold leading-snug text-zinc-900 dark:text-zinc-50 [text-wrap:balance]">
                      <a
                        href={`/post/${post.slug}`}
                        onClick={(e) => {
                          e.preventDefault();
                          onNavigate(`/post/${post.slug}`);
                        }}
                        className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
                      >
                        {post.title}
                      </a>
                    </h2>

                    <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300 line-clamp-3">
                      {post.summary}
                    </p>
                  </div>

                  <div className="pt-2 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800/80 text-xs">
                    <a
                      href={`/post/${post.slug}`}
                      onClick={(e) => {
                        e.preventDefault();
                        onNavigate(`/post/${post.slug}`);
                      }}
                      className="font-medium text-zinc-800 dark:text-zinc-200 hover:text-blue-700 dark:hover:text-blue-400 inline-flex items-center gap-1"
                    >
                      <span>Read article</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </a>
                    <a
                      href={post.siteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 inline-flex items-center gap-1"
                    >
                      <span>Site</span>
                      <ArrowUpRight className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (selectedCategory !== 'all' || activeSearch) && !loading ? (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-10 text-center space-y-3">
            <p className="text-base font-medium text-zinc-800 dark:text-zinc-200">
              No dispatches matched your current filter.
            </p>
            <button
              type="button"
              onClick={() => {
                setSelectedCategory('all');
                setSearchInput('');
                setActiveSearch('');
                setPage(1);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              Reset filters
            </button>
          </div>
        ) : null}

        {/* Pagination */}
        {totalPages > 1 && (
          <nav aria-label="Pagination" className="flex items-center justify-between border-t border-zinc-200 dark:border-zinc-800 pt-6">
            <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
              Page {page} of {totalPages} · {totalPosts} total
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 disabled:opacity-40 hover:bg-zinc-50 dark:hover:bg-zinc-800 min-h-[40px]"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>Previous</span>
              </button>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] px-3 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 disabled:opacity-40 hover:bg-zinc-50 dark:hover:bg-zinc-800 min-h-[40px]"
              >
                <span>Next</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </nav>
        )}
      </section>

      {/* Monitored Sites Directory */}
      <section id="sites" aria-label="Monitored Websites" className="border-t border-zinc-200 dark:border-zinc-800 pt-12 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
          <div>
            <h2 className="font-display text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              Monitored Websites
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              Properties discovered via mrxshahin.ai.studio and curated additions tracked automatically.
            </p>
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
            {sites.length} active {sites.length === 1 ? 'site' : 'sites'}
          </span>
        </div>

        {sites.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sites.map((site) => (
              <div
                key={site.id}
                className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-4 flex flex-col justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                      {site.name}
                    </h3>
                    <a
                      href={site.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Visit ${site.name}`}
                      className="text-zinc-400 hover:text-blue-700 dark:hover:text-blue-400 shrink-0"
                    >
                      <ArrowUpRight className="h-4 w-4" />
                    </a>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate font-mono">
                    {site.url.replace(/^https?:\/\//, '')}
                  </p>
                </div>

                <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 border-t border-zinc-100 dark:border-zinc-800/70 pt-2.5 tabular-nums">
                  <span>{site.postCount} {site.postCount === 1 ? 'post' : 'posts'}</span>
                  <span>
                    {site.lastCheckedAt ? `Checked ${formatDate(site.lastCheckedAt)}` : 'Pending first check'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No monitored sites registered yet. Visit Admin to run an initial hub sync.
          </p>
        )}
      </section>
    </main>
  );
}
