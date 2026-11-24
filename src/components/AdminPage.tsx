import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Edit3,
  ExternalLink,
  Eye,
  Image as ImageIcon,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ActivityLog, AdminSite, AdminStats, FullPost, LogLevel } from '../types';
import { ThumbnailImage } from './ThumbnailImage';

interface AdminPageProps {
  token: string | null;
  onSetToken: (token: string | null) => void;
  onNavigate: (path: string) => void;
}

type AdminTab = 'posts' | 'sites' | 'logs';

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function AdminPage({ token, onSetToken, onNavigate }: AdminPageProps) {
  const [authMode, setAuthMode] = useState<'loading' | 'bootstrap' | 'env' | 'claimed'>('loading');
  const [passwordInput, setPasswordInput] = useState('');
  const [confirmInput, setConfirmInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [tab, setTab] = useState<AdminTab>('posts');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [sites, setSites] = useState<AdminSite[]>([]);
  const [posts, setPosts] = useState<FullPost[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loadingDash, setLoadingDash] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Filters
  const [postFilter, setPostFilter] = useState<'all' | 'published' | 'draft'>('all');
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | LogLevel>('all');

  // Add site form
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteUrl, setNewSiteUrl] = useState('');
  const [newSiteRss, setNewSiteRss] = useState('');
  const [newSiteSitemap, setNewSiteSitemap] = useState('');
  const [newSiteGithub, setNewSiteGithub] = useState('');

  // Post Editor Modal State
  const [editingPost, setEditingPost] = useState<FullPost | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSlug, setEditSlug] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editMeta, setEditMeta] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editStatus, setEditStatus] = useState<'published' | 'draft'>('published');
  const [editHtml, setEditHtml] = useState('');

  useEffect(() => {
    document.title = 'Admin Console – M R S Auto Blog';
    let meta = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
    const existed = Boolean(meta);
    const prevContent = meta?.content || '';
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'robots';
      document.head.appendChild(meta);
    }
    meta.content = 'noindex, nofollow';

    return () => {
      if (!existed && meta) {
        meta.remove();
      } else if (meta) {
        meta.content = prevContent;
      }
    };
  }, []);

  const checkAuthStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/auth/status', {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const data = (await res.json()) as { mode: 'env' | 'claimed' | 'bootstrap'; authenticated: boolean };
      setAuthMode(data.mode);
      if (token && !data.authenticated) {
        onSetToken(null);
      }
    } catch {
      setAuthMode('env');
    }
  }, [token, onSetToken]);

  useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  const loadDashboard = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!token) return;
      if (!options.silent) {
        setLoadingDash(true);
      }
      try {
        const res = await fetch('/api/admin/dashboard', {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
            Authorization: `Bearer ${token}`,
          },
        });
        if (res.status === 401) {
          onSetToken(null);
          return;
        }
        if (!res.ok) throw new Error('Failed to load admin dashboard');
        const data = (await res.json()) as {
          stats: AdminStats;
          sites: AdminSite[];
          posts: FullPost[];
          logs: ActivityLog[];
        };
        setStats(data.stats);
        setSites(data.sites);
        setPosts(data.posts);
        setLogs(data.logs);
      } catch (err) {
        if (!options.silent) {
          setActionErr(err instanceof Error ? err.message : 'Unable to load dashboard');
        }
      } finally {
        if (!options.silent) {
          setLoadingDash(false);
        }
      }
    },
    [token, onSetToken]
  );

  useEffect(() => {
    if (!token) return;
    void loadDashboard();

    let source: EventSource | null = null;
    if (typeof window !== 'undefined' && typeof EventSource !== 'undefined') {
      source = new EventSource('/api/posts/stream');
      const refreshSilent = () => {
        void loadDashboard({ silent: true });
      };
      source.addEventListener('post:published', refreshSilent);
      source.addEventListener('post:updated', refreshSilent);
      source.addEventListener('post:deleted', refreshSilent);
    }

    const pollTimer = setInterval(() => {
      void loadDashboard({ silent: true });
    }, 15000);

    return () => {
      source?.close();
      clearInterval(pollTimer);
    };
  }, [token, loadDashboard]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    if (authMode === 'bootstrap') {
      if (passwordInput.length < 8) {
        setAuthError('Choose a password with at least 8 characters.');
        return;
      }
      if (passwordInput !== confirmInput) {
        setAuthError('Passwords do not match.');
        return;
      }
    }

    setAuthSubmitting(true);
    try {
      const endpoint = authMode === 'bootstrap' ? '/api/admin/auth/bootstrap' : '/api/admin/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput }),
      });
      const data = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        throw new Error(data.error || 'Authentication failed');
      }
      setPasswordInput('');
      setConfirmInput('');
      onSetToken(data.token);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const runAdminAction = async (key: string, fn: () => Promise<void>) => {
    setBusyAction(key);
    setActionErr(null);
    setActionMsg(null);
    try {
      await fn();
      await loadDashboard();
    } catch (err) {
      setActionErr(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleCheckNow = () =>
    runAdminAction('check-now', async () => {
      const res = await fetch('/api/admin/check-now', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as {
        skipped?: boolean;
        sitesChecked?: number;
        postsCreated?: number;
        errors?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Monitoring run failed');
      if (data.skipped) {
        setActionMsg('A monitoring cycle is already running.');
      } else {
        setActionMsg(
          `Checked ${data.sitesChecked ?? 0} site(s): ${data.postsCreated ?? 0} post(s) generated, ${data.errors ?? 0} error(s).`
        );
      }
    });

  const handleSyncHub = () =>
    runAdminAction('sync-hub', async () => {
      const res = await fetch('/api/admin/sync-hub', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { discovered?: number; added?: number; error?: string };
      if (!res.ok) throw new Error(data.error || 'Hub sync failed');
      setActionMsg(`Hub sync complete: ${data.discovered ?? 0} found, ${data.added ?? 0} newly added.`);
    });

  const handleToggleDraftMode = () =>
    runAdminAction('draft-mode', async () => {
      const nextMode = !stats?.draftMode;
      const res = await fetch('/api/admin/settings/draft-mode', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ draftMode: nextMode }),
      });
      if (!res.ok) throw new Error('Failed to update draft mode');
      setActionMsg(`Switched to ${nextMode ? 'Draft mode (review before publishing)' : 'Auto-publish mode'}.`);
    });

  const handleAddSite = async (e: React.FormEvent) => {
    e.preventDefault();
    await runAdminAction('add-site', async () => {
      const res = await fetch('/api/admin/sites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: newSiteName,
          url: newSiteUrl,
          rssUrl: newSiteRss || undefined,
          sitemapUrl: newSiteSitemap || undefined,
          githubRepo: newSiteGithub || undefined,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to add site');
      setNewSiteName('');
      setNewSiteUrl('');
      setNewSiteRss('');
      setNewSiteSitemap('');
      setNewSiteGithub('');
      setActionMsg('Monitored site added.');
    });
  };

  const openEditor = (post: FullPost) => {
    setEditingPost(post);
    setEditTitle(post.title);
    setEditSlug(post.slug);
    setEditSummary(post.summary);
    setEditMeta(post.metaDescription);
    setEditTags(post.tags.join(', '));
    setEditStatus(post.status ?? 'published');
    setEditHtml(post.contentHtml);
  };

  const handleSavePostEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPost) return;
    await runAdminAction(`save-post-${editingPost.id}`, async () => {
      const res = await fetch(`/api/admin/posts/${editingPost.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: editTitle,
          slug: editSlug,
          summary: editSummary,
          metaDescription: editMeta,
          tags: editTags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          status: editStatus,
          contentHtml: editHtml,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to save post');
      setEditingPost(null);
      setActionMsg('Post changes saved.');
    });
  };

  // ---------------- Login / First-Run Bootstrap Gate ----------------

  if (!token) {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-7 space-y-6">
          <div className="space-y-2">
            <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200">
              <Lock className="h-4 w-4" />
            </div>
            <h1 className="font-display text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              {authMode === 'bootstrap' ? 'Set Admin Password' : 'Admin Console Sign In'}
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              {authMode === 'bootstrap'
                ? 'No ADMIN_PASSWORD environment variable is set yet. Create an initial admin password (min. 8 characters) to secure this console.'
                : 'Enter the admin password to manage monitored sites, generated posts, and activity logs.'}
            </p>
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="admin-password" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Password
              </label>
              <input
                id="admin-password"
                type="password"
                required
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                autoComplete={authMode === 'bootstrap' ? 'new-password' : 'current-password'}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3.5 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 focus:border-blue-600 focus:outline-none min-h-[42px]"
              />
            </div>

            {authMode === 'bootstrap' && (
              <div className="space-y-1.5">
                <label htmlFor="admin-password-confirm" className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  Confirm Password
                </label>
                <input
                  id="admin-password-confirm"
                  type="password"
                  required
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3.5 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 focus:border-blue-600 focus:outline-none min-h-[42px]"
                />
              </div>
            )}

            {authError && (
              <p className="text-xs font-medium text-red-600 dark:text-red-400" role="alert">
                {authError}
              </p>
            )}

            <button
              type="submit"
              disabled={authSubmitting || authMode === 'loading'}
              className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 transition-colors min-h-[42px]"
            >
              {authSubmitting
                ? 'Verifying...'
                : authMode === 'bootstrap'
                ? 'Save Password & Enter'
                : 'Sign In'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  const filteredPosts = posts.filter((p) => (postFilter === 'all' ? true : p.status === postFilter));
  const filteredLogs = logs.filter((l) => (logLevelFilter === 'all' ? true : l.level === logLevelFilter));

  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-10 space-y-8">
      {/* Top Action Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-zinc-200 dark:border-zinc-800 pb-6">
        <div>
          <h1 className="font-display text-3xl font-semibold text-zinc-900 dark:text-zinc-50">
            Admin Console
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Automated monitoring, Gemini post authoring, and publishing controls.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={handleCheckNow}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 dark:bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-800 dark:hover:bg-blue-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busyAction === 'check-now' ? 'animate-spin' : ''}`} />
            <span>{busyAction === 'check-now' ? 'Checking Sites...' : 'Check Now'}</span>
          </button>

          <button
            type="button"
            disabled={busyAction !== null}
            onClick={handleSyncHub}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] px-3.5 py-2 text-xs font-medium text-zinc-800 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Sync Hub</span>
          </button>

          <button
            type="button"
            disabled={busyAction !== null}
            onClick={handleToggleDraftMode}
            className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 min-h-[40px] ${
              stats?.draftMode
                ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300'
                : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] text-zinc-800 dark:text-zinc-200'
            }`}
          >
            <span>{stats?.draftMode ? 'Draft Mode: Review First' : 'Publishing: Auto-Publish'}</span>
          </button>

          <button
            type="button"
            onClick={() => onSetToken(null)}
            className="inline-flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 px-3.5 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 whitespace-nowrap shrink-0 min-h-[40px]"
          >
            Sign Out
          </button>
        </div>
      </div>

      {/* Feedback Banner */}
      {(actionMsg || actionErr) && (
        <div
          className={`rounded-lg border px-4 py-3 text-xs font-medium flex items-center justify-between gap-4 ${
            actionErr
              ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
              : 'border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
          }`}
        >
          <span>{actionErr || actionMsg}</span>
          <button
            type="button"
            onClick={() => {
              setActionErr(null);
              setActionMsg(null);
            }}
            className="underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* KPI Strip */}
      <section aria-label="System Overview" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-4 space-y-1">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Monitored Sites</p>
          <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 tabular-nums">
            {stats?.activeSites ?? 0} <span className="text-xs font-normal text-zinc-500">/ {stats?.totalSites ?? 0}</span>
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
            {stats?.errorSites ? `${stats.errorSites} with errors` : 'All sites reachable'}
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-4 space-y-1">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Published Posts</p>
          <p className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 tabular-nums">
            {stats?.publishedPosts ?? 0}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
            {stats?.draftPosts ?? 0} in drafts
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-4 space-y-1">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Last Check</p>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 font-mono truncate pt-1">
            {formatTimestamp(stats?.lastCheckAt ?? null)}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
            {stats?.lastRunStatus || 'Waiting for first run'}
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-4 space-y-1">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Storage Engine</p>
          <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 font-mono uppercase pt-0.5">
            {stats?.dbEngine ?? 'sqlite'}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Persistent posts &amp; thumbnails
          </p>
        </div>
      </section>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-zinc-200 dark:border-zinc-800">
        {([
          { id: 'posts', label: `Posts (${posts.length})` },
          { id: 'sites', label: `Monitored Sites (${sites.length})` },
          { id: 'logs', label: `Activity Log (${logs.length})` },
        ] as Array<{ id: AdminTab; label: string }>).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              tab === item.id
                ? 'border-blue-700 dark:border-blue-400 text-zinc-900 dark:text-zinc-50'
                : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Tab 1: Posts Manager */}
      {tab === 'posts' && (
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              {(['all', 'published', 'draft'] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setPostFilter(status)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                    postFilter === status
                      ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                      : 'border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400'
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void loadDashboard()}
              disabled={loadingDash}
              className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 inline-flex items-center gap-1"
            >
              <RefreshCw className={`h-3 w-3 ${loadingDash ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>

          {filteredPosts.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-10 text-center space-y-2">
              <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">No posts in this view.</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Click "Check Now" to scan monitored websites and generate dispatches automatically.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822]">
              {filteredPosts.map((post) => (
                <div key={post.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex items-start gap-4 min-w-0">
                    <div className="w-28 rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-800 shrink-0">
                      <ThumbnailImage
                        src={
                          post.updatedAt !== post.publishedAt
                            ? `${post.thumbnailUrl}?v=${encodeURIComponent(post.updatedAt)}`
                            : post.thumbnailUrl
                        }
                        alt={post.title}
                        title={post.title}
                        siteName={post.siteName}
                      />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <span
                          className={
                            post.status === 'published'
                              ? 'text-emerald-700 dark:text-emerald-400 font-medium'
                              : 'text-amber-700 dark:text-amber-400 font-medium'
                          }
                        >
                          {post.status === 'published' ? 'Published' : 'Draft'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{post.siteName}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{formatTimestamp(post.publishedAt)}</span>
                      </div>
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                        {post.title}
                      </h3>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-1">{post.summary}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {post.status === 'published' && (
                      <button
                        type="button"
                        onClick={() => onNavigate(`/post/${post.slug}`)}
                        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        <span>View</span>
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        runAdminAction(`toggle-pub-${post.id}`, async () => {
                          const nextStatus = post.status === 'published' ? 'draft' : 'published';
                          const res = await fetch(`/api/admin/posts/${post.id}`, {
                            method: 'PATCH',
                            headers: {
                              'Content-Type': 'application/json',
                              Authorization: `Bearer ${token}`,
                            },
                            body: JSON.stringify({ status: nextStatus }),
                          });
                          if (!res.ok) throw new Error('Failed to update status');
                        })
                      }
                      className="rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      {post.status === 'published' ? 'Unpublish' : 'Publish'}
                    </button>

                    <button
                      type="button"
                      onClick={() => openEditor(post)}
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      <span>Edit</span>
                    </button>

                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        runAdminAction(`regen-post-${post.id}`, async () => {
                          const res = await fetch(`/api/admin/posts/${post.id}/regenerate`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}` },
                          });
                          const data = (await res.json()) as { error?: string };
                          if (!res.ok) throw new Error(data.error || 'Regeneration failed');
                          setActionMsg(`Regenerated "${post.title}"`);
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Regenerate</span>
                    </button>

                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        runAdminAction(`regen-thumb-${post.id}`, async () => {
                          const res = await fetch(`/api/admin/posts/${post.id}/regenerate-thumbnail`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}` },
                          });
                          const data = (await res.json()) as { error?: string };
                          if (!res.ok) throw new Error(data.error || 'Thumbnail regeneration failed');
                          setActionMsg(`Regenerated thumbnail for "${post.title}"`);
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      <ImageIcon className="h-3.5 w-3.5" />
                      <span>Thumb</span>
                    </button>

                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() =>
                        runAdminAction(`del-post-${post.id}`, async () => {
                          const res = await fetch(`/api/admin/posts/${post.id}`, {
                            method: 'DELETE',
                            headers: { Authorization: `Bearer ${token}` },
                          });
                          if (!res.ok) throw new Error('Failed to delete post');
                          setActionMsg('Post deleted.');
                        })
                      }
                      aria-label={`Delete ${post.title}`}
                      className="inline-flex items-center justify-center rounded-md border border-red-200 dark:border-red-900/60 p-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Tab 2: Monitored Sites Manager */}
      {tab === 'sites' && (
        <section className="space-y-6">
          {/* Add Site Form */}
          <form
            onSubmit={handleAddSite}
            className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-5 space-y-4"
          >
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Add Monitored Site</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
              <input
                type="text"
                required
                placeholder="Site Name"
                value={newSiteName}
                onChange={(e) => setNewSiteName(e.target.value)}
                className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100"
              />
              <input
                type="url"
                required
                placeholder="https://example.com"
                value={newSiteUrl}
                onChange={(e) => setNewSiteUrl(e.target.value)}
                className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100"
              />
              <input
                type="url"
                placeholder="Optional RSS URL"
                value={newSiteRss}
                onChange={(e) => setNewSiteRss(e.target.value)}
                className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100"
              />
              <input
                type="url"
                placeholder="Optional Sitemap URL"
                value={newSiteSitemap}
                onChange={(e) => setNewSiteSitemap(e.target.value)}
                className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100"
              />
              <input
                type="text"
                placeholder="GitHub repo (owner/repo)"
                value={newSiteGithub}
                onChange={(e) => setNewSiteGithub(e.target.value)}
                className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-xs text-zinc-900 dark:text-zinc-100"
              />
            </div>
            <div>
              <button
                type="submit"
                disabled={busyAction !== null}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2 text-xs font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Site</span>
              </button>
            </div>
          </form>

          {/* Sites Table */}
          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822]">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Website</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Last Check</th>
                  <th className="px-4 py-3 font-medium text-right">Posts</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {sites.map((site) => (
                  <tr key={site.id} className="hover:bg-zinc-50/70 dark:hover:bg-zinc-800/30">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-zinc-900 dark:text-zinc-100">{site.name}</div>
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-zinc-500 hover:text-blue-600 font-mono"
                      >
                        <span>{site.url}</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      {site.githubRepo && (
                        <div className="text-[11px] text-zinc-500 font-mono">GitHub: {site.githubRepo}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 capitalize text-zinc-600 dark:text-zinc-400">{site.source}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        {site.lastStatus === 'ok' ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span className="text-emerald-700 dark:text-emerald-400">Nominal</span>
                          </>
                        ) : site.lastStatus === 'error' ? (
                          <>
                            <AlertCircle className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />
                            <span className="text-red-700 dark:text-red-400">Error</span>
                          </>
                        ) : (
                          <>
                            <Clock className="h-3.5 w-3.5 text-zinc-500" />
                            <span className="text-zinc-600 dark:text-zinc-400">Pending</span>
                          </>
                        )}
                      </span>
                      {site.lastError && (
                        <div className="text-[11px] text-red-600 dark:text-red-400 max-w-[220px] truncate" title={site.lastError}>
                          {site.lastError}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                      {formatTimestamp(site.lastCheckedAt)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
                      {site.postCount ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            runAdminAction(`check-site-${site.id}`, async () => {
                              const res = await fetch(`/api/admin/sites/${site.id}/check`, {
                                method: 'POST',
                                headers: {
                                  'Content-Type': 'application/json',
                                  Authorization: `Bearer ${token}`,
                                },
                                body: JSON.stringify({ forcePost: false }),
                              });
                              const data = (await res.json()) as { message?: string; error?: string };
                              if (!res.ok) throw new Error(data.error || 'Site check failed');
                              setActionMsg(`${site.name}: ${data.message}`);
                            })
                          }
                          className="rounded border border-zinc-200 dark:border-zinc-800 px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          Check
                        </button>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            runAdminAction(`force-post-${site.id}`, async () => {
                              const res = await fetch(`/api/admin/sites/${site.id}/check`, {
                                method: 'POST',
                                headers: {
                                  'Content-Type': 'application/json',
                                  Authorization: `Bearer ${token}`,
                                },
                                body: JSON.stringify({ forcePost: true }),
                              });
                              const data = (await res.json()) as { message?: string; error?: string };
                              if (!res.ok) throw new Error(data.error || 'Post generation failed');
                              setActionMsg(`${site.name}: ${data.message}`);
                            })
                          }
                          className="rounded border border-zinc-200 dark:border-zinc-800 px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          Write Post
                        </button>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            runAdminAction(`toggle-site-${site.id}`, async () => {
                              const res = await fetch(`/api/admin/sites/${site.id}`, {
                                method: 'PATCH',
                                headers: {
                                  'Content-Type': 'application/json',
                                  Authorization: `Bearer ${token}`,
                                },
                                body: JSON.stringify({ active: !site.active }),
                              });
                              if (!res.ok) throw new Error('Failed to toggle site');
                            })
                          }
                          className="rounded border border-zinc-200 dark:border-zinc-800 px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          {site.active ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          type="button"
                          disabled={busyAction !== null}
                          onClick={() =>
                            runAdminAction(`del-site-${site.id}`, async () => {
                              const res = await fetch(`/api/admin/sites/${site.id}`, {
                                method: 'DELETE',
                                headers: { Authorization: `Bearer ${token}` },
                              });
                              if (!res.ok) throw new Error('Failed to delete site');
                            })
                          }
                          aria-label={`Remove ${site.name}`}
                          className="rounded border border-red-200 dark:border-red-900/60 p-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Tab 3: Activity Log */}
      {tab === 'logs' && (
        <section className="space-y-4">
          <div className="flex items-center gap-1.5">
            {(['all', 'info', 'success', 'warn', 'error'] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => setLogLevelFilter(lvl)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                  logLevelFilter === lvl
                    ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                    : 'border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822]">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Time</th>
                  <th className="px-4 py-2.5 font-medium">Level</th>
                  <th className="px-4 py-2.5 font-medium">Site</th>
                  <th className="px-4 py-2.5 font-medium">Event</th>
                  <th className="px-4 py-2.5 font-medium">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="align-top">
                    <td className="px-4 py-2.5 font-mono tabular-nums text-zinc-500 whitespace-nowrap">
                      {formatTimestamp(log.createdAt)}
                    </td>
                    <td className="px-4 py-2.5 uppercase font-mono font-medium">
                      <span
                        className={
                          log.level === 'error'
                            ? 'text-red-600 dark:text-red-400'
                            : log.level === 'warn'
                            ? 'text-amber-600 dark:text-amber-400'
                            : log.level === 'success'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-zinc-600 dark:text-zinc-400'
                        }
                      >
                        {log.level}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
                      {log.siteName || 'System'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-zinc-500 whitespace-nowrap">{log.action}</td>
                    <td className="px-4 py-2.5 text-zinc-800 dark:text-zinc-200">
                      <div>{log.message}</div>
                      {log.details && (
                        <div className="mt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400 break-all">
                          {log.details}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Post Editor Modal */}
      {editingPost && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Edit Post"
        >
          <form
            onSubmit={handleSavePostEdit}
            className="w-full max-w-3xl rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-3">
              <h2 className="font-display text-xl font-semibold text-zinc-900 dark:text-zinc-50">
                Edit Dispatch
              </h2>
              <button
                type="button"
                onClick={() => setEditingPost(null)}
                className="text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Title</label>
                <input
                  type="text"
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-sm"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Slug</label>
                <input
                  type="text"
                  required
                  value={editSlug}
                  onChange={(e) => setEditSlug(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-sm font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Status</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value === 'draft' ? 'draft' : 'published')}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-sm"
                >
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Tags (comma separated)</label>
                <input
                  type="text"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Card Summary (2 sentences)</label>
              <textarea
                rows={2}
                value={editSummary}
                onChange={(e) => setEditSummary(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-sm"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">SEO Meta Description</label>
              <input
                type="text"
                value={editMeta}
                onChange={(e) => setEditMeta(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-sm"
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">HTML Content (sanitized on save)</label>
              <textarea
                rows={12}
                value={editHtml}
                onChange={(e) => setEditHtml(e.target.value)}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-[#FAF9F6] dark:bg-[#0B0E14] px-3 py-2 text-xs font-mono leading-relaxed"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setEditingPost(null)}
                className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 py-2 text-xs font-medium text-zinc-700 dark:text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busyAction !== null}
                className="rounded-lg bg-zinc-900 dark:bg-zinc-100 px-5 py-2 text-xs font-medium text-white dark:text-zinc-900"
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
