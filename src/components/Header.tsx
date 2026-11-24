import { Menu, Moon, Sun, X } from 'lucide-react';
import { useState } from 'react';

interface HeaderProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

export function Header({ currentPath, onNavigate, darkMode, onToggleDarkMode }: HeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>, path: string) => {
    if (path.startsWith('/rss.xml')) return;
    e.preventDefault();
    setMobileOpen(false);
    if (path.startsWith('/#')) {
      const targetId = path.slice(2);
      if (currentPath !== '/') {
        onNavigate('/');
        setTimeout(() => {
          document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
        }, 80);
      } else {
        document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
      }
      return;
    }
    onNavigate(path);
  };

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6]/95 dark:bg-[#0B0E14]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 sm:px-6 h-16">
        {/* Zone 1: Single-line Editorial Masthead */}
        <a
          href="/"
          onClick={(e) => handleLinkClick(e, '/')}
          className="flex items-baseline gap-3 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600"
        >
          <span className="font-display text-xl sm:text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            M R S Auto Blog
          </span>
          <span className="hidden lg:inline text-xs text-zinc-500 dark:text-zinc-400 font-normal">
            Real-Time Innovation Dispatches
          </span>
        </a>

        {/* Zone 2: Clean Blogger Navigation */}
        <nav aria-label="Main navigation" className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-600 dark:text-zinc-400">
          <a
            href="/"
            onClick={(e) => handleLinkClick(e, '/')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100 ${
              currentPath === '/'
                ? 'text-zinc-900 dark:text-zinc-100 underline underline-offset-8 decoration-blue-700 dark:decoration-blue-400 decoration-2'
                : ''
            }`}
          >
            Home
          </a>
          <a
            href="/#labels"
            onClick={(e) => handleLinkClick(e, '/#labels')}
            className={`whitespace-nowrap shrink-0 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100 ${
              currentPath.startsWith('/category/')
                ? 'text-zinc-900 dark:text-zinc-100 underline underline-offset-8 decoration-blue-700 dark:decoration-blue-400 decoration-2'
                : ''
            }`}
          >
            Labels
          </a>
          <a
            href="/#archive"
            onClick={(e) => handleLinkClick(e, '/#archive')}
            className="whitespace-nowrap shrink-0 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            Archive
          </a>
          <a
            href="/rss.xml"
            target="_blank"
            rel="noopener noreferrer"
            className="whitespace-nowrap shrink-0 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            RSS Feed
          </a>
        </nav>

        {/* Zone 3: Theme Switch + Mobile Menu */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onToggleDarkMode}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] px-3.5 py-2 text-xs font-medium text-zinc-800 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/70 transition-colors whitespace-nowrap shrink-0 min-h-[40px] focus-visible:outline-2 focus-visible:outline-blue-600"
          >
            {darkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            <span>{darkMode ? 'Light' : 'Dark'}</span>
          </button>

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Toggle navigation menu"
            className="md:hidden inline-flex items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 p-2 text-zinc-700 dark:text-zinc-300 min-h-[40px] min-w-[40px]"
          >
            {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav aria-label="Mobile navigation" className="md:hidden border-t border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-4 py-3 flex flex-col gap-1">
          <a
            href="/"
            onClick={(e) => handleLinkClick(e, '/')}
            className="px-3 py-2.5 text-sm font-medium text-zinc-800 dark:text-zinc-200 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
          >
            Home
          </a>
          <a
            href="/#labels"
            onClick={(e) => handleLinkClick(e, '/#labels')}
            className="px-3 py-2.5 text-sm font-medium text-zinc-800 dark:text-zinc-200 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
          >
            Labels
          </a>
          <a
            href="/#archive"
            onClick={(e) => handleLinkClick(e, '/#archive')}
            className="px-3 py-2.5 text-sm font-medium text-zinc-800 dark:text-zinc-200 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
          >
            Archive
          </a>
          <a
            href="/rss.xml"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-2.5 text-sm font-medium text-zinc-800 dark:text-zinc-200 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
          >
            RSS Feed
          </a>
        </nav>
      )}
    </header>
  );
}
