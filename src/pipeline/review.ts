import { buildBrief } from '../council/briefing.js';
import { runLanes } from '../council/lanes.js';
import { buildAnonymousPool } from '../council/pool.js';
import { runShredder, runSparring } from '../council/sparring.js';
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
  const render = { maxPatchChars: options.maxPatchChars };
  const diffs = buildDiffIndex(context.files);

  log.info('review started', {
    repo: `${context.repo.owner}/${context.repo.repo}`,
    pr: context.pullNumber,
    files: context.files.length,
    depth: options.depth,
  });

  const brief = await buildBrief(router, context, render);
  const { candidates, outcomes } = await runLanes(router, context, brief, render, options.depth);

  // Ground every claim in the real diff before the council spends effort on it.
  const anchored = anchorFindings(candidates, diffs);
  for (const drop of anchored.dropped) {
    log.info('finding rejected before deliberation', {
      file: drop.finding.file,
      reason: drop.reason,
    });
  }

  const pool = buildAnonymousPool(anchored.kept);
  const critiques = await runSparring(router, pool, brief);
  const shredder = await runShredder(router, pool, brief, critiques);

  const coverage = describeCoverage(context);
  const coverageLimitations = buildLimitations(context, outcomes, anchored.dropped.length);

  const adjudication = await runVerdict(router, {
    pool,
    brief,
    critiques,
    shredder,
    coverage,
    coverageLimitations,
  });

  const { verdict, rationale } = assembleVerdict({
    pool,
    adjudication,
    reviewedSha: context.headSha,
    baseSha: context.baseSha,
    coverage,
    coverageLimitations,
    laneFailures: outcomes.filter((outcome) => !outcome.ok).length,
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
  };

  log.info('review finished', {
    pr: context.pullNumber,
    candidates: verdict.candidate_count,
    published: verdict.published_findings.length,
    complete: verdict.complete,
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
