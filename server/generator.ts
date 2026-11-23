import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import * as cheerio from 'cheerio';
import {
  addLog,
  createPost,
  ensureUniqueSlug,
  getPostById,
  getSetting,
  getSiteById,
  updatePost,
} from './db.ts';
import { emitPublicPostPublished, emitPublicPostUpdated } from './events.ts';
import { sanitizePostHtml, slugify } from './security.ts';
import { generatePostThumbnail } from './thumbnails.ts';
import type { ChangeReport, PostRecord, PostStatus } from './types.ts';

interface GeneratedArticlePayload {
  title: string;
  slug: string;
  metaDescription: string;
  summary: string;
  tags: string[];
  contentHtml: string;
}

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function estimateReadingTime(html: string): number {
  const $ = cheerio.load(html);
  const text = $.text().trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 220));
}

function buildGenerationPrompt(report: ChangeReport): string {
  return `You are the senior technical editor for M R S Auto Blog.
Write an accurate, factual, engaging editorial blog post covering the following real website monitoring report.

CRITICAL FACTUALITY RULES:
1. ONLY use facts explicitly present in the MONITORING DATA below.
2. NEVER invent features, statistics, benchmarks, user counts, dates, version numbers, or quotes not present in the data.
3. If the available change data is concise or thin, write a focused, crisp post rather than padding with speculation.
4. When rich data is available, aim for 800 to 1,400 words in clean semantic HTML.

REQUIRED HTML STRUCTURE (inside contentHtml):
- Use clean semantic HTML tags only: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <blockquote>, <a href="...">, <strong>, <em>, <code>.
- Do NOT include an <h1> tag in contentHtml (the post page renders the H1 title separately).
- Include these clear sections as <h2> headings:
  1. Introduction (what changed or launched)
  2. What's New (concrete updates from the report)
  3. How It Works & Key Highlights (grounded in observed headings, navigation, pages, RSS items, or commits)
  4. Why It Matters (practical impact for visitors/users based strictly on observed capabilities)
  ${report.isInitial ? '' : '5. Before vs. After (concise comparison using only the beforeSummary and afterSummary provided)'}
  6. Visit the Site (include a clear link <a href="${report.siteUrl}">${report.siteName}</a>)
  7. Conclusion (brief wrap-up)

MONITORING DATA:
${JSON.stringify(
  {
    siteName: report.siteName,
    siteUrl: report.siteUrl,
    isInitialDiscovery: report.isInitial,
    changeReason: report.reason,
    currentTitle: report.currentTitle,
    currentMetaDescription: report.currentMetaDescription,
    newPages: report.newPages.slice(0, 20),
    removedPages: report.removedPages.slice(0, 15),
    newHeadings: report.newHeadings.slice(0, 25),
    removedHeadings: report.removedHeadings.slice(0, 15),
    newNavItems: report.newNavItems.slice(0, 20),
    newLinks: report.newLinks.slice(0, 20),
    newRssItems: report.newRssItems.slice(0, 10),
    newGithubCommits: report.newGithubCommits.slice(0, 10),
    newGithubReleases: report.newGithubReleases.slice(0, 5),
    beforeSummary: report.beforeSummary,
    afterSummary: report.afterSummary,
    textDiffSnippet: report.textDiffSnippet,
    currentHeadings: report.currentHeadings.slice(0, 30),
    currentMainTextExcerpt: report.currentMainTextExcerpt.slice(0, 6000),
  },
  null,
  2
)}

OUTPUT REQUIREMENTS:
- title: Compelling SEO headline (45-68 characters).
- slug: URL-safe lowercase kebab-case slug.
- metaDescription: Accurate SEO meta description (120-158 characters).
- summary: Exactly 2 crisp sentences summarizing the update for the post card.
- tags: 3 to 5 relevant lowercase tags.
- contentHtml: Complete sanitized-ready editorial HTML body.`;
}

async function callGeminiForArticle(report: ChangeReport): Promise<GeneratedArticlePayload> {
  const ai = getAiClient();
  const prompt = buildGenerationPrompt(report);
  const models = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  let lastErr: unknown;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const thinkingLevel = model === 'gemini-3.1-flash-lite' ? ThinkingLevel.MINIMAL : ThinkingLevel.LOW;
    try {
      response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          abortSignal: AbortSignal.timeout(25000),
          thinkingConfig: { thinkingLevel },
          systemInstruction:
            'You are an objective editorial technology journalist. Never fabricate metrics, features, or quotes. Output valid JSON matching the requested schema.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              slug: { type: Type.STRING },
              metaDescription: { type: Type.STRING },
              summary: { type: Type.STRING },
              tags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              contentHtml: { type: Type.STRING },
            },
            required: ['title', 'slug', 'metaDescription', 'summary', 'tags', 'contentHtml'],
          },
        },
      });
      break;
    } catch (err) {
      lastErr = err;
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      const errName = err instanceof Error ? err.name : '';
      const isTransient =
        errName === 'AbortError' ||
        errName === 'TimeoutError' ||
        msg.includes('503') ||
        msg.includes('429') ||
        msg.includes('unavailable') ||
        msg.includes('high demand') ||
        msg.includes('aborted') ||
        msg.includes('timeout');
      if (!isTransient || i === models.length - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }

  if (!response) {
    throw lastErr instanceof Error ? lastErr : new Error('Gemini generation failed');
  }

  const rawText = response.text?.trim();
  if (!rawText) {
    throw new Error('Gemini returned an empty response');
  }

  const parsed = JSON.parse(rawText) as Partial<GeneratedArticlePayload>;
  if (!parsed.title || !parsed.contentHtml) {
    throw new Error('Gemini JSON response missing required fields');
  }

  return {
    title: String(parsed.title).trim(),
    slug: slugify(parsed.slug || parsed.title),
    metaDescription: String(parsed.metaDescription || parsed.summary || parsed.title).trim().slice(0, 170),
    summary: String(parsed.summary || parsed.metaDescription || parsed.title).trim(),
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6)
      : [slugify(report.siteName)],
    contentHtml: sanitizePostHtml(String(parsed.contentHtml)),
  };
}

