import { ArrowRight, ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { fetchAdsWithFallback, fetchPostsWithFallback, isStaticMode, withBase } from '../lib/paths';
import type { CategoryCount, PublicAd, PublicPostSummary } from '../types';
import { SponsoredAdUnit } from './SponsoredAdUnit';
import { ThumbnailImage } from './ThumbnailImage';

interface HomePageProps {
  onNavigate: (path: string) => void;
  initialCategory?: string;
  initialSearch?: string;
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

function getLiveThumbnailSrc(post: PublicPostSummary): string {
  return post.updatedAt && post.updatedAt !== post.publishedAt
    ? `${post.thumbnailUrl}?v=${encodeURIComponent(post.updatedAt)}`
    : post.thumbnailUrl;
}

export function HomePage({
  onNavigate,
  initialCategory = 'all',
  initialSearch = '',
}: HomePageProps) {
  const [posts, setPosts] = useState<PublicPostSummary[]>([]);
  const [recentDispatches, setRecentDispatches] = useState<PublicPostSummary[]>([]);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [ads, setAds] = useState<PublicAd[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>(initialCategory || 'all');
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [activeSearch, setActiveSearch] = useState(initialSearch);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalPosts, setTotalPosts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setSelectedCategory(initialCategory || 'all');
    setPage(1);
  }, [initialCategory]);

  useEffect(() => {
    setSearchInput(initialSearch || '');
    setActiveSearch(initialSearch || '');
    setPage(1);
  }, [initialSearch]);

  const loadData = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) {
        setLoading(true);
        setError(false);
      }
      try {
        const isUnfilteredFirstPage = page === 1 && selectedCategory === 'all' && !activeSearch;
        const [postsJson, recentJson] = await Promise.all([
          fetchPostsWithFallback({
            category: selectedCategory,
            search: activeSearch,
            page,
            limit: 9,
          }),
          isUnfilteredFirstPage
            ? Promise.resolve(null)
            : fetchPostsWithFallback({ page: 1, limit: 5 }),
        ]);

        setPosts(postsJson.posts);
        setTotalPosts(postsJson.total);
        setTotalPages(postsJson.totalPages);
        setCategories(postsJson.categories || []);

        if (isUnfilteredFirstPage) {
          setRecentDispatches(postsJson.posts.slice(0, 5));
        } else if (recentJson) {
          setRecentDispatches((recentJson.posts || []).slice(0, 5));
        }

        setError(false);
      } catch {
        if (!options.silent) {
          setError(true);
        }
      } finally {
        if (!options.silent) {
          setLoading(false);
        }
      }
    },
    [page, selectedCategory, activeSearch]
  );

  useEffect(() => {
    if (activeSearch) {
      document.title = `Search: ${activeSearch} – M R S Auto Blog`;
    } else if (selectedCategory !== 'all') {
      document.title = `${selectedCategory} – M R S Auto Blog`;
    } else {
      document.title = 'M R S Auto Blog – Real-Time Website Updates & Innovation Dispatches';
    }
    loadData();
  }, [loadData, activeSearch, selectedCategory]);

  useEffect(() => {
    let cancelled = false;
    fetchAdsWithFallback()
      .then((loadedAds) => {
        if (!cancelled) {
          setAds(loadedAds);
        }
      })
      .catch(() => {
        // fail silent if ads endpoint is temporarily unavailable
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Real-time live inclusion of newly published, edited, or removed posts via SSE
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined' || isStaticMode()) {
      return;
    }

    let hasOpenedOnce = false;
    const source = new EventSource(withBase('/api/posts/stream'));

    source.onopen = () => {
      if (hasOpenedOnce) {
        void loadData({ silent: true });
      }
      hasOpenedOnce = true;
    };

    const handlePublished = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as { post?: PublicPostSummary };
        const incoming = payload.post;
        if (incoming) {
          setRecentDispatches((prev) => {
            if (prev.some((p) => p.id === incoming.id)) return prev;
            return [incoming, ...prev].slice(0, 5);
          });
          const matchesCategory = selectedCategory === 'all' || incoming.category === selectedCategory;
          if (matchesCategory && !activeSearch && page === 1) {
            setPosts((prev) => {
              if (prev.some((p) => p.id === incoming.id)) return prev;
              return [incoming, ...prev].slice(0, 9);
            });
          }
        }
      } catch {
        // ignore malformed SSE JSON
      }
      void loadData({ silent: true });
    };

    const handleUpdated = () => {
      void loadData({ silent: true });
    };

    const handleDeleted = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as { id?: number };
        if (typeof payload.id === 'number') {
          setPosts((prev) => prev.filter((p) => p.id !== payload.id));
          setRecentDispatches((prev) => prev.filter((p) => p.id !== payload.id));
        }
      } catch {
        // ignore malformed SSE JSON
      }
      void loadData({ silent: true });
    };

    source.addEventListener('post:published', handlePublished as EventListener);
    source.addEventListener('post:updated', handleUpdated as EventListener);
    source.addEventListener('post:deleted', handleDeleted as EventListener);

    return () => {
      source.close();
    };
  }, [loadData, selectedCategory, activeSearch, page]);

  // Debounce search input & sync URL query cleanly
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = searchInput.trim();
      if (trimmed !== activeSearch) {
        setPage(1);
        setActiveSearch(trimmed);
        if (typeof window !== 'undefined') {
          const base =
            selectedCategory !== 'all'
              ? `/category/${encodeURIComponent(selectedCategory)}`
              : '/';
          const nextUrl = trimmed ? `${base}?q=${encodeURIComponent(trimmed)}` : base;
          window.history.replaceState({}, '', `${withBase(nextUrl)}${window.location.hash}`);
        }
      }
    }, 280);
    return () => clearTimeout(timer);
  }, [searchInput, activeSearch, selectedCategory]);

  const handleSelectCategory = (cat: string) => {
    setSelectedCategory(cat);
    setPage(1);
    const qSuffix = activeSearch ? `?q=${encodeURIComponent(activeSearch)}` : '';
    if (cat === 'all') {
      onNavigate(`/${qSuffix}`);
    } else {
      onNavigate(`/category/${encodeURIComponent(cat)}${qSuffix}`);
    }
  };

  const resetAllFilters = () => {
    setSelectedCategory('all');
    setSearchInput('');
    setActiveSearch('');
    setPage(1);
    onNavigate('/');
  };

  const showFeatured =
    page === 1 && selectedCategory === 'all' && !activeSearch && posts.length > 0;
  const featuredPost = showFeatured ? posts[0] : null;
  const streamPosts = showFeatured ? posts.slice(1) : posts;
  const totalArchiveCount = categories.reduce((acc, item) => acc + item.count, 0);
  const inlineAds = ads.filter((ad) => ad.slot === 'inline');
  const sidebarAds = ads.filter((ad) => ad.slot === 'sidebar');
  const leadStreamPosts = streamPosts.length > 2 ? streamPosts.slice(0, 2) : streamPosts;
  const remainingStreamPosts = streamPosts.length > 2 ? streamPosts.slice(2) : [];

  const renderPostCard = (post: PublicPostSummary) => (
    <article
      key={post.id}
      className="group flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] overflow-hidden transition-colors hover:border-zinc-300 dark:hover:border-zinc-700"
    >
      <a
        href={withBase(`/post/${post.slug}`)}
        onClick={(e) => {
          e.preventDefault();
          onNavigate(`/post/${post.slug}`);
        }}
        className="block border-b border-zinc-100 dark:border-zinc-800/80"
      >
        <ThumbnailImage
          src={getLiveThumbnailSrc(post)}
          alt={post.title}
          title={post.title}
          siteName={post.category}
        />
      </a>

      <div className="flex flex-1 flex-col justify-between p-5 space-y-4">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <button
              type="button"
              onClick={() => handleSelectCategory(post.category)}
              className="font-medium text-blue-700 dark:text-blue-400 hover:underline"
            >
              {post.category}
            </button>
            <span aria-hidden="true">·</span>
            <time dateTime={post.publishedAt} className="tabular-nums">
              {formatDate(post.publishedAt)}
            </time>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{post.readingTimeMinutes} min read</span>
          </div>

          <h2 className="font-display text-xl font-semibold leading-snug text-zinc-900 dark:text-zinc-50 [text-wrap:balance]">
            <a
              href={withBase(`/post/${post.slug}`)}
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

        <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800/80 text-xs">
          <a
            href={withBase(`/post/${post.slug}`)}
            onClick={(e) => {
              e.preventDefault();
              onNavigate(`/post/${post.slug}`);
            }}
            className="font-medium text-zinc-800 dark:text-zinc-200 hover:text-blue-700 dark:hover:text-blue-400 inline-flex items-center gap-1"
          >
            <span>Continue reading</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </article>
  );

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12 space-y-12">
      {/* Top Lead Feature or Active Filter Context */}
      {loading && posts.length === 0 ? (
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch border-b border-zinc-200 dark:border-zinc-800 pb-10">
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
          <p className="text-sm text-zinc-600 dark:text-zinc-300 font-medium">
            Unable to load articles right now.
          </p>
          <button
            type="button"
            onClick={() => void loadData()}
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
              href={withBase(`/post/${featuredPost.slug}`)}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(`/post/${featuredPost.slug}`);
              }}
              className="group lg:col-span-7 block overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822]"
            >
              <ThumbnailImage
                src={getLiveThumbnailSrc(featuredPost)}
                alt={featuredPost.title}
                title={featuredPost.title}
                siteName={featuredPost.category}
                className="lg:h-full"
                priority
              />
            </a>

            <div className="lg:col-span-5 flex flex-col justify-between py-1">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  <button
                    type="button"
                    onClick={() => handleSelectCategory(featuredPost.category)}
                    className="text-blue-700 dark:text-blue-400 font-semibold hover:underline"
                  >
                    {featuredPost.category}
                  </button>
                  <span aria-hidden="true">·</span>
                  <time dateTime={featuredPost.publishedAt} className="tabular-nums">
                    {formatDate(featuredPost.publishedAt)}
                  </time>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{featuredPost.readingTimeMinutes} min read</span>
                </div>

                <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 leading-[1.15] [text-wrap:balance]">
                  <a
                    href={withBase(`/post/${featuredPost.slug}`)}
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

              <div className="pt-6">
                <a
                  href={withBase(`/post/${featuredPost.slug}`)}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(`/post/${featuredPost.slug}`);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-5 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Read Full Article</span>
                  <ArrowRight className="h-4 w-4" />
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
                src={withBase('/src/assets/images/editorial_hero_abstract_1795437088233.jpg')}
                alt="M R S Auto Blog editorial publication"
                referrerPolicy="no-referrer"
                className="aspect-video w-full lg:h-full object-cover"
              />
            </div>
            <div className="lg:col-span-5 flex flex-col justify-center space-y-4">
              <p className="text-xs font-medium tracking-wide text-zinc-500 dark:text-zinc-400">
                M R S Auto Blog
              </p>
              <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 leading-[1.15] [text-wrap:balance]">
                Dispatches on product releases, web updates, and technical innovations.
              </h1>
              <p className="text-base leading-relaxed text-zinc-600 dark:text-zinc-300">
                New articles appear automatically in real time as updates are published.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* Active Category or Search Context Banner */}
      {(selectedCategory !== 'all' || activeSearch) && (
        <section className="border-b border-zinc-200 dark:border-zinc-800 pb-6 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {activeSearch ? 'Search Results' : 'Label Archive'}
            </p>
            <h1 className="font-display text-3xl font-semibold text-zinc-900 dark:text-zinc-50 mt-1">
              {activeSearch ? `Results for “${activeSearch}”` : selectedCategory}
            </h1>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="text-zinc-500 dark:text-zinc-400 tabular-nums">
              {totalPosts} {totalPosts === 1 ? 'article' : 'articles'}
            </span>
            <button
              type="button"
              onClick={resetAllFilters}
              className="font-medium text-blue-700 dark:text-blue-400 hover:underline"
            >
              View all posts
            </button>
          </div>
        </section>
      )}

      {/* Authentic 2-Column Blogger Layout: Main Article Stream (8 cols) + Classic Blogger Sidebar (4 cols) */}
      <div id="archive" className="scroll-mt-24 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-start">
        {/* Main Column: Label Filter Bar + Editorial Blog Stream */}
        <div className="lg:col-span-8 space-y-8">
          <div id="labels" className="scroll-mt-24 flex items-center gap-1.5 overflow-x-auto pb-2 border-b border-zinc-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => handleSelectCategory('all')}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px] ${
                selectedCategory === 'all'
                  ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                  : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
              }`}
            >
              All Dispatches
            </button>
            {categories.map((cat) => (
              <button
                key={cat.category}
                type="button"
                onClick={() => handleSelectCategory(cat.category)}
                className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px] ${
                  selectedCategory === cat.category
                    ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                    : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                }`}
              >
                {cat.category} <span className="opacity-65 tabular-nums">({cat.count})</span>
              </button>
            ))}
          </div>

          {streamPosts.length > 0 ? (
            <div className="space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-7">
                {leadStreamPosts.map(renderPostCard)}
              </div>

              {inlineAds.length > 0 && (
                <div className="space-y-4">
                  {inlineAds.map((ad) => (
                    <SponsoredAdUnit key={ad.id} ad={ad} variant="inline" />
                  ))}
                </div>
              )}

              {remainingStreamPosts.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-7">
                  {remainingStreamPosts.map(renderPostCard)}
                </div>
              )}
            </div>
          ) : (selectedCategory !== 'all' || activeSearch) && !loading ? (
            <div className="space-y-8">
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-10 text-center space-y-3">
                <p className="text-base font-medium text-zinc-800 dark:text-zinc-200">
                  No articles matched your current filter.
                </p>
                <button
                  type="button"
                  onClick={resetAllFilters}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  Reset filters
                </button>
              </div>
              {inlineAds.length > 0 && (
                <div className="space-y-4">
                  {inlineAds.map((ad) => (
                    <SponsoredAdUnit key={ad.id} ad={ad} variant="inline" />
                  ))}
                </div>
              )}
            </div>
          ) : inlineAds.length > 0 && !loading ? (
            <div className="space-y-4">
              {inlineAds.map((ad) => (
                <SponsoredAdUnit key={ad.id} ad={ad} variant="inline" />
              ))}
            </div>
          ) : null}

          {/* Numbered Pagination */}
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
        </div>

        {/* Classic Blogger Right Sidebar */}
        <aside aria-label="Blog Sidebar" className="lg:col-span-4 lg:sticky lg:top-24 space-y-8 lg:border-l border-zinc-200 dark:border-zinc-800 lg:pl-8">
          {/* Widget 1: Search This Blog */}
          <section className="space-y-3">
            <h2 className="font-display text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Search This Blog
            </h2>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search innovations, guides..."
                aria-label="Search articles"
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] pl-9 pr-9 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-blue-700 dark:focus:border-blue-400 focus:outline-none min-h-[42px]"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput('');
                    setActiveSearch('');
                    setPage(1);
                    const base =
                      selectedCategory !== 'all'
                        ? `/category/${encodeURIComponent(selectedCategory)}`
                        : '/';
                    onNavigate(base);
                  }}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 p-1"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </section>

          {/* Widget 2: Recent Dispatches */}
          {recentDispatches.length > 0 && (
            <section className="border-t border-zinc-200 dark:border-zinc-800 pt-7 space-y-4">
              <h2 className="font-display text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Recent Dispatches
              </h2>
              <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {recentDispatches.map((item) => (
                  <article key={item.id} className="py-3.5 first:pt-0 last:pb-0 flex items-start gap-3.5 group">
                    <a
                      href={withBase(`/post/${item.slug}`)}
                      onClick={(e) => {
                        e.preventDefault();
                        onNavigate(`/post/${item.slug}`);
                      }}
                      className="w-24 shrink-0 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-900"
                    >
                      <ThumbnailImage
                        src={getLiveThumbnailSrc(item)}
                        alt={item.title}
                        title={item.title}
                        siteName={item.category}
                      />
                    </a>
                    <div className="min-w-0 space-y-1">
                      <h3 className="text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-100 line-clamp-2">
                        <a
                          href={withBase(`/post/${item.slug}`)}
                          onClick={(e) => {
                            e.preventDefault();
                            onNavigate(`/post/${item.slug}`);
                          }}
                          className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
                        >
                          {item.title}
                        </a>
                      </h3>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                        {formatDate(item.publishedAt)}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {/* Widget 3: Labels Directory */}
          {categories.length > 0 && (
            <section className="border-t border-zinc-200 dark:border-zinc-800 pt-7 space-y-3">
              <h2 className="font-display text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Labels
              </h2>
              <ul className="divide-y divide-zinc-200/70 dark:divide-zinc-800/70 text-sm">
                <li>
                  <button
                    type="button"
                    onClick={() => handleSelectCategory('all')}
                    className={`w-full py-2.5 flex items-center justify-between text-left transition-colors ${
                      selectedCategory === 'all'
                        ? 'font-semibold text-blue-700 dark:text-blue-400'
                        : 'text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white'
                    }`}
                  >
                    <span>All Dispatches</span>
                    <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                      {totalArchiveCount}
                    </span>
                  </button>
                </li>
                {categories.map((cat) => (
                  <li key={cat.category}>
                    <button
                      type="button"
                      onClick={() => handleSelectCategory(cat.category)}
                      className={`w-full py-2.5 flex items-center justify-between gap-3 text-left transition-colors ${
                        selectedCategory === cat.category
                          ? 'font-semibold text-blue-700 dark:text-blue-400'
                          : 'text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white'
                      }`}
                    >
                      <span className="truncate">{cat.category}</span>
                      <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums shrink-0">
                        {cat.count}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Widget 3.5: Partner Recommendations */}
          {sidebarAds.length > 0 && (
            <section aria-label="Partner Recommendations" className="border-t border-zinc-200 dark:border-zinc-800 pt-7 space-y-4">
              {sidebarAds.map((ad) => (
                <SponsoredAdUnit key={ad.id} ad={ad} variant="sidebar" />
              ))}
            </section>
          )}

          {/* Widget 4: About & Feeds */}
          <section className="border-t border-zinc-200 dark:border-zinc-800 pt-7 space-y-3">
            <h2 className="font-display text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              About This Blog
            </h2>
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Editorial publication tracking real-time software launches, technical guides, and web platform innovations as they go live.
            </p>
            <div className="flex items-center gap-5 pt-1 text-xs font-medium">
              <a
                href={withBase('/rss.xml')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-700 dark:text-blue-400 hover:underline"
              >
                Subscribe via RSS
              </a>
              <a
                href={withBase('/sitemap.xml')}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:underline"
              >
                XML Sitemap
              </a>
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
