import fs from 'node:fs';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import * as cheerio from 'cheerio';
import {
  addLog,
  getAdminStats,
  getSetting,
  getSiteById,
  getThumbnailDataBySlug,
  listAllAds,
  listAllPosts,
  listLogs,
  listPostsMissingThumbnails,
  listSites,
  pruneOldLogs,
  setPostThumbnail,
  setSetting,
  updateAdHealth,
  updatePost,
} from './db.ts';
import { getGeminiApiKey } from './env.ts';
import { emitPublicPostPublished, emitPublicPostUpdated } from './events.ts';
import { checkSingleSite, runMonitoringCycle, syncHubSitesOnly } from './monitor.ts';
import { validateExternalUrl, validateSlug } from './security.ts';
import {
  formatEditorialTitle,
  formatMetaDescription,
  formatSummaryText,
  hasTrailingConnectorOrPreposition,
} from './textUtils.ts';
import {
  buildFallbackThumbnailPng,
  getThumbnailCachePath,
  saveThumbnailToDiskCache,
} from './thumbnails.ts';
import type { AiControlStatus, AiDirectiveAction, AiSystemHealth } from './types.ts';

const VALID_ACTIONS = new Set<AiDirectiveAction>([
  'sync_hub',
  'retry_error_sites',
  'heal_thumbnails',
  'promote_ready_drafts',
  'repair_post_metadata',
  'verify_ads',
  'prune_logs',
]);

let maintenanceInProgress = false;
let supervisorAiCooldownUntil = 0;

