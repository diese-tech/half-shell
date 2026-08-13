/**
 * Pure decision logic for review-generation identity and webhook safety
 * (Issue #12 section 3). Kept separate from the store so the rules —
 * dedup, supersession, staleness — are unit-testable without a database.
 */
import type { ReviewRun } from './types.js';

const ACTIVE_STATUS: ReviewRun['status'] = 'running';

/** A webhook delivery already recorded against this PR's runs is a no-op retry. */
export function isDuplicateDelivery(existingRuns: ReviewRun[], deliveryId: string | null): boolean {
  if (!deliveryId) return false;
  return existingRuns.some((run) => run.githubDeliveryId === deliveryId);
}

/**
 * A delivery is for a generation Half-Shell has already run to completion
 * (or is currently running) at the same head SHA — nothing new to do.
 */
export function isSameGenerationAlreadyHandled(existingRuns: ReviewRun[], headSha: string): boolean {
  return existingRuns.some((run) => run.headSha === headSha);
}

/** Every prior run for this PR that is still active and at an older head SHA. */
export function runsToSupersede(existingRuns: ReviewRun[], incomingHeadSha: string): ReviewRun[] {
  return existingRuns.filter((run) => run.status === ACTIVE_STATUS && run.headSha !== incomingHeadSha);
}

export function nextGeneration(existingRuns: ReviewRun[]): number {
  if (existingRuns.length === 0) return 1;
  return Math.max(...existingRuns.map((run) => run.generation)) + 1;
}

/**
 * The mandatory pre-publish check (Issue #12 sections 3 and 11): a run may
 * only publish if the PR's current head SHA still matches what it reviewed.
 */
export function canPublish(run: ReviewRun, currentHeadSha: string): boolean {
  return run.headSha === currentHeadSha && run.status === ACTIVE_STATUS;
}
