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
import { getGeminiApiKey } from './env.ts';
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
  const apiKey = getGeminiApiKey();
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

function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isTransientAiError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const errName = err instanceof Error ? err.name : '';
  return (
    errName === 'AbortError' ||
    errName === 'TimeoutError' ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('429') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('aborted') ||
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed') ||
    msg.includes('not configured')
  );
}

function truncateAtWordBoundary(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(' ');
  const candidate = lastSpace > Math.floor(maxLen * 0.55) ? sliced.slice(0, lastSpace) : sliced;
  return candidate.replace(/[,:;\-–—&\s]+$/, '').trim();
}

function formatShortDateText(rawDate: string): string {
  if (!rawDate) return '';
  const parsed = new Date(rawDate);
  if (Number.isNaN(parsed.getTime())) return rawDate;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildGroundedFallbackArticle(report: ChangeReport): GeneratedArticlePayload {
  const siteNameEsc = escapeHtmlText(report.siteName);
  const siteUrlEsc = escapeHtmlText(report.siteUrl);
  const pageTitle = report.currentTitle.trim() || report.siteName;
  const rawMetaDesc = report.currentMetaDescription.trim();
  const safeMetaDesc = /free apk hosting service for upload and download apps/i.test(rawMetaDesc)
    ? ''
    : rawMetaDesc;
  const pageDesc =
    safeMetaDesc ||
    report.textDiffSnippet.trim() ||
    report.currentMainTextExcerpt.split(/[.!?]+/).slice(0, 2).join('. ').trim() ||
    `${report.siteName} live web monitoring baseline and capability index.`;

  const uiNoiseHeadings = new Set([
    pageTitle.toLowerCase(),
    report.siteName.toLowerCase(),
    'search this blog',
    'pages',
    'posts',
    'pinned post',
    'menu',
    'home',
    'navigation',
  ]);
  const filteredHeadings = report.currentHeadings
    .map((h) => h.text.trim())
    .filter((t) => t.length >= 4 && !uiNoiseHeadings.has(t.toLowerCase()));
  const meaningfulHeading = filteredHeadings[0] || report.newRssItems[0]?.title?.trim() || '';

  const combinedHeadline = report.isInitial
    ? pageTitle.length < 18 && meaningfulHeading
      ? `${report.siteName}: ${meaningfulHeading}`
      : pageTitle.toLowerCase().startsWith(report.siteName.toLowerCase())
        ? pageTitle
        : report.siteName.length > 28 && pageTitle.length >= 24
          ? `${pageTitle} · ${report.siteName}`
          : `${report.siteName}: ${pageTitle}`
    : `${report.siteName} Update: ${report.reason}`;
  const rawTitle = truncateAtWordBoundary(combinedHeadline, 96);
  const title = rawTitle.length >= 16 ? rawTitle : `${report.siteName}: ${pageTitle}`;

  const slug = slugify(`${report.siteName}-${report.isInitial ? 'innovations' : 'update'}`);
  const summarySentences = [
    report.isInitial
      ? `${report.siteName} is live at ${report.siteUrl} featuring “${pageTitle}”.`
      : `Real-time monitoring captured a live update on ${report.siteName}: ${report.reason}.`,
    pageDesc.length > 20
      ? truncateAtWordBoundary(pageDesc, 175).replace(/[.!?\s]+$/, '') + '.'
      : `Explore the verified capabilities, active links, and technical updates observed on ${report.siteName}.`,
  ];
  const summary = summarySentences.join(' ').slice(0, 280);
  const metaDescription = truncateAtWordBoundary(`${report.siteName} — ${pageDesc}`, 158);

  // Extract distinct observed innovation statements & facts from live text
  const rawInnovationSource = /free apk hosting service for upload and download apps/i.test(report.currentMetaDescription)
    ? report.currentMainTextExcerpt
    : `${report.currentMetaDescription}. ${report.currentMainTextExcerpt}`;
  const innovationSentences = Array.from(
    new Set(
      rawInnovationSource
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(
          (s) =>
            s.length >= 28 &&
            s.length <= 320 &&
            !/^(English|Sign In|Free APK hosting service|Offers integration solutions)/i.test(s)
        )
    )
  ).slice(0, 8);

  const innovationListHtml =
    innovationSentences.length > 0
      ? `<ul>\n${innovationSentences.map((s) => `      <li>${escapeHtmlText(s)}</li>`).join('\n')}\n    </ul>`
      : `<p>${escapeHtmlText(pageDesc)}</p>`;

  // RSS Feed & Published Guides Section (real links, dates, summaries)
  let rssSectionHtml = '';
  if (report.newRssItems.length > 0) {
    const items = report.newRssItems
      .slice(0, 10)
      .map((item) => {
        const titleHtml = item.link
          ? `<a href="${escapeHtmlText(item.link)}"><strong>${escapeHtmlText(item.title)}</strong></a>`
          : `<strong>${escapeHtmlText(item.title)}</strong>`;
        const dateStr = formatShortDateText(item.pubDate);
        const dateHtml = dateStr ? ` <em>(${escapeHtmlText(dateStr)})</em>` : '';
        const sumHtml = item.summary ? ` — ${escapeHtmlText(truncateAtWordBoundary(item.summary, 220))}` : '';
        return `<li>${titleHtml}${dateHtml}${sumHtml}</li>`;
      })
      .join('\n      ');
    rssSectionHtml = `
    <h3>Published Dispatches &amp; Feed Releases</h3>
    <p>Live syndication checks discovered ${report.newRssItems.length} active feed ${report.newRssItems.length === 1 ? 'entry' : 'entries'} from ${siteNameEsc}:</p>
    <ul>
      ${items}
    </ul>`;
  }

  // GitHub Commits & Releases Section (real commits, SHAs, authors, releases)
  let githubSectionHtml = '';
  if (report.newGithubReleases.length > 0 || report.newGithubCommits.length > 0) {
    const relItems = report.newGithubReleases
      .slice(0, 5)
      .map((rel) => {
        const tagLink = rel.url
          ? `<a href="${escapeHtmlText(rel.url)}"><strong>${escapeHtmlText(rel.tagName)}</strong></a>`
          : `<strong>${escapeHtmlText(rel.tagName)}</strong>`;
        const bodyTxt = rel.body ? ` — ${escapeHtmlText(truncateAtWordBoundary(rel.body, 200))}` : '';
        return `<li>Release ${tagLink}: ${escapeHtmlText(rel.name)}${bodyTxt}</li>`;
      })
      .join('\n      ');

    const commitItems = report.newGithubCommits
      .slice(0, 8)
      .map((c) => {
        const shaLink = c.url
          ? `<a href="${escapeHtmlText(c.url)}"><code>${escapeHtmlText(c.sha)}</code></a>`
          : `<code>${escapeHtmlText(c.sha)}</code>`;
        const dateStr = formatShortDateText(c.date);
        return `<li>${shaLink} — ${escapeHtmlText(c.message)} <em>(${escapeHtmlText(c.author)}${dateStr ? `, ${escapeHtmlText(dateStr)}` : ''})</em></li>`;
      })
      .join('\n      ');

    githubSectionHtml = `
    <h3>Engineering Activity &amp; Source Updates</h3>
    <ul>
      ${relItems}
      ${commitItems}
    </ul>`;
  }

  // Structural Headings & Indexed Pages
  let structureSectionHtml = '';
  if (filteredHeadings.length > 0 || report.newPages.length > 0 || report.newNavItems.length > 0) {
    const navLine =
      report.newNavItems.length > 0
        ? `<p><strong>Observed Navigation Structure:</strong> ${report.newNavItems
            .slice(0, 12)
            .map((n) => escapeHtmlText(n))
            .join(' · ')}.</p>`
        : '';
    const headingItems = filteredHeadings
      .slice(0, 10)
      .map((h) => `<li>${escapeHtmlText(h)}</li>`)
      .join('\n      ');
    const pageItems = report.newPages
      .slice(0, 8)
      .map((u) => `<li><a href="${escapeHtmlText(u)}"><code>${escapeHtmlText(u)}</code></a></li>`)
      .join('\n      ');
    structureSectionHtml = `
    ${navLine}
    ${headingItems ? `<h3>Key Sections &amp; Headlines Indexed</h3><ul>\n      ${headingItems}\n    </ul>` : ''}
    ${pageItems ? `<h3>Indexed Pages in Sitemap</h3><ul>\n      ${pageItems}\n    </ul>` : ''}`;
  }

  // Linked Destinations discovered on the page
  const externalLinks = report.newLinks
    .filter((l) => l.text && l.text.length >= 3 && !l.href.includes('upload-apk.com/login') && !l.href.includes('upload-apk.com/register'))
    .slice(0, 8);
  const linkedResourcesHtml =
    externalLinks.length > 0
      ? `<h3>Featured Links &amp; Ecosystem Connections</h3>
    <ul>
      ${externalLinks
        .map((l) => `<li><a href="${escapeHtmlText(l.href)}">${escapeHtmlText(l.text)}</a></li>`)
        .join('\n      ')}
    </ul>`
      : '';

  const excerptClean = truncateAtWordBoundary(report.currentMainTextExcerpt, 480);
  const excerptHtml =
    excerptClean && excerptClean.length >= 60
      ? `<blockquote><p>${escapeHtmlText(excerptClean)}${report.currentMainTextExcerpt.length > 480 ? '…' : ''}</p></blockquote>`
      : '';

  const beforeAfterHtml = report.isInitial
    ? ''
    : `
    <h2>Before vs. After</h2>
    <ul>
      <li><strong>Previous Baseline:</strong> ${escapeHtmlText(report.beforeSummary || 'Prior snapshot index')}</li>
      <li><strong>Latest Observed State:</strong> ${escapeHtmlText(report.afterSummary || pageTitle)}</li>
      ${report.textDiffSnippet ? `<li><strong>Changed Copy Highlight:</strong> ${escapeHtmlText(truncateAtWordBoundary(report.textDiffSnippet, 320))}</li>` : ''}
    </ul>`;

  const rawHtml = `
    <h2>Introduction</h2>
    <p>${
      report.isInitial
        ? `Real-time inspection of <strong>${siteNameEsc}</strong> (<a href="${siteUrlEsc}">${siteUrlEsc}</a>) indexed its live destination under the title <strong>${escapeHtmlText(pageTitle)}</strong>. Below is a verified breakdown of every innovation, technical feature, feed release, and structural highlight observed directly from the live site.`
        : `Continuous real-time monitoring detected an active update on <strong>${siteNameEsc}</strong> (<a href="${siteUrlEsc}">${siteUrlEsc}</a>): <strong>${escapeHtmlText(report.reason)}</strong>.`
    }</p>

    <h2>Core Innovations &amp; Real Capabilities</h2>
    ${innovationListHtml}
    ${excerptHtml}

    <h2>What's New &amp; Live Activity</h2>
    ${rssSectionHtml || githubSectionHtml ? `${rssSectionHtml}${githubSectionHtml}` : `<p>Live verification recorded active metadata for <strong>${escapeHtmlText(pageTitle)}</strong>: ${escapeHtmlText(pageDesc)}</p>`}

    <h2>How It Works &amp; Platform Structure</h2>
    ${structureSectionHtml || `<p>${escapeHtmlText(pageDesc)}</p>`}
    ${linkedResourcesHtml}

    <h2>Why It Matters</h2>
    <p>Every detail documented here reflects live production output from ${siteNameEsc} rather than static assumptions. Tracking structural metadata, RSS syndication, sitemap additions, and source repository activity in real time keeps readers informed the moment new tools, guides, or platform improvements launch.</p>

    ${beforeAfterHtml}

    <h2>Visit the Site</h2>
    <p>Explore the live platform and its latest innovations directly at <a href="${siteUrlEsc}">${siteNameEsc}</a>.</p>

    <h2>Conclusion</h2>
    <p>M R S Auto Blog continues monitoring ${siteNameEsc} automatically so every verified innovation, release, and content update is published to the live feed in real time.</p>
  `;

  const tags = Array.from(
    new Set(
      [
        slugify(report.siteName),
        report.isInitial ? 'innovations' : 'live-update',
        report.newGithubReleases.length > 0 || report.newGithubCommits.length > 0 ? 'github' : '',
        report.newRssItems.length > 0 ? 'articles' : '',
        'web-monitoring',
      ].filter(Boolean)
    )
  ).slice(0, 5);

  return {
    title,
    slug,
    metaDescription,
    summary,
    tags,
    contentHtml: sanitizePostHtml(rawHtml),
  };
}

let textModelCooldownUntil = 0;

async function callGeminiForArticle(
  report: ChangeReport
): Promise<{ article: GeneratedArticlePayload; usedAiAuthoring: boolean; fallbackReason?: string }> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return {
      article: buildGroundedFallbackArticle(report),
      usedAiAuthoring: false,
      fallbackReason: 'GEMINI_API_KEY not configured',
    };
  }

  if (Date.now() < textModelCooldownUntil) {
    return {
      article: buildGroundedFallbackArticle(report),
      usedAiAuthoring: false,
      fallbackReason: 'Gemini text model in automatic quota cooldown; grounded authoring active',
    };
  }

  const ai = getAiClient();
  const prompt = buildGenerationPrompt(report);
  const models = [
    'gemini-4-hydrogen',
    'gemini-3.1-flash-lite',
  ];
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
          abortSignal: AbortSignal.timeout(12000),
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
      if (!isTransientAiError(err)) {
        throw err;
      }
      if (i < models.length - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  if (!response) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr || 'Gemini unavailable');
    const lowerReason = reason.toLowerCase();
    if (
      lowerReason.includes('429') ||
      lowerReason.includes('quota') ||
      lowerReason.includes('resource_exhausted') ||
      lowerReason.includes('aborted') ||
      lowerReason.includes('timeout')
    ) {
      textModelCooldownUntil = Date.now() + 10 * 60 * 1000;
    }
    return {
      article: buildGroundedFallbackArticle(report),
      usedAiAuthoring: false,
      fallbackReason: reason,
    };
  }

  const rawText = response.text?.trim();
  if (!rawText) {
    return {
      article: buildGroundedFallbackArticle(report),
      usedAiAuthoring: false,
      fallbackReason: 'Gemini returned an empty response',
    };
  }

  let parsed: Partial<GeneratedArticlePayload>;
  try {
    parsed = JSON.parse(rawText) as Partial<GeneratedArticlePayload>;
  } catch {
    return {
      article: buildGroundedFallbackArticle(report),
      usedAiAuthoring: false,
      fallbackReason: 'Gemini returned invalid JSON payload',
    };
  }

  if (!parsed.title || !parsed.contentHtml) {
    return {
      article: buildGroundedFallbackArticle(report),
      usedAiAuthoring: false,
      fallbackReason: 'Gemini JSON response missing required fields',
    };
  }

  return {
    usedAiAuthoring: true,
    article: {
      title: String(parsed.title).trim(),
      slug: slugify(parsed.slug || parsed.title),
      metaDescription: String(parsed.metaDescription || parsed.summary || parsed.title).trim().slice(0, 170),
      summary: String(parsed.summary || parsed.metaDescription || parsed.title).trim(),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 6)
        : [slugify(report.siteName)],
      contentHtml: sanitizePostHtml(String(parsed.contentHtml)),
    },
  };
}

