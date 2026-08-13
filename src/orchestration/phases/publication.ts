/**
 * PUBLICATION (Issue #12 section 11). Owned entirely by the orchestrator —
 * no persona ever reaches this code path. Converts Leo's verdict into a
 * GitHub PR review outcome, re-checks the head SHA immediately before
 * posting, and is idempotent: a retry after a completed publication is a
 * no-op, and a retry after a partial failure does not re-decide the
 * verdict.
 */
import type { RepoRef } from '../../types.js';
import { recordEvent } from '../events.js';
import type { OrchestrationStore } from '../store.js';
import type { GitHubReviewOutcome, ReviewRun, Severity, Verdict } from '../types.js';

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export interface PublicationPolicy {
  blockingSeverityThreshold: Severity;
}

export const DEFAULT_PUBLICATION_POLICY: PublicationPolicy = { blockingSeverityThreshold: 'high' };

/** Everything Publication needs from the GitHub client — a structural subset GitHubClient already satisfies. */
export interface PublicationGitHubClient {
  getPullRequest(
    installationId: number,
    repo: RepoRef,
    pullNumber: number,
  ): Promise<{ head: { sha: string } }>;
  createReview(
    installationId: number,
    repo: RepoRef,
    pullNumber: number,
    review: { body: string; event: GitHubReviewOutcome; commit_id?: string },
  ): Promise<{ id: number }>;
}

/** Deterministic mapping from a verdict's published findings to a GitHub review outcome. */
export function determineOutcome(verdict: Verdict, policy: PublicationPolicy = DEFAULT_PUBLICATION_POLICY): GitHubReviewOutcome {
  const published = verdict.findings.filter((f) => f.outcome === 'publish');
  if (published.length === 0) return 'APPROVE';
  const blocking = published.some(
    (f) => f.finalSeverity !== null && SEVERITY_RANK[f.finalSeverity] >= SEVERITY_RANK[policy.blockingSeverityThreshold],
  );
  return blocking ? 'REQUEST_CHANGES' : 'COMMENT';
}

export function renderReviewBody(verdict: Verdict): string {
  const published = verdict.findings.filter((f) => f.outcome === 'publish');
  const lines = ['## Half-Shell Council Review', ''];
  if (published.length === 0) {
    lines.push('The Dojo found nothing that met the publication standard.');
  } else {
    for (const finding of published) {
      lines.push(`**${finding.finalSeverity ?? 'unrated'}** — ${finding.publicReason}`);
      lines.push('');
    }
  }
  lines.push("**Leo's verdict:**", '', verdict.rationale);
  return lines.join('\n');
}

export interface PublishResult {
  outcome: 'published' | 'already_published' | 'superseded_stale_sha';
  githubReviewOutcome?: GitHubReviewOutcome;
  reviewCommentId?: number;
}

/**
 * Publishes one run's verdict. Safe to call more than once: an existing
 * github_publication_completed event short-circuits immediately, and a
 * stale head SHA aborts without posting rather than publishing findings
 * against code that has already moved (Issue #12 sections 3 and 11).
 */
export async function publish(
  store: OrchestrationStore,
  client: PublicationGitHubClient,
  run: ReviewRun,
  verdict: Verdict,
  installationId: number,
  repo: RepoRef,
  policy: PublicationPolicy = DEFAULT_PUBLICATION_POLICY,
): Promise<PublishResult> {
  const existingEvents = await store.listEvents(run.id);
  const alreadyCompleted = existingEvents.find((e) => e.eventType === 'github_publication_completed');
  if (alreadyCompleted) {
    return {
      outcome: 'already_published',
      reviewCommentId: (alreadyCompleted.metadata?.['reviewId'] as number | undefined) ?? undefined,
    };
  }

  const current = await client.getPullRequest(installationId, repo, run.pullRequestNumber);
  if (current.head.sha !== run.headSha) {
    await recordEvent(store, {
      reviewId: run.id,
      phase: 'PUBLICATION',
      actor: 'orchestrator',
      eventType: 'run_superseded',
      content: `PR head moved to ${current.head.sha} before publication; this run reviewed ${run.headSha}.`,
    });
    await store.saveReviewRun({ ...run, status: 'superseded', updatedAt: new Date().toISOString() });
    return { outcome: 'superseded_stale_sha' };
  }

  await recordEvent(store, {
    reviewId: run.id,
    phase: 'PUBLICATION',
    actor: 'orchestrator',
    eventType: 'github_publication_started',
  });

  const githubReviewOutcome = determineOutcome(verdict, policy);
  const body = renderReviewBody(verdict);
  const posted = await client.createReview(installationId, repo, run.pullRequestNumber, {
    body,
    event: githubReviewOutcome,
    commit_id: run.headSha,
  });

  await recordEvent(store, {
    reviewId: run.id,
    phase: 'PUBLICATION',
    actor: 'orchestrator',
    eventType: 'github_publication_completed',
    metadata: { reviewId: posted.id, githubReviewOutcome },
  });

  await store.saveReviewRun({
    ...run,
    status: 'archived',
    currentPhase: 'ARCHIVED',
    updatedAt: new Date().toISOString(),
  });

  return { outcome: 'published', githubReviewOutcome, reviewCommentId: posted.id };
}
