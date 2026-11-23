import { EventEmitter } from 'node:events';
import type { PostRecord, PublicPostSummary } from './types.ts';

export type PublicPostPayload = Omit<PublicPostSummary, 'siteId' | 'status'>;

export type PublicPostStreamEvent =
  | { type: 'post:published'; post: PublicPostPayload }
  | { type: 'post:updated'; post: PublicPostPayload }
  | { type: 'post:deleted'; id: number; slug?: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const PUBLIC_POST_EVENT = 'public_post_event';

export function toPublicPostSummary(post: PostRecord): PublicPostPayload {
  return {
    id: post.id,
    siteName: post.siteName,
    siteUrl: post.siteUrl,
    title: post.title,
    slug: post.slug,
    metaDescription: post.metaDescription,
    summary: post.summary,
    tags: post.tags,
    category: post.category,
    readingTimeMinutes: post.readingTimeMinutes,
    thumbnailUrl: post.thumbnailUrl,
    publishedAt: post.publishedAt,
    updatedAt: post.updatedAt,
  };
}

export function subscribePublicPostEvents(
  listener: (event: PublicPostStreamEvent) => void
): () => void {
  emitter.on(PUBLIC_POST_EVENT, listener);
  return () => {
    emitter.off(PUBLIC_POST_EVENT, listener);
  };
}

export function emitPublicPostPublished(post: PostRecord): void {
  if (post.status !== 'published') return;
  emitter.emit(PUBLIC_POST_EVENT, {
    type: 'post:published',
    post: toPublicPostSummary(post),
  } satisfies PublicPostStreamEvent);
}

export function emitPublicPostUpdated(post: PostRecord): void {
  if (post.status === 'published') {
    emitter.emit(PUBLIC_POST_EVENT, {
      type: 'post:updated',
      post: toPublicPostSummary(post),
    } satisfies PublicPostStreamEvent);
  } else {
    emitter.emit(PUBLIC_POST_EVENT, {
      type: 'post:deleted',
      id: post.id,
      slug: post.slug,
    } satisfies PublicPostStreamEvent);
  }
}

export function emitPublicPostDeleted(id: number, slug?: string): void {
  emitter.emit(PUBLIC_POST_EVENT, {
    type: 'post:deleted',
    id,
    slug,
  } satisfies PublicPostStreamEvent);
}