function getAiClient(): GoogleGenAI | null {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isMaintenanceRunning(): boolean {
  return maintenanceInProgress;
}

export async function isAiAutopilotEnabled(): Promise<boolean> {
  const raw = await getSetting('ai_autopilot_enabled');
  return raw !== 'false';
}

export async function setAiAutopilotEnabled(enabled: boolean): Promise<AiControlStatus> {
  await setSetting('ai_autopilot_enabled', enabled ? 'true' : 'false');
  await addLog({
    level: 'info',
    action: 'ai_autopilot_toggled',
    message: `Backend AI autonomous controller ${enabled ? 'enabled (full automatic control)' : 'paused (manual control)'}`,
  });
  return getAiControlStatus();
}

export async function getRecommendedIntervalMinutes(): Promise<number> {
  const raw = await getSetting('ai_recommended_interval_minutes');
  const parsed = Number(raw || 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(15, Math.max(1, Math.round(parsed)));
}

interface StoredAiDecision {
  systemHealth?: AiSystemHealth;
  recommendedIntervalMinutes?: number;
  headlineDirective?: string;
  actionsExecuted?: string[];
  usedAiReasoning?: boolean;
  reasoningModel?: string;
  fallbackReason?: string | null;
}

export async function getAiControlStatus(): Promise<AiControlStatus> {
  const [autopilotEnabled, recommendedIntervalMinutes, lastMaintenanceAt, rawDecision] = await Promise.all([
    isAiAutopilotEnabled(),
    getRecommendedIntervalMinutes(),
    getSetting('ai_last_maintenance_at'),
    getSetting('ai_last_decision'),
  ]);

  let parsed: StoredAiDecision = {};
  if (rawDecision) {
    try {
      parsed = JSON.parse(rawDecision) as StoredAiDecision;
    } catch {
      parsed = {};
    }
  }

  return {
    autopilotEnabled,
    maintenanceRunning: maintenanceInProgress,
    systemHealth: parsed.systemHealth || 'healthy',
    recommendedIntervalMinutes: parsed.recommendedIntervalMinutes ?? recommendedIntervalMinutes,
    lastMaintenanceAt,
    headlineDirective:
      parsed.headlineDirective ||
      'Autonomous Backend AI Controller initialized and monitoring all active sites.',
    actionsExecuted: Array.isArray(parsed.actionsExecuted) ? parsed.actionsExecuted : [],
    usedAiReasoning: Boolean(parsed.usedAiReasoning),
    reasoningModel: parsed.reasoningModel || 'gemini-4-hydrogen',
    fallbackReason: parsed.fallbackReason ?? null,
  };
}

interface SupervisorEvaluation {
  systemHealth: AiSystemHealth;
  recommendedIntervalMinutes: number;
  headlineDirective: string;
  actions: AiDirectiveAction[];
  usedAiReasoning: boolean;
  reasoningModel: string;
  fallbackReason?: string | null;
}

async function evaluateSystemWithAi(telemetry: {
  totalSites: number;
  activeSites: number;
  errorSites: number;
  pendingSites: number;
  uncoveredActiveSites: number;
  publishedPosts: number;
  draftPosts: number;
  draftMode: boolean;
  missingThumbnailCount: number;
  missingDiskCacheCount: number;
  postsNeedingMetaRepair: number;
  adsNeedingVerification: number;
  recentErrors: string[];
}): Promise<SupervisorEvaluation> {
  const deterministicActions = new Set<AiDirectiveAction>();
  if (telemetry.totalSites === 0) deterministicActions.add('sync_hub');
  if (telemetry.errorSites > 0 || telemetry.pendingSites > 0 || telemetry.uncoveredActiveSites > 0) {
    deterministicActions.add('retry_error_sites');
  }
  if (telemetry.missingThumbnailCount > 0 || telemetry.missingDiskCacheCount > 0) {
    deterministicActions.add('heal_thumbnails');
  }
  if (telemetry.postsNeedingMetaRepair > 0) {
    deterministicActions.add('repair_post_metadata');
  }
  if (!telemetry.draftMode && telemetry.draftPosts > 0) {
    deterministicActions.add('promote_ready_drafts');
  }
  if (telemetry.adsNeedingVerification > 0) {
    deterministicActions.add('verify_ads');
  }
  deterministicActions.add('prune_logs');

  const deterministicHealth: AiSystemHealth =
    telemetry.errorSites > 0 || telemetry.missingThumbnailCount > 0
      ? telemetry.errorSites >= Math.max(2, Math.ceil(telemetry.activeSites / 2))
        ? 'degraded'
        : 'recovering'
      : 'healthy';

  const deterministicInterval = 1;

  const deterministicDirective =
    deterministicHealth === 'healthy'
      ? `All ${telemetry.activeSites} active sites and ${telemetry.publishedPosts} published dispatches verified nominal; watching in real time.`
      : `Autonomous maintenance active: recovering ${telemetry.errorSites + telemetry.pendingSites + telemetry.uncoveredActiveSites} site(s) and repairing ${telemetry.missingThumbnailCount + telemetry.missingDiskCacheCount} asset(s).`;

  const ai = getAiClient();
  if (!ai || Date.now() < supervisorAiCooldownUntil) {
    return {
      systemHealth: deterministicHealth,
      recommendedIntervalMinutes: deterministicInterval,
      headlineDirective: deterministicDirective,
      actions: Array.from(deterministicActions),
      usedAiReasoning: false,
      reasoningModel: 'gemini-4-hydrogen',
      fallbackReason: !ai
        ? 'GEMINI_API_KEY not configured'
        : 'AI supervisor in automatic quota cooldown; real-time deterministic controller active',
    };
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `You are the autonomous Backend AI Operations Director for M R S Auto Blog.
Analyze this real-time system telemetry and decide which safe maintenance actions to run right now and what monitoring cadence (1 to 15 minutes) to schedule next.

TELEMETRY:
${JSON.stringify(telemetry, null, 2)}

RULES:
- Choose "sync_hub" if totalSites is 0 or hub discovery is needed.
- Choose "retry_error_sites" if errorSites > 0, pendingSites > 0, or uncoveredActiveSites > 0.
- Choose "heal_thumbnails" if missingThumbnailCount > 0 or missingDiskCacheCount > 0.
- Choose "repair_post_metadata" if postsNeedingMetaRepair > 0.
- Choose "promote_ready_drafts" ONLY when draftMode is false and draftPosts > 0.
- Choose "verify_ads" if adsNeedingVerification > 0.
- Choose "prune_logs" to keep log storage healthy.
- Keep recommendedIntervalMinutes at 1 when recovering, bootstrapping, or actively watching updates; 2-5 when stable.
- Keep headlineDirective under 140 characters, factual and grounded strictly in the telemetry.`,
      config: {
        abortSignal: AbortSignal.timeout(8000),
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        systemInstruction:
          'You are a reliable autonomous backend operations controller. Output strictly valid JSON matching the schema.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            systemHealth: {
              type: Type.STRING,
              description: 'One of: healthy, degraded, recovering',
            },
            recommendedIntervalMinutes: {
              type: Type.INTEGER,
              description: 'Integer between 1 and 15',
            },
            headlineDirective: {
              type: Type.STRING,
              description: 'Concise operational summary grounded in telemetry',
            },
            actions: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['systemHealth', 'recommendedIntervalMinutes', 'headlineDirective', 'actions'],
        },
      },
    });

    const rawText = response.text?.trim() || '';
    const parsed = JSON.parse(rawText) as {
      systemHealth?: string;
      recommendedIntervalMinutes?: number;
      headlineDirective?: string;
      actions?: string[];
    };

    const health: AiSystemHealth =
      parsed.systemHealth === 'degraded' || parsed.systemHealth === 'recovering' || parsed.systemHealth === 'healthy'
        ? parsed.systemHealth
        : deterministicHealth;

    const interval = Number.isFinite(parsed.recommendedIntervalMinutes)
      ? Math.min(15, Math.max(1, Math.round(Number(parsed.recommendedIntervalMinutes))))
      : deterministicInterval;

    const mergedActions = new Set<AiDirectiveAction>(deterministicActions);
    if (Array.isArray(parsed.actions)) {
      for (const act of parsed.actions) {
        if (VALID_ACTIONS.has(act as AiDirectiveAction)) {
          mergedActions.add(act as AiDirectiveAction);
        }
      }
    }

    return {
      systemHealth: health,
      recommendedIntervalMinutes: interval,
      headlineDirective:
        typeof parsed.headlineDirective === 'string' && parsed.headlineDirective.trim()
          ? parsed.headlineDirective.trim().slice(0, 160)
          : deterministicDirective,
      actions: Array.from(mergedActions),
      usedAiReasoning: true,
      reasoningModel: 'gemini-4-hydrogen',
      fallbackReason: null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const lower = errMsg.toLowerCase();
    if (
      lower.includes('429') ||
      lower.includes('quota') ||
      lower.includes('resource_exhausted') ||
      lower.includes('aborted') ||
      lower.includes('timeout')
    ) {
      supervisorAiCooldownUntil = Date.now() + 10 * 60 * 1000;
    }
    return {
      systemHealth: deterministicHealth,
      recommendedIntervalMinutes: deterministicInterval,
      headlineDirective: deterministicDirective,
      actions: Array.from(deterministicActions),
      usedAiReasoning: false,
      reasoningModel: 'gemini-4-hydrogen',
      fallbackReason: errMsg,
    };
  }
}

