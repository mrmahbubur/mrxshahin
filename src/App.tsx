import { useCallback, useEffect, useState } from 'react';
import { AdminPage } from './components/AdminPage';
import { Header } from './components/Header';
import { HomePage } from './components/HomePage';
import { PostPage } from './components/PostPage';

interface AdminWindow extends Window {
  __MRS_ADMIN_PATH__?: string;
}

function getLocationPathWithQuery(): { pathname: string; searchQuery: string } {
  if (typeof window === 'undefined') return { pathname: '/', searchQuery: '' };
  const params = new URLSearchParams(window.location.search);
  return {
    pathname: window.location.pathname || '/',
    searchQuery: params.get('q') || '',
  };
}

export default function App() {
  const [locationState, setLocationState] = useState(getLocationPathWithQuery);
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });
  const [adminToken, setAdminToken] = useState<string | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  useEffect(() => {
    const onPopState = () => {
      setLocationState(getLocationPathWithQuery());
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const scrollToHashTarget = useCallback((hashId: string) => {
    const attemptScroll = (remaining: number) => {
      const target = document.getElementById(hashId);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (remaining > 0) {
        setTimeout(() => attemptScroll(remaining - 1), 60);
      }
    };
    requestAnimationFrame(() => attemptScroll(5));
  }, []);

  const navigate = useCallback(
    (nextPath: string) => {
      const [pathAndQuery, rawHash] = nextPath.split('#');
      const targetFull = pathAndQuery || '/';
      const currentFull = window.location.pathname + window.location.search;
      if (targetFull !== currentFull) {
        window.history.pushState({}, '', targetFull);
      }
      setLocationState(getLocationPathWithQuery());

      if (rawHash) {
        scrollToHashTarget(rawHash);
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [scrollToHashTarget]
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
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-12 gap-8 items-start text-sm text-zinc-600 dark:text-zinc-400">
          <div className="sm:col-span-2 md:col-span-6 space-y-2.5">
            <p className="font-display text-base font-semibold text-zinc-900 dark:text-zinc-100">
              M R S Auto Blog
            </p>
            <p className="max-w-md text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
              Independent editorial coverage documenting verified software releases, live web platform capabilities, and technical troubleshooting guides as updates go live.
            </p>
            <p className="pt-1 text-xs text-zinc-500 dark:text-zinc-400">
              © {new Date().getFullYear()} M R S Auto Blog. All dispatches verified from live sources.
            </p>
          </div>

          <div className="md:col-span-3 space-y-2.5 text-xs">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Sections</h2>
            <ul className="space-y-2">
              <li>
                <a
                  href="/"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/');
                  }}
                  className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                >
                  Latest Dispatches
                </a>
              </li>
              <li>
                <a
                  href="/#labels"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/#labels');
                  }}
                  className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                >
                  Topic Labels
                </a>
              </li>
              <li>
                <a
                  href="/#archive"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/#archive');
                  }}
                  className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                >
                  Full Archive
                </a>
              </li>
            </ul>
          </div>

          <div className="md:col-span-3 space-y-2.5 text-xs">
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Syndication</h2>
            <ul className="space-y-2">
              <li>
                <a
                  href="/rss.xml"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                >
                  RSS 2.0 Feed
                </a>
              </li>
              <li>
                <a
                  href="/sitemap.xml"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                >
                  XML Sitemap
                </a>
              </li>
            </ul>
          </div>
        </div>
      </footer>
    </div>
  );
}
