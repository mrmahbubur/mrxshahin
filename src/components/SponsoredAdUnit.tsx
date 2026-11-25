import { ArrowUpRight } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { isStaticMode, withBase } from '../lib/paths';
import type { PublicAd } from '../types';

interface SponsoredAdUnitProps {
  ad: PublicAd;
  variant?: 'inline' | 'sidebar';
}

function getSafeAffiliateUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return trimmed;
  }
  return null;
}

export function SponsoredAdUnit({ ad, variant }: SponsoredAdUnitProps) {
  const mode = variant || ad.slot;
  const containerRef = useRef<HTMLElement | null>(null);
  const trackedImpressionRef = useRef(false);
  const safeHref = getSafeAffiliateUrl(ad.targetUrl);

  useEffect(() => {
    trackedImpressionRef.current = false;
  }, [ad.id]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !safeHref || trackedImpressionRef.current) return;

    const recordImpression = () => {
      if (trackedImpressionRef.current) return;
      trackedImpressionRef.current = true;
      if (isStaticMode()) return;
      fetch(withBase(`/api/ads/${ad.id}/impression`), {
        method: 'POST',
        keepalive: true,
      }).catch(() => {
        // ignore network hiccups on passive impression beacon
      });
    };

    if (typeof IntersectionObserver === 'undefined') {
      recordImpression();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          recordImpression();
          observer.disconnect();
        }
      },
      { threshold: 0.25 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [ad.id, safeHref]);

  if (!safeHref) return null;

  const handleTrackClick = () => {
    if (isStaticMode()) return;
    const url = withBase(`/api/ads/${ad.id}/click`);
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const sent = navigator.sendBeacon(url);
      if (sent) return;
    }
    fetch(url, { method: 'POST', keepalive: true }).catch(() => {
      // ignore non-blocking click tracking errors
    });
  };

  if (mode === 'sidebar') {
    return (
      <aside
        ref={containerRef}
        aria-label={`Sponsored recommendation: ${ad.advertiserName}`}
        className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-5 space-y-3.5"
      >
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
            Sponsored
          </span>
          <span className="font-mono text-zinc-500 dark:text-zinc-400 truncate">
            {ad.displayDomain}
          </span>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-blue-700 dark:text-blue-400">
            {ad.advertiserName} · {ad.categoryLabel}
          </p>
          <h3 className="font-display text-lg font-semibold leading-snug text-zinc-900 dark:text-zinc-50 [text-wrap:balance]">
            <a
              href={safeHref}
              target="_blank"
              rel="noopener noreferrer sponsored"
              onClick={handleTrackClick}
              className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
            >
              {ad.headline}
            </a>
          </h3>
          <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
            {ad.description}
          </p>
        </div>

        <div className="pt-1">
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer sponsored"
            onClick={handleTrackClick}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-[#FAF9F6] dark:bg-[#0B0E14] px-4 py-2 text-xs font-medium text-zinc-900 dark:text-zinc-100 hover:border-blue-700 dark:hover:border-blue-400 hover:text-blue-700 dark:hover:text-blue-400 transition-colors whitespace-nowrap shrink-0 min-h-[38px]"
          >
            <span>{ad.ctaLabel}</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
          </a>
        </div>
      </aside>
    );
  }

  return (
    <aside
      ref={containerRef}
      aria-label={`Sponsored partner: ${ad.advertiserName}`}
      className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#131822] p-5 sm:p-6 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
            Sponsored
          </span>
          <span aria-hidden="true" className="text-zinc-400">·</span>
          <span className="font-semibold text-blue-700 dark:text-blue-400">
            {ad.advertiserName}
          </span>
          <span aria-hidden="true" className="text-zinc-400">·</span>
          <span className="text-zinc-500 dark:text-zinc-400">{ad.categoryLabel}</span>
        </div>
        <span className="font-mono text-zinc-500 dark:text-zinc-400">
          {ad.displayDomain}
        </span>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 sm:gap-6">
        <div className="space-y-1.5 max-w-2xl">
          <h3 className="font-display text-xl font-semibold leading-snug text-zinc-900 dark:text-zinc-50 [text-wrap:balance]">
            <a
              href={safeHref}
              target="_blank"
              rel="noopener noreferrer sponsored"
              onClick={handleTrackClick}
              className="hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
            >
              {ad.headline}
            </a>
          </h3>
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
            {ad.description}
          </p>
        </div>

        <a
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer sponsored"
          onClick={handleTrackClick}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2 text-xs font-medium text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors whitespace-nowrap shrink-0 self-start sm:self-center min-h-[40px]"
        >
          <span>{ad.ctaLabel}</span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
        </a>
      </div>
    </aside>
  );
}