export async function generateAndSavePostFromReport(report: ChangeReport): Promise<PostRecord> {
  const site = await getSiteById(report.siteId);
  const draftMode = (await getSetting('draft_mode')) === 'true';
  const status: PostStatus = draftMode ? 'draft' : 'published';

  const article = await callGeminiForArticle(report);
  const uniqueSlug = await ensureUniqueSlug(article.slug);
  const readingTimeMinutes = estimateReadingTime(article.contentHtml);

  const thumbResult = await generatePostThumbnail({
    title: article.title,
    siteName: report.siteName,
    slug: uniqueSlug,
    themeColor: site?.themeColor,
    sourceImageUrl: report.heroImageUrl,
  });

  if (!thumbResult.usedAiImage && thumbResult.fallbackReason) {
    await addLog({
      level: 'info',
      siteId: report.siteId,
      siteName: report.siteName,
      action: 'thumbnail_fallback',
      message: `Generated editorial SVG/PNG thumbnail for "${article.title}"`,
      details: thumbResult.fallbackReason,
    });
  } else {
    await addLog({
      level: 'success',
      siteId: report.siteId,
      siteName: report.siteName,
      action: 'thumbnail_generated',
      message: `Generated Gemini 16:9 thumbnail for "${article.title}"`,
    });
  }

  const post = await createPost({
    siteId: report.siteId,
    siteName: report.siteName,
    siteUrl: report.siteUrl,
    title: article.title,
    slug: uniqueSlug,
    metaDescription: article.metaDescription,
    summary: article.summary,
    contentHtml: article.contentHtml,
    tags: article.tags,
    category: report.siteName,
    changeHash: report.changeHash,
    changeReport: report,
    status,
    readingTimeMinutes,
    thumbnailUrl: `/thumbnails/${uniqueSlug}.png`,
    thumbnailData: thumbResult.buffer,
  });

  await addLog({
    level: 'success',
    siteId: report.siteId,
    siteName: report.siteName,
    action: 'post_generated',
    message: `${status === 'draft' ? 'Drafted' : 'Published'} post "${post.title}"`,
    details: `Slug: ${post.slug} (${post.readingTimeMinutes} min read)`,
  });

  emitPublicPostPublished(post);
  return post;
}

export async function regeneratePostContent(postId: number): Promise<PostRecord> {
  const existing = await getPostById(postId);
  if (!existing) {
    throw new Error('Post not found');
  }

  const site = existing.siteId ? await getSiteById(existing.siteId) : null;

  const report: ChangeReport = existing.changeReport ?? {
    siteId: existing.siteId ?? 0,
    siteName: existing.siteName,
    siteUrl: existing.siteUrl,
    isInitial: true,
    meaningful: true,
    reason: 'Manual regeneration from saved post context',
    changeHash: existing.changeHash,
    newPages: [],
    removedPages: [],
    newHeadings: [],
    removedHeadings: [],
    newNavItems: [],
    newLinks: [],
    newRssItems: [],
    newGithubCommits: [],
    newGithubReleases: [],
    beforeSummary: '',
    afterSummary: existing.summary,
    textDiffSnippet: existing.summary,
    currentTitle: existing.title,
    currentMetaDescription: existing.metaDescription,
    currentHeadings: [],
    currentMainTextExcerpt: cheerio.load(existing.contentHtml).text().slice(0, 4000),
  };

  const article = await callGeminiForArticle(report);
  const readingTimeMinutes = estimateReadingTime(article.contentHtml);

  const thumbResult = await generatePostThumbnail({
    title: article.title,
    siteName: existing.siteName,
    slug: existing.slug,
    themeColor: site?.themeColor,
    sourceImageUrl: report.heroImageUrl,
  });

  const updated = await updatePost(postId, {
    title: article.title,
    metaDescription: article.metaDescription,
    summary: article.summary,
    tags: article.tags,
    contentHtml: article.contentHtml,
    readingTimeMinutes,
    thumbnailData: thumbResult.buffer,
  });

  if (!updated) throw new Error('Failed to update post');

  await addLog({
    level: 'success',
    siteId: existing.siteId,
    siteName: existing.siteName,
    action: 'post_regenerated',
    message: `Regenerated post "${updated.title}"`,
  });

  emitPublicPostUpdated(updated);
  return updated;
}

export async function regeneratePostThumbnailOnly(postId: number): Promise<PostRecord> {
  const existing = await getPostById(postId);
  if (!existing) {
    throw new Error('Post not found');
  }
  const site = existing.siteId ? await getSiteById(existing.siteId) : null;

  const thumbResult = await generatePostThumbnail({
    title: existing.title,
    siteName: existing.siteName,
    slug: existing.slug,
    themeColor: site?.themeColor,
    sourceImageUrl: existing.changeReport?.heroImageUrl,
  });

  const updated = await updatePost(postId, {
    thumbnailData: thumbResult.buffer,
  });
  if (!updated) throw new Error('Failed to update thumbnail');

  await addLog({
    level: thumbResult.usedAiImage ? 'success' : 'info',
    siteId: existing.siteId,
    siteName: existing.siteName,
    action: 'thumbnail_regenerated',
    message: `Regenerated thumbnail for "${updated.title}"`,
    details: thumbResult.fallbackReason,
  });

  emitPublicPostUpdated(updated);
  return updated;
}
