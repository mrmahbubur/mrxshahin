import { useCallback, useEffect, useState } from 'react';
import { AdminPage } from './components/AdminPage';
import { Header } from './components/Header';
import { HomePage } from './components/HomePage';
import { PostPage } from './components/PostPage';

export default function App() {
  const [path, setPath] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );
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
      setPath(window.location.pathname || '/');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    if (nextPath !== window.location.pathname) {
      window.history.pushState({}, '', nextPath);
    }
    setPath(nextPath);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const postMatch = path.match(/^\/post\/([a-z0-9-]+)\/?$/i);
  const isAdmin = path === '/admin' || path.startsWith('/admin/');

  return (
    <div className="min-h-screen flex flex-col bg-[#FAF9F6] dark:bg-[#0B0E14] text-zinc-900 dark:text-zinc-100 transition-colors">
      <Header
        currentPath={path}
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
          <HomePage onNavigate={navigate} />
        )}
      </div>

      <footer className="border-t border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14]">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-zinc-500 dark:text-zinc-400">
          <p>© {new Date().getFullYear()} M R S Auto Blog. Automated website updates &amp; editorial dispatches.</p>
          <div className="flex items-center gap-5">
            <a href="/rss.xml" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-900 dark:hover:text-zinc-100">
              RSS
            </a>
            <a href="/sitemap.xml" target="_blank" rel="noopener noreferrer" className="hover:text-zinc-900 dark:hover:text-zinc-100">
              Sitemap
            </a>
            <a
              href="/admin"
              onClick={(e) => {
                e.preventDefault();
                navigate('/admin');
              }}
              className="hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              Admin
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