export async function generateAndSavePostFromReport(report: ChangeReport): Promise<PostRecord> {
  const site = await getSiteById(report.siteId);
  const draftMode = (await getSetting('draft_mode')) === 'true';
  const status: PostStatus = draftMode ? 'draft' : 'published';

  const { article, usedAiAuthoring, fallbackReason: authoringFallback } = await callGeminiForArticle(report);
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
    level: usedAiAuthoring ? 'success' : 'info',
    siteId: report.siteId,
    siteName: report.siteName,
    action: usedAiAuthoring ? 'post_generated' : 'post_generated_fallback',
    message: `${status === 'draft' ? 'Drafted' : 'Published'} post "${post.title}"${usedAiAuthoring ? '' : ' (grounded editorial fallback)'}`,
    details: authoringFallback
      ? `Slug: ${post.slug} (${post.readingTimeMinutes} min read) | AI fallback: ${authoringFallback}`
      : `Slug: ${post.slug} (${post.readingTimeMinutes} min read)`,
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

  const { article, usedAiAuthoring, fallbackReason: authoringFallback } = await callGeminiForArticle(report);
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
    level: usedAiAuthoring ? 'success' : 'info',
    siteId: existing.siteId,
    siteName: existing.siteName,
    action: 'post_regenerated',
    message: `Regenerated post "${updated.title}"${usedAiAuthoring ? '' : ' (grounded editorial fallback)'}`,
    details: authoringFallback,
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
