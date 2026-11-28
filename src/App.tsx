import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminPage } from './components/AdminPage';
import { Header } from './components/Header';
import { HomePage } from './components/HomePage';
import { PostPage } from './components/PostPage';
import { getRouteFromWindow, isRelativeBase, toRouteHref, withBase } from './lib/paths';

interface AdminWindow extends Window {
  __MRS_ADMIN_PATH__?: string;
}

function getLocationPathWithQuery(): { pathname: string; searchQuery: string } {
  return getRouteFromWindow();
}

function getPreferredScrollBehavior(): ScrollBehavior {
  if (typeof window === 'undefined') return 'auto';
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function decodeHashId(rawHash: string): string {
  const stripped = rawHash.replace(/^#/, '').trim();
  if (!stripped) return '';
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

export default function App() {
  const [locationState, setLocationState] = useState(getLocationPathWithQuery);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const hashScrollCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  const cancelPendingHashScroll = useCallback(() => {
    if (hashScrollCleanupRef.current) {
      hashScrollCleanupRef.current();
      hashScrollCleanupRef.current = null;
    }
  }, []);

  const scrollToHashTarget = useCallback(
    (hashId: string) => {
      cancelPendingHashScroll();
      const cleanId = decodeHashId(hashId);
      if (!cleanId || typeof document === 'undefined') return;

      const scrollToEl = (el: HTMLElement) => {
        el.scrollIntoView({ behavior: getPreferredScrollBehavior(), block: 'start' });
      };

      const tryScrollNow = (): boolean => {
        const target = document.getElementById(cleanId);
        if (!target) return false;
        scrollToEl(target);
        return true;
      };

      let observer: MutationObserver | null = null;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      let rafId = 0;

      const cleanup = () => {
        if (rafId) cancelAnimationFrame(rafId);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        observer?.disconnect();
        observer = null;
        fallbackTimer = null;
      };

      hashScrollCleanupRef.current = cleanup;

      rafId = requestAnimationFrame(() => {
        if (tryScrollNow()) {
          cancelPendingHashScroll();
          return;
        }

        if (typeof MutationObserver !== 'undefined' && document.body) {
          observer = new MutationObserver(() => {
            if (tryScrollNow()) {
              cancelPendingHashScroll();
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }

        fallbackTimer = setTimeout(() => {
          tryScrollNow();
          cancelPendingHashScroll();
        }, 2500);
      });
    },
    [cancelPendingHashScroll]
  );

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash && !window.location.hash.startsWith('#/')) {
      scrollToHashTarget(window.location.hash);
    }

    const onPopState = () => {
      setLocationState(getLocationPathWithQuery());
      if (window.location.hash && !window.location.hash.startsWith('#/')) {
        scrollToHashTarget(window.location.hash);
      } else {
        cancelPendingHashScroll();
      }
    };

    const onHashChange = () => {
      setLocationState(getLocationPathWithQuery());
      if (window.location.hash && !window.location.hash.startsWith('#/')) {
        scrollToHashTarget(window.location.hash);
      } else {
        cancelPendingHashScroll();
        window.scrollTo({ top: 0, behavior: getPreferredScrollBehavior() });
      }
    };

    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      cancelPendingHashScroll();
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [scrollToHashTarget, cancelPendingHashScroll]);

  const navigate = useCallback(
    (nextPath: string) => {
      const hashIndex = nextPath.indexOf('#');
      const pathAndQuery = hashIndex >= 0 ? nextPath.slice(0, hashIndex) : nextPath;
      const rawHash = hashIndex >= 0 ? nextPath.slice(hashIndex + 1) : '';
      const targetFull = pathAndQuery || '/';

      if (isRelativeBase()) {
        if (rawHash) {
          if (window.location.hash.startsWith('#/') && window.location.hash !== '#/') {
            window.history.pushState({}, '', '#/');
            setLocationState(getLocationPathWithQuery());
          }
          scrollToHashTarget(rawHash);
          return;
        }
        const nextHashUrl = `#${targetFull}`;
        if (window.location.hash !== nextHashUrl) {
          window.history.pushState({}, '', nextHashUrl);
        }
        setLocationState(getLocationPathWithQuery());
        cancelPendingHashScroll();
        window.scrollTo({ top: 0, behavior: getPreferredScrollBehavior() });
        return;
      }

      const nextRelativeWithHash = rawHash ? `${targetFull}#${rawHash}` : targetFull;
      const nextUrlWithHash = withBase(nextRelativeWithHash);
      const currentFull = window.location.pathname + window.location.search + window.location.hash;

      if (nextUrlWithHash !== currentFull) {
        window.history.pushState({}, '', nextUrlWithHash);
      }
      setLocationState(getLocationPathWithQuery());

      if (rawHash) {
        scrollToHashTarget(rawHash);
      } else {
        cancelPendingHashScroll();
        window.scrollTo({ top: 0, behavior: getPreferredScrollBehavior() });
      }
    },
    [scrollToHashTarget, cancelPendingHashScroll]
  );

  const { pathname, searchQuery } = locationState;
  const serverAdminPath =
    typeof window !== 'undefined' ? (window as AdminWindow).__MRS_ADMIN_PATH__ : undefined;

  const isAdmin = Boolean(
    serverAdminPath &&
      (pathname.replace(/\/+$/, '') === serverAdminPath ||
        pathname.startsWith(`${serverAdminPath}/`))
  );

  const postMatch = pathname.match(/^\/post\/([a-z0-9-]+)\/?$/i);
  const categoryMatch = pathname.match(/^\/category\/([^/]+)\/?$/i);

  let decodedCategory = 'all';
  if (categoryMatch) {
    try {
      decodedCategory = decodeURIComponent(categoryMatch[1]);
    } catch {
      decodedCategory = categoryMatch[1];
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF9F6] dark:bg-[#0B0E14] text-zinc-900 dark:text-zinc-100 transition-colors">
      <Header
        currentPath={pathname}
        onNavigate={navigate}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((v) => !v)}
      />

      <div className="flex-1">
        {isAdmin ? (
          <AdminPage token={adminToken} onSetToken={setAdminToken} onNavigate={navigate} />
        ) : postMatch ? (
          <PostPage slug={postMatch[1].toLowerCase()} onNavigate={navigate} />
        ) : (
          <HomePage
            onNavigate={navigate}
            initialCategory={decodedCategory}
            initialSearch={searchQuery}
          />
        )}
      </div>

      <footer className="border-t border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14]">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 sm:py-12 text-zinc-600 dark:text-zinc-400">
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-8 md:gap-12 pb-8">
            <div className="max-w-lg space-y-2.5">
              <p className="font-display text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                M R S Auto Blog
              </p>
              <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                Independent editorial coverage documenting verified software releases, live web platform capabilities, streaming channels, and technical guides as updates go live.
              </p>
            </div>

            <nav aria-label="Footer sections" className="shrink-0 space-y-2.5 md:text-right">
              <h2 className="font-semibold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">
                Sections
              </h2>
              <ul className="flex flex-wrap items-center gap-x-6 gap-y-1.5 md:justify-end text-sm">
                <li>
                  <a
                    href={toRouteHref('/')}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate('/');
                    }}
                    className="inline-flex min-h-[36px] items-center rounded font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 transition-colors"
                  >
                    Latest Dispatches
                  </a>
                </li>
                <li>
                  <a
                    href={toRouteHref('/#labels')}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate('/#labels');
                    }}
                    className="inline-flex min-h-[36px] items-center rounded font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 transition-colors"
                  >
                    Topic Labels
                  </a>
                </li>
                <li>
                  <a
                    href={toRouteHref('/#archive')}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate('/#archive');
                    }}
                    className="inline-flex min-h-[36px] items-center rounded font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 dark:focus-visible:ring-zinc-500 transition-colors"
                  >
                    Full Archive
                  </a>
                </li>
              </ul>
            </nav>
          </div>

          <div className="border-t border-zinc-200/80 dark:border-zinc-800/80 pt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            <p>© {new Date().getFullYear()} M R S Auto Blog. All dispatches verified from live sources.</p>
            <p>Product updates, apps, AI features &amp; guides</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
