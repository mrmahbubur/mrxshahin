import { ArrowRight, ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { CategoryCount, PublicPostSummary } from '../types';
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

export function HomePage({
  onNavigate,
  initialCategory = 'all',
  initialSearch = '',
}: HomePageProps) {
  const [posts, setPosts] = useState<PublicPostSummary[]>([]);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
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
        const params = new URLSearchParams({
          page: String(page),
          limit: '10',
        });
        if (selectedCategory !== 'all') params.set('category', selectedCategory);
        if (activeSearch) params.set('search', activeSearch);

        const postsRes = await fetch(`/api/posts?${params.toString()}`);
        if (!postsRes.ok) throw new Error('Failed to load');

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
      document.title = 'M R S Auto Blog – Automated Website Updates & Innovation Dispatches';
    }
    loadData();
  }, [loadData, activeSearch, selectedCategory]);

  // Real-time live inclusion of newly published, edited, or removed posts via SSE
  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }

    let hasOpenedOnce = false;
    const source = new EventSource('/api/posts/stream');

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
          const matchesCategory = selectedCategory === 'all' || incoming.category === selectedCategory;
          if (matchesCategory && !activeSearch && page === 1) {
            setPosts((prev) => {
              if (prev.some((p) => p.id === incoming.id)) return prev;
              return [incoming, ...prev].slice(0, 10);
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
          window.history.replaceState({}, '', nextUrl);
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

  const showFeatured =
    page === 1 && selectedCategory === 'all' && !activeSearch && posts.length > 0;
  const featuredPost = showFeatured ? posts[0] : null;
  const gridPosts = showFeatured ? posts.slice(1) : posts;

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-14 space-y-12">
      {/* Featured Latest Post or Clean Editorial Empty State */}
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
        <section aria-label="Featured Post" className="border-b border-zinc-200 dark:border-zinc-800 pb-12">
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

              <div className="pt-6">
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
                alt="M R S Auto Blog editorial publication"
                referrerPolicy="no-referrer"
                className="aspect-video w-full lg:h-full object-cover"
              />
            </div>
            <div className="lg:col-span-5 flex flex-col justify-center space-y-4">
              <p className="text-xs font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                M R S Auto Blog
              </p>
              <h1 className="font-display text-3xl sm:text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 leading-[1.15] [text-wrap:balance]">
                Dispatches on product releases, web updates, and technical milestones.
              </h1>
              <p className="text-base leading-relaxed text-zinc-600 dark:text-zinc-300">
                New articles will appear here as soon as they are published.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* Active Category or Search Context Header */}
      {(selectedCategory !== 'all' || activeSearch) && (
        <section className="border-b border-zinc-200 dark:border-zinc-800 pb-6 flex flex-col sm:flex-row sm:items-end justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
              {activeSearch ? 'Search Results' : 'Category'}
            </p>
            <h1 className="font-display text-3xl font-semibold text-zinc-900 dark:text-zinc-50 mt-1">
              {activeSearch ? `Results for “${activeSearch}”` : selectedCategory}
            </h1>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
            {totalPosts} {totalPosts === 1 ? 'article' : 'articles'}
          </p>
        </section>
      )}

      {/* Category Filter & Search Toolbar + Dispatches Archive */}
      <section id="categories" aria-label="Blog Archive" className="space-y-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => handleSelectCategory('all')}
              className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px] ${
                selectedCategory === 'all'
                  ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                  : 'border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100'
              }`}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat.category}
                type="button"
                onClick={() => handleSelectCategory(cat.category)}
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
              placeholder="Search articles..."
              aria-label="Search articles"
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] pl-9 pr-9 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:border-blue-600 dark:focus:border-blue-400 focus:outline-none min-h-[40px]"
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
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Grid of Post Cards (only thumbnail, title, summary, date, category, reading time) */}
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

                  <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/80 text-xs">
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
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (selectedCategory !== 'all' || activeSearch) && !loading ? (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-10 text-center space-y-3">
            <p className="text-base font-medium text-zinc-800 dark:text-zinc-200">
              No articles matched your current filter.
            </p>
            <button
              type="button"
              onClick={() => {
                setSelectedCategory('all');
                setSearchInput('');
                setActiveSearch('');
                setPage(1);
                onNavigate('/');
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
    </main>
  );
}
