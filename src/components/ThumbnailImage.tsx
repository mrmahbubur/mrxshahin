import { useState } from 'react';

interface ThumbnailImageProps {
  src: string;
  alt: string;
  title: string;
  siteName: string;
  className?: string;
  priority?: boolean;
}

export function ThumbnailImage({
  src,
  alt,
  title,
  siteName,
  className = '',
  priority = false,
}: ThumbnailImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div
        className={`relative aspect-video w-full overflow-hidden bg-zinc-900 text-white flex flex-col justify-end p-5 ${className}`}
        role="img"
        aria-label={alt}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-slate-900 to-blue-950 opacity-95" />
        <div className="relative z-10">
          <p className="text-[11px] font-medium uppercase tracking-widest text-blue-300 mb-1.5 truncate">
            {siteName}
          </p>
          <p className="font-display text-lg font-semibold leading-snug line-clamp-2 text-white">
            {title}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative aspect-video w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900 ${className}`}>
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        loading={priority ? 'eager' : 'lazy'}
        onError={() => setFailed(true)}
        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
      />
    </div>
  );
}
