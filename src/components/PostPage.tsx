import { ArrowLeft, ArrowUpRight, Check, Copy, Share2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import type { FullPost, PublicPostSummary } from '../types';
import { ThumbnailImage } from './ThumbnailImage';

interface PostPageProps {
  slug: string;
  onNavigate: (path: string) => void;
}

interface TocEntry {
  id: string;
  text: string;
  level: 'h2' | 'h3';
}

const ALLOWED_TAGS = new Set([
  'h2',
  'h3',
  'h4',
  'p',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'strong',
  'b',
  'em',
  'i',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
  'br',
  'figure',
  'figcaption',
]);

function slugifyHeading(text: string, index: number): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `section-${index}`;
}

function isSafeHref(href: string | null): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/') || trimmed.startsWith('#')) {
    return trimmed;
  }
  return null;
}

function parseSafeArticleContent(html: string): {
  nodes: React.ReactNode[];
  toc: TocEntry[];
} {
  if (typeof window === 'undefined' || !html) {
    return { nodes: [], toc: [] };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const toc: TocEntry[] = [];
  let headingCounter = 0;

  function renderNode(node: ChildNode, key: string): React.ReactNode {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      return Array.from(el.childNodes).map((child, idx) => renderNode(child, `${key}-${idx}`));
    }

    const children = Array.from(el.childNodes).map((child, idx) => renderNode(child, `${key}-${idx}`));

    if (tag === 'h2' || tag === 'h3') {
      const text = (el.textContent || '').trim();
      const id = el.getAttribute('id') || slugifyHeading(text, headingCounter++);
      if (text) {
        toc.push({ id, text, level: tag });
      }
      return React.createElement(tag, { key, id }, children);
    }

    if (tag === 'a') {
      const safeHref = isSafeHref(el.getAttribute('href'));
      if (!safeHref) return <span key={key}>{children}</span>;
      const isExternal = safeHref.startsWith('http://') || safeHref.startsWith('https://');
      return (
        <a
          key={key}
          href={safeHref}
          target={isExternal ? '_blank' : undefined}
          rel={isExternal ? 'noopener noreferrer' : undefined}
        >
          {children}
        </a>
      );
    }

    if (tag === 'br' || tag === 'hr') {
      return React.createElement(tag, { key });
    }

    return React.createElement(tag, { key }, children);
  }

  const nodes = Array.from(doc.body.childNodes).map((child, idx) => renderNode(child, `root-${idx}`));
  return { nodes, toc };
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function PostPage({ slug, onNavigate }: PostPageProps) {
  const [post, setPost] = useState<FullPost | null>(null);
  const [related, setRelated] = useState<PublicPostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });

    const fetchPost = (silent = false) => {
      fetch(`/api/posts/${encodeURIComponent(slug)}`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      })
        .then(async (res) => {
          if (!res.ok) throw new Error('Dispatch not found');
          return res.json() as Promise<{ post: FullPost; related: PublicPostSummary[] }>;
        })
        .then((data) => {
          if (cancelled) return;
          setPost(data.post);
          setRelated(data.related || []);
          setError(null);
          document.title = `${data.post.title} – M R S Auto Blog`;
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Unable to load dispatch');
          if (silent) setPost(null);
        })
        .finally(() => {
          if (!cancelled && !silent) setLoading(false);
        });
    };

    fetchPost(false);

    let source: EventSource | null = null;
    if (typeof window !== 'undefined' && typeof EventSource !== 'undefined') {
      source = new EventSource('/api/posts/stream');
      const handleEvent = (ev: MessageEvent) => {
        try {
          const payload = JSON.parse(ev.data) as { slug?: string; post?: { slug?: string } };
          const eventSlug = payload.slug || payload.post?.slug;
          if (!eventSlug || eventSlug === slug) {
            fetchPost(true);
          }
        } catch {
          // ignore malformed SSE JSON
        }
      };
      source.addEventListener('post:updated', handleEvent as EventListener);
      source.addEventListener('post:deleted', handleEvent as EventListener);
      source.addEventListener('post:published', () => fetchPost(true));
    }

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [slug]);

  const parsedContent = useMemo(
    () => (post ? parseSafeArticleContent(post.contentHtml) : { nodes: [], toc: [] }),
    [post]
  );

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-4 sm:px-6 py-12 space-y-6">
        <div className="h-4 w-32 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
        <div className="h-12 w-3/4 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
        <div className="aspect-video w-full rounded-xl bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
      </main>
    );
  }

  if (error || !post) {
    return (
      <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16 text-center space-y-4">
        <h1 className="font-display text-3xl font-semibold text-zinc-900 dark:text-zinc-50">
          Dispatch Unavailable
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {error || 'The requested article could not be found.'}
        </p>
        <button
          type="button"
          onClick={() => onNavigate('/')}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Dispatches</span>
        </button>
      </main>
    );
  }

  const shareUrl = typeof window !== 'undefined' ? encodeURIComponent(window.location.href) : '';
  const shareTitle = encodeURIComponent(post.title);

  return (
    <main className="mx-auto max-w-5xl px-4 sm:px-6 py-10 sm:py-14 space-y-12">
      {/* Blogger Breadcrumb Navigation */}
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/');
          }}
          className="inline-flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Home</span>
        </a>
        <span aria-hidden="true">/</span>
        <a
          href={`/category/${encodeURIComponent(post.category)}`}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(`/category/${encodeURIComponent(post.category)}`);
          }}
          className="text-blue-700 dark:text-blue-400 hover:underline"
        >
          {post.category}
        </a>
      </nav>

      {/* Article Header */}
      <header className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          <span className="text-blue-700 dark:text-blue-400 font-semibold">{post.category}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={post.publishedAt} className="tabular-nums">
            {formatDate(post.publishedAt)}
          </time>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{post.readingTimeMinutes} min read</span>
        </div>

        <h1 className="font-display text-3xl sm:text-5xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 leading-[1.12] [text-wrap:balance]">
          {post.title}
        </h1>

        <p className="text-lg leading-relaxed text-zinc-600 dark:text-zinc-300">
          {post.summary}
        </p>

        {/* Actions & Share Bar */}
        <div className="pt-2 flex flex-wrap items-center gap-3">
          <a
            href={post.siteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2 text-xs font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
          >
            <span>Visit Site</span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>

          <button
            type="button"
            onClick={handleCopyLink}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] px-3.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? 'Copied' : 'Copy Link'}</span>
          </button>

          <a
            href={`https://x.com/intent/tweet?text=${shareTitle}&url=${shareUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] px-3.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
          >
            <Share2 className="h-3.5 w-3.5" />
            <span>Share on X</span>
          </a>

          <a
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] px-3.5 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
          >
            <Share2 className="h-3.5 w-3.5" />
            <span>LinkedIn</span>
          </a>
        </div>
      </header>

      {/* Hero Thumbnail */}
      <figure className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822]">
        <ThumbnailImage
          src={
            post.updatedAt && post.updatedAt !== post.publishedAt
              ? `${post.thumbnailUrl}?v=${encodeURIComponent(post.updatedAt)}`
              : post.thumbnailUrl
          }
          alt={post.title}
          title={post.title}
          siteName={post.siteName}
          priority
        />
      </figure>

      {/* Asymmetric 2-Column Editorial Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-start">
        <article className="lg:col-span-8 max-w-prose article-prose text-zinc-800 dark:text-zinc-200">
          {parsedContent.nodes}
        </article>

        {/* Sticky Sidebar: Table of Contents & Source Context */}
        <aside className="lg:col-span-4 lg:sticky lg:top-24 space-y-8 border-t lg:border-t-0 lg:border-l border-zinc-200 dark:border-zinc-800 pt-6 lg:pt-0 lg:pl-8">
          {parsedContent.toc.length > 0 && (
            <nav aria-label="Table of Contents" className="space-y-3">
              <h2 className="font-sans text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                In This Dispatch
              </h2>
              <ul className="space-y-2 text-sm">
                {parsedContent.toc.map((entry) => (
                  <li key={entry.id} className={entry.level === 'h3' ? 'pl-3' : ''}>
                    <a
                      href={`#${entry.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(entry.id)?.scrollIntoView({ behavior: 'smooth' });
                      }}
                      className="text-zinc-600 dark:text-zinc-400 hover:text-blue-700 dark:hover:text-blue-400 transition-colors leading-snug block"
                    >
                      {entry.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <div className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-6 text-xs">
            <h3 className="font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
              Website
            </h3>
            <p className="font-medium text-zinc-900 dark:text-zinc-100">{post.category}</p>
            <a
              href={post.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-medium text-blue-700 dark:text-blue-400 hover:underline"
            >
              <span>Visit site</span>
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
            </a>
          </div>

          {post.tags.length > 0 && (
            <div className="space-y-2 border-t border-zinc-200 dark:border-zinc-800 pt-6 text-xs">
              <h3 className="font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                Topics
              </h3>
              <p className="text-zinc-600 dark:text-zinc-400 leading-relaxed">
                {post.tags.map((t) => `#${t}`).join(' · ')}
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* Related Posts */}
      {related.length > 0 && (
        <section aria-label="Related Dispatches" className="border-t border-zinc-200 dark:border-zinc-800 pt-10 space-y-6">
          <h2 className="font-display text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            Related Dispatches
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {related.map((item) => (
              <article
                key={item.id}
                className="group rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] overflow-hidden flex flex-col"
              >
                <a
                  href={`/post/${item.slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(`/post/${item.slug}`);
                  }}
                >
                  <ThumbnailImage
                    src={
                      item.updatedAt && item.updatedAt !== item.publishedAt
                        ? `${item.thumbnailUrl}?v=${encodeURIComponent(item.updatedAt)}`
                        : item.thumbnailUrl
                    }
                    alt={item.title}
                    title={item.title}
                    siteName={item.siteName}
                  />
                </a>
                <div className="p-4 space-y-2">
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">
                    <span>{item.siteName}</span>
                    <span aria-hidden="true"> · </span>
                    <span className="tabular-nums">{item.readingTimeMinutes} min</span>
                  </div>
                  <h3 className="font-display text-base font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
                    <a
                      href={`/post/${item.slug}`}
                      onClick={(e) => {
                        e.preventDefault();
                        onNavigate(`/post/${item.slug}`);
                      }}
                      className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
                    >
                      {item.title}
                    </a>
                  </h3>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
