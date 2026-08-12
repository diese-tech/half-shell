import { buildBrief } from '../council/briefing.js';
import { runLanes } from '../council/lanes.js';
import { buildAnonymousPool } from '../council/pool.js';
import { runShredder, runSparring } from '../council/sparring.js';
import { renderChange } from '../council/prompt.js';
import { assembleVerdict, runVerdict } from '../council/verdict.js';
import { describeCoverage } from '../github/context.js';
import { buildDiffIndex } from '../github/diff.js';
import { log } from '../logger.js';
import { PROTOCOL_VERSION } from '../protocol/protocol.js';
import type { ProviderRouter } from '../providers/router.js';
import type { ChangeContext, LaneOutcome, PoolItem, ReviewDepth, ReviewRun } from '../types.js';
import { anchorFindings } from './anchor.js';

export interface ReviewOptions {
  depth: ReviewDepth;
  maxPatchChars: number;
  /** Character budget for the whole rendered change in one prompt. */
  maxPromptChars?: number;
}

export interface ReviewResult {
  run: ReviewRun;
  pool: PoolItem[];
  rationale: Map<string, string>;
}

/**
 * The full Dojo pipeline for one change:
 * briefing → independent lanes → anonymous pool → sparring → Shredder → verdict.
 */
export async function runReview(
  router: ProviderRouter,
  context: ChangeContext,
  options: ReviewOptions,
): Promise<ReviewResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const render = {
    maxPatchChars: options.maxPatchChars,
    maxTotalChars: options.maxPromptChars,
  };
  const diffs = buildDiffIndex(context.files);

  log.info('review started', {
    repo: `${context.repo.owner}/${context.repo.repo}`,
    pr: context.pullNumber,
    files: context.files.length,
    depth: options.depth,
  });

  // Render once and reuse: what the investigators saw is what coverage claims.
  const change = renderChange(context, render);
  for (const omission of change.omitted) {
    context.omittedFiles.push(omission);
  }
  context.files = context.files.filter((file) => change.includedPaths.includes(file.path));

  const phaseMs: Record<string, number> = {};
  const timed = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
    const startedMs = Date.now();
    try {
      return await work();
    } finally {
      phaseMs[phase] = (phaseMs[phase] ?? 0) + (Date.now() - startedMs);
    }
  };

  const brief = await timed('briefing', () => buildBrief(router, context, change.text));
  const { candidates, outcomes } = await timed('lanes', () =>
    runLanes(router, change.text, brief, options.depth),
  );

  // Ground every claim in the real diff before the council spends effort on it.
  const anchored = anchorFindings(candidates, diffs);
  for (const drop of anchored.dropped) {
    log.info('finding rejected before deliberation', {
      file: drop.finding.file,
      reason: drop.reason,
    });
  }

  const pool = buildAnonymousPool(anchored.kept);
  const sparring = await timed('sparring', () => runSparring(router, pool, brief));
  const shredder = await timed('shredder', () =>
    runShredder(router, pool, brief, sparring.critiques),
  );

  // A finding that never faced the adversarial pass has not survived review.
  const shredderFailed = !shredder.ok && pool.length > 0;
  const challengeFailures = sparring.failedRoles.length + (shredderFailed ? 1 : 0);

  const coverage = describeCoverage(context);
  const coverageLimitations = buildLimitations(context, outcomes, anchored.dropped.length);
  for (const role of sparring.failedRoles) {
    coverageLimitations.push(`The ${role} Sparring pass did not complete.`);
  }
  if (shredderFailed) coverageLimitations.push('The Shredder Challenge did not complete.');

  const adjudication = await timed('verdict', () =>
    runVerdict(router, {
      pool,
      brief,
      critiques: sparring.critiques,
      shredder,
      coverage,
      coverageLimitations,
    }),
  );

  const { verdict, rationale } = assembleVerdict({
    pool,
    adjudication,
    reviewedSha: context.headSha,
    baseSha: context.baseSha,
    coverage,
    coverageLimitations,
    laneFailures: outcomes.filter((outcome) => !outcome.ok).length,
    challengeFailures,
  });

  const run: ReviewRun = {
    id: `${context.repo.owner}-${context.repo.repo}-${context.pullNumber}-${context.headSha.slice(0, 7)}-${Date.now()}`,
    repo: context.repo,
    pullNumber: context.pullNumber,
    headSha: context.headSha,
    baseSha: context.baseSha,
    protocolVersion: PROTOCOL_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict,
    lanes: outcomes,
    providersUsed: router.used,
    telemetry: {
      durationMs: Date.now() - startedMs,
      phaseMs,
      providerCalls: router.stats.calls,
      providerFailures: router.stats.failures,
      promptTokens: router.stats.promptTokens,
      completionTokens: router.stats.completionTokens,
    },
  };

  log.info('review finished', {
    pr: context.pullNumber,
    candidates: verdict.candidate_count,
    published: verdict.published_findings.length,
    complete: verdict.complete,
    durationMs: run.telemetry.durationMs,
    providerCalls: run.telemetry.providerCalls,
    tokens: run.telemetry.promptTokens + run.telemetry.completionTokens,
  });

  return { run, pool, rationale };
}

function buildLimitations(
  context: ChangeContext,
  outcomes: LaneOutcome[],
  droppedCount: number,
): string[] {
  const limitations: string[] = [];
  for (const outcome of outcomes) {
    if (!outcome.ok) limitations.push(`The ${outcome.role} lane did not complete: ${outcome.error}`);
  }
  if (context.omittedFiles.length > 0) {
    limitations.push(`${context.omittedFiles.length} changed file(s) were not reviewed.`);
  }
  if (droppedCount > 0) {
    limitations.push(
      `${droppedCount} proposed finding(s) were discarded for pointing outside the diff.`,
    );
  }
  return limitations;
}
