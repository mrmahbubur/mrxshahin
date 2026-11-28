import * as cheerio from 'cheerio';

const TRAILING_CONNECTOR_SYMBOL_RE = /[,:;|/·+\-–—&$£€#…\s]+$/;

const TRAILING_MULTIWORD_CONNECTOR_RE =
  /\s+(?:such\s+as|as\s+well\s+as|along\s+with|instead\s+of|due\s+to|according\s+to|up\s+to|out\s+of|part\s+of|based\s+on|powered\s+by|built\s+for|built\s+with|designed\s+for|tailored\s+for)$/i;

const TRAILING_DANGLING_WORD_RE =
  /\s+(?:and|or|but|nor|yet|so|at|for|with|of|to|in|on|by|from|into|onto|upon|as|via|about|over|under|through|across|between|among|during|without|within|after|before|until|toward|towards|against|around|per|like|such|including|featuring|using|offering|providing|several|various|other|is|are|was|were|be|has|have|can|will|that|which|who|whose|the|a|an|its|their|your|our|this|these|those)$/i;

export function normalizeSpaces(input: string): string {
  return input
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function countWords(text: string): number {
  const clean = normalizeSpaces(text);
  return clean ? clean.split(/\s+/).length : 0;
}

export function hasTrailingConnectorOrPreposition(text: string): boolean {
  const normalized = normalizeSpaces(text);
  if (!normalized) return false;
  if (/[$£€#…]$|\.{3}$/.test(normalized)) return true;

  const withoutSentenceEnd = normalized.replace(/[.!?]+$/, '').trim();
  if (!withoutSentenceEnd) return false;

  return (
    TRAILING_CONNECTOR_SYMBOL_RE.test(withoutSentenceEnd) ||
    TRAILING_MULTIWORD_CONNECTOR_RE.test(withoutSentenceEnd) ||
    TRAILING_DANGLING_WORD_RE.test(withoutSentenceEnd)
  );
}

export function truncateAtWordBoundary(text: string, maxLen: number): string {
  const clean = normalizeSpaces(text);
  if (!clean) return '';

  const wasTruncated = clean.length > maxLen;
  let candidate = clean;

  if (wasTruncated) {
    const sliced = clean.slice(0, maxLen);
    const lastSpace = sliced.lastIndexOf(' ');
    candidate = lastSpace > Math.floor(maxLen * 0.45) ? sliced.slice(0, lastSpace) : sliced;
  }

  candidate = candidate.replace(TRAILING_CONNECTOR_SYMBOL_RE, '').trim();

  const minSafeLen = wasTruncated ? Math.floor(maxLen * 0.4) : Math.min(12, candidate.length);
  for (let i = 0; i < 5; i++) {
    const stripped = candidate
      .replace(TRAILING_MULTIWORD_CONNECTOR_RE, '')
      .replace(TRAILING_DANGLING_WORD_RE, '')
      .replace(TRAILING_CONNECTOR_SYMBOL_RE, '')
      .trim();

    if (stripped === candidate || stripped.length < minSafeLen) break;
    candidate = stripped;
  }

  return candidate;
}

export function formatEditorialTitle(rawTitle: string, maxLen = 96): string {
  const cleaned = truncateAtWordBoundary(rawTitle, maxLen);
  return cleaned || normalizeSpaces(rawTitle).slice(0, maxLen).trim();
}

export function formatSummaryText(rawSummary: string, maxLen = 285): string {
  const cleaned = truncateAtWordBoundary(rawSummary, Math.max(40, maxLen - 1)).replace(/[.!?\s]+$/, '').trim();
  if (!cleaned) return '';
  return `${cleaned}.`;
}

export function formatMetaDescription(rawMeta: string, maxLen = 158): string {
  return truncateAtWordBoundary(rawMeta, maxLen).replace(/[,:;\-–—\s]+$/, '').trim();
}

export function escapeHtmlText(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function extractPlainText(html: string): string {
  const $ = cheerio.load(html);
  return normalizeSpaces($.text());
}

export function estimateReadingTime(html: string): number {
  const words = countWords(extractPlainText(html));
  return Math.max(1, Math.ceil(words / 220));
}

export function normalizeTextForDiff(raw: string): string {
  return raw
    // Strip ISO dates and common timestamps
    .replace(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g, ' ')
    // Strip relative time strings ("5 minutes ago", "2 hours ago")
    .replace(/\b\d+\s+(?:second|seconds|minute|minutes|hour|hours|day|days|week|weeks)\s+ago\b/gi, ' ')
    // Strip copyright years
    .replace(/©\s*20\d{2}(?:\s*-\s*20\d{2})?/g, ' ')
    // Strip simple visitor/view counters
    .replace(/\b\d[\d,]*\s+(?:views|visitors|online|reads|hits)\b/gi, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenJaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}
