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

  const navigate = useCallback((nextPath: string) => {
    const currentFull = window.location.pathname + window.location.search;
    if (nextPath !== currentFull) {
      window.history.pushState({}, '', nextPath);
    }
    setLocationState(getLocationPathWithQuery());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

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
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-zinc-500 dark:text-zinc-400">
          <p>© {new Date().getFullYear()} M R S Auto Blog.</p>
          <div className="flex items-center gap-5">
            <a href="/rss.xml" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-900 dark:hover:text-zinc-100">
              RSS
            </a>
            <a href="/sitemap.xml" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-900 dark:hover:text-zinc-100">
              Sitemap
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