export async function runAiMaintenanceAndControl(
  trigger: 'startup' | 'scheduler' | 'manual'
): Promise<AiControlStatus> {
  if (maintenanceInProgress) {
    return getAiControlStatus();
  }

  maintenanceInProgress = true;
  const actionsExecuted: string[] = [];

  try {
    const [stats, sites, posts, missingThumbs, recentLogs, autopilotEnabled, allAds] = await Promise.all([
      getAdminStats(),
      listSites(),
      listAllPosts(),
      listPostsMissingThumbnails(),
      listLogs(35),
      isAiAutopilotEnabled(),
      listAllAds(),
    ]);

    const sitesWithPosts = new Set(posts.map((p) => p.siteId).filter((id): id is number => id !== null));
    const uncoveredActiveSites = sites.filter((s) => s.active && !sitesWithPosts.has(s.id));
    const errorSitesList = sites.filter((s) => s.active && s.lastStatus === 'error');
    const pendingSitesList = sites.filter((s) => s.active && s.lastStatus === 'pending');

    let missingDiskCacheCount = 0;
    for (const post of posts) {
      try {
        const cachePath = getThumbnailCachePath(post.slug);
        if (!fs.existsSync(cachePath) || fs.statSync(cachePath).size < 100) {
          missingDiskCacheCount++;
        }
      } catch {
        missingDiskCacheCount++;
      }
    }

    const postsNeedingMetaRepair = posts.filter((p) => {
      const words = cheerio.load(p.contentHtml).text().trim().split(/\s+/).filter(Boolean).length;
      const expectedReadingTime = Math.max(1, Math.ceil(words / 220));
      return (
        hasTrailingConnectorOrPreposition(p.title) ||
        !p.metaDescription ||
        p.metaDescription.trim().length < 20 ||
        hasTrailingConnectorOrPreposition(p.metaDescription) ||
        !p.summary ||
        p.summary.trim().length < 20 ||
        hasTrailingConnectorOrPreposition(p.summary) ||
        p.readingTimeMinutes !== expectedReadingTime
      );
    });

    const recentErrors = recentLogs
      .filter((l) => l.level === 'error')
      .slice(0, 6)
      .map((l) => `${l.siteName || 'System'}: ${l.message}`);

    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const adsToVerify = allAds.filter(
      (ad) =>
        ad.active &&
        (ad.lastStatus !== 'ok' ||
          !ad.lastCheckedAt ||
          new Date(ad.lastCheckedAt).getTime() < sixHoursAgo)
    );

    const evaluation = await evaluateSystemWithAi({
      totalSites: stats.totalSites,
      activeSites: stats.activeSites,
      errorSites: errorSitesList.length,
      pendingSites: pendingSitesList.length,
      uncoveredActiveSites: uncoveredActiveSites.length,
      publishedPosts: stats.publishedPosts,
      draftPosts: stats.draftPosts,
      draftMode: stats.draftMode,
      missingThumbnailCount: missingThumbs.length,
      missingDiskCacheCount,
      postsNeedingMetaRepair: postsNeedingMetaRepair.length,
      adsNeedingVerification: adsToVerify.length,
      recentErrors,
    });

    // Execute directives deterministically when autopilot is enabled or triggered manually
    if (autopilotEnabled || trigger === 'manual') {
      if (evaluation.actions.includes('sync_hub') && stats.totalSites === 0) {
        const syncRes = await syncHubSitesOnly();
        actionsExecuted.push(`hub_sync(${syncRes.added} added)`);
      }

      if (evaluation.actions.includes('retry_error_sites')) {
        const targetSites = Array.from(
          new Map(
            [...errorSitesList, ...pendingSitesList, ...uncoveredActiveSites].map((s) => [s.id, s])
          ).values()
        ).slice(0, 15);

        let recovered = 0;
        let published = 0;
        for (const site of targetSites) {
          const checkRes = await checkSingleSite(site.id);
          if (checkRes.status === 'ok') recovered++;
          if (checkRes.postCreated) published++;
        }
        if (targetSites.length > 0) {
          actionsExecuted.push(
            `site_recovery(${recovered}/${targetSites.length} ok, ${published} post(s))`
          );
        }
      }

      if (evaluation.actions.includes('heal_thumbnails')) {
        let healedCount = 0;
        for (const missing of missingThumbs) {
          try {
            const safeSlug = validateSlug(missing.slug);
            const site = missing.siteId ? await getSiteById(missing.siteId) : null;
            const pngBuffer = await buildFallbackThumbnailPng(
              missing.title,
              missing.siteName,
              safeSlug,
              site?.themeColor
            );
            saveThumbnailToDiskCache(safeSlug, pngBuffer);
            await setPostThumbnail(missing.id, `/thumbnails/${safeSlug}.png`, pngBuffer);
            healedCount++;
          } catch {
            // skip individual bad slug
          }
        }

        const refreshedPosts = await listAllPosts();
        for (const post of refreshedPosts) {
          try {
            const safeSlug = validateSlug(post.slug);
            const cachePath = getThumbnailCachePath(safeSlug);
            if (!fs.existsSync(cachePath) || fs.statSync(cachePath).size < 100) {
              const dbThumb = await getThumbnailDataBySlug(safeSlug);
              if (dbThumb?.data && dbThumb.data.length > 100) {
                saveThumbnailToDiskCache(safeSlug, dbThumb.data);
              } else {
                const site = post.siteId ? await getSiteById(post.siteId) : null;
                const pngBuffer = await buildFallbackThumbnailPng(
                  post.title,
                  post.siteName,
                  safeSlug,
                  site?.themeColor
                );
                saveThumbnailToDiskCache(safeSlug, pngBuffer);
                await setPostThumbnail(post.id, `/thumbnails/${safeSlug}.png`, pngBuffer);
              }
              healedCount++;
            }
          } catch {
            // ignore individual thumbnail errors
          }
        }
        if (healedCount > 0) {
          actionsExecuted.push(`healed_thumbnails(${healedCount})`);
        }
      }

      if (evaluation.actions.includes('repair_post_metadata') && postsNeedingMetaRepair.length > 0) {
        let repairedCount = 0;
        for (const post of postsNeedingMetaRepair) {
          const plainText = cheerio.load(post.contentHtml).text().replace(/\s+/g, ' ').trim();
          const words = plainText.split(/\s+/).filter(Boolean).length;
          const expectedReadingTime = Math.max(1, Math.ceil(words / 220));
          const patch: Parameters<typeof updatePost>[1] = {};

          if (hasTrailingConnectorOrPreposition(post.title)) {
            const cleanedTitle = formatEditorialTitle(post.title, 96);
            if (cleanedTitle && cleanedTitle !== post.title) {
              patch.title = cleanedTitle;
            }
          }
          if (!post.summary || post.summary.trim().length < 20 || hasTrailingConnectorOrPreposition(post.summary)) {
            const sourceSummary =
              post.summary && post.summary.trim().length >= 20
                ? post.summary
                : plainText || `${post.siteName}: ${patch.title || post.title}`;
            patch.summary = formatSummaryText(sourceSummary, 285) || `${sourceSummary.trim()}.`;
          }
          if (
            !post.metaDescription ||
            post.metaDescription.trim().length < 20 ||
            hasTrailingConnectorOrPreposition(post.metaDescription)
          ) {
            const sourceMeta =
              post.metaDescription && post.metaDescription.trim().length >= 20
                ? post.metaDescription
                : patch.summary || post.summary || patch.title || post.title;
            patch.metaDescription = formatMetaDescription(sourceMeta, 158);
          }
          if (post.readingTimeMinutes !== expectedReadingTime) {
            patch.readingTimeMinutes = expectedReadingTime;
          }

          if (Object.keys(patch).length > 0) {
            const updated = await updatePost(post.id, patch);
            if (updated) {
              emitPublicPostUpdated(updated);
              repairedCount++;
            }
          }
        }
        if (repairedCount > 0) {
          actionsExecuted.push(`repaired_metadata(${repairedCount})`);
        }
      }

      if (evaluation.actions.includes('promote_ready_drafts') && !stats.draftMode) {
        const readyDrafts = posts.filter((p) => {
          if (p.status !== 'draft') return false;
          const words = cheerio.load(p.contentHtml).text().trim().split(/\s+/).filter(Boolean).length;
          return p.title.trim().length >= 8 && words >= 80;
        });

        let promotedCount = 0;
        for (const draft of readyDrafts) {
          const updated = await updatePost(draft.id, { status: 'published' });
          if (updated) {
            emitPublicPostPublished(updated);
            promotedCount++;
          }
        }
        if (promotedCount > 0) {
          actionsExecuted.push(`promoted_drafts(${promotedCount})`);
        }
      }

      if (evaluation.actions.includes('verify_ads') && adsToVerify.length > 0) {
        let verifiedOk = 0;
        for (const ad of adsToVerify) {
          try {
            validateExternalUrl(ad.targetUrl);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            try {
              const res = await fetch(ad.targetUrl, {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (compatible; MRSAutoBlogBot/1.0)',
                },
              });
              if (res.url) {
                validateExternalUrl(res.url);
              }
              await updateAdHealth(ad.id, res.status < 500 ? 'ok' : 'error');
              if (res.status < 500) verifiedOk++;
            } finally {
              clearTimeout(timer);
            }
          } catch {
            await updateAdHealth(ad.id, 'error');
          }
        }
        actionsExecuted.push(`verified_ads(${verifiedOk}/${adsToVerify.length})`);
      }

      if (evaluation.actions.includes('prune_logs')) {
        const pruned = await pruneOldLogs(500);
        if (pruned > 0) {
          actionsExecuted.push(`pruned_logs(${pruned})`);
        }
      }
    }

    const finishedAt = new Date().toISOString();
    await Promise.all([
      setSetting('ai_last_maintenance_at', finishedAt),
      setSetting('ai_recommended_interval_minutes', String(evaluation.recommendedIntervalMinutes)),
      setSetting(
        'ai_last_decision',
        JSON.stringify({
          systemHealth: evaluation.systemHealth,
          recommendedIntervalMinutes: evaluation.recommendedIntervalMinutes,
          headlineDirective: evaluation.headlineDirective,
          actionsExecuted,
          usedAiReasoning: evaluation.usedAiReasoning,
          reasoningModel: evaluation.reasoningModel,
          fallbackReason: evaluation.fallbackReason ?? null,
        })
      ),
    ]);

    await addLog({
      level: evaluation.systemHealth === 'healthy' ? 'success' : 'info',
      action: 'ai_maintenance',
      message: `AI Controller (${trigger}): ${evaluation.headlineDirective}`,
      details:
        actionsExecuted.length > 0
          ? `Actions: ${actionsExecuted.join(', ')} | Next check: ${evaluation.recommendedIntervalMinutes}m`
          : `System nominal | Next check: ${evaluation.recommendedIntervalMinutes}m`,
    });

    return getAiControlStatus();
  } finally {
    maintenanceInProgress = false;
  }
}

export async function runAutonomousCycle(
  trigger: 'startup' | 'scheduler' | 'manual'
): Promise<{
  skipped?: boolean;
  sitesChecked: number;
  postsCreated: number;
  errors: number;
  aiControl: AiControlStatus;
}> {
  if (trigger === 'scheduler') {
    const autopilot = await isAiAutopilotEnabled();
    if (!autopilot) {
      const aiControl = await getAiControlStatus();
      return {
        skipped: true,
        sitesChecked: 0,
        postsCreated: 0,
        errors: 0,
        aiControl,
      };
    }
  }

  const monitorResult = await runMonitoringCycle(trigger);
  const aiControl = await runAiMaintenanceAndControl(trigger);
  return {
    ...monitorResult,
    aiControl,
  };
}
