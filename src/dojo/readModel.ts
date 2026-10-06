/**
 * Read model for Dojo v0 (Issue #20): a local, read-only view over the
 * Council orchestration store. Everything here is derived on read from
 * the existing review_runs / council_events / council_findings /
 * evidence_packets / council_verdicts tables — there is no second
 * persistence model, and nothing in this module can write.
 */
import type { OrchestrationStore } from '../orchestration/store.js';
import type {
  CouncilEvent,
  CouncilFinding,
  EvidencePacket,
  GitHubReviewOutcome,
  ReviewRun,
  Verdict,
} from '../orchestration/types.js';

/** The only store surface the viewer is allowed to touch: reads. */
export type DojoReader = Pick<
  OrchestrationStore,
  'listRecentReviewRuns' | 'getReviewRun' | 'listEvents' | 'listFindings' | 'getVerdict' | 'getEvidencePacket'
>;

export interface VerdictSummary {
  overallOutcome: Verdict['overallOutcome'];
  /** Decisions Leo published as blocking. */
  blocking: number;
  /** Decisions Leo published as non-blocking. */
  nonBlocking: number;
  /** Decisions that were not published (reject, merge, narrow, ...). */
  notPublished: number;
}

export type PublicationStateName = 'not_started' | 'in_progress' | 'published' | 'superseded' | 'failed';

export interface PublicationState {
  state: PublicationStateName;
  githubReviewOutcome: GitHubReviewOutcome | null;
  githubReviewId: number | null;
  at: string | null;
  detail: string | null;
}

export interface RunSummary {
  id: string;
  repository: string;
  pullRequestNumber: number;
  generation: number;
  headSha: string;
  shortHeadSha: string;
  phase: ReviewRun['currentPhase'];
  status: ReviewRun['status'];
  active: boolean;
  createdAt: string;
  updatedAt: string;
  verdict: VerdictSummary | null;
}

export interface RunDetail {
  run: ReviewRun;
  summary: RunSummary;
  events: CouncilEvent[];
  findings: CouncilFinding[];
  verdict: Verdict | null;
  evidence: EvidencePacket | null;
  publication: PublicationState;
}

export function isActive(run: ReviewRun): boolean {
  return run.status === 'running';
}

export function summarizeVerdict(verdict: Verdict | undefined | null): VerdictSummary | null {
  if (!verdict) return null;
  const published = verdict.findings.filter((f) => f.outcome === 'publish');
  const blocking = published.filter((f) => f.blocking).length;
  return {
    overallOutcome: verdict.overallOutcome,
    blocking,
    nonBlocking: published.length - blocking,
    notPublished: verdict.findings.length - published.length,
  };
}

/**
 * Derives GitHub publication state purely from the append-only event
 * stream that phases/publication.ts writes, plus the run's terminal status.
 */
export function publicationState(run: ReviewRun, events: CouncilEvent[]): PublicationState {
  const base: PublicationState = {
    state: 'not_started',
    githubReviewOutcome: null,
    githubReviewId: null,
    at: null,
    detail: null,
  };
  const completed = events.find((e) => e.eventType === 'github_publication_completed');
  if (completed) {
    const outcome = completed.metadata?.['githubReviewOutcome'];
    const reviewId = completed.metadata?.['reviewId'];
    return {
      state: 'published',
      githubReviewOutcome: typeof outcome === 'string' ? (outcome as GitHubReviewOutcome) : null,
      githubReviewId: typeof reviewId === 'number' ? reviewId : null,
      at: completed.createdAt,
      detail: null,
    };
  }
  const superseded = events.find((e) => e.eventType === 'run_superseded');
  if (superseded || run.status === 'superseded') {
    return { ...base, state: 'superseded', at: superseded?.createdAt ?? null, detail: superseded?.content ?? null };
  }
  const started = events.find((e) => e.eventType === 'github_publication_started');
  if (run.status === 'failed_final' || run.status === 'failed_retryable' || run.status === 'cancelled') {
    return { ...base, state: 'failed', at: started?.createdAt ?? null, detail: run.error };
  }
  if (started) return { ...base, state: 'in_progress', at: started.createdAt };
  return base;
}

export function summarizeRun(run: ReviewRun, verdict: Verdict | undefined | null): RunSummary {
  return {
    id: run.id,
    repository: run.repositoryFullName || run.repositoryId,
    pullRequestNumber: run.pullRequestNumber,
    generation: run.generation,
    headSha: run.headSha,
    shortHeadSha: run.headSha.slice(0, 7),
    phase: run.currentPhase,
    status: run.status,
    active: isActive(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    verdict: summarizeVerdict(verdict),
  };
}

export async function listRunSummaries(reader: DojoReader, limit: number): Promise<RunSummary[]> {
  const runs = await reader.listRecentReviewRuns(limit);
  return Promise.all(runs.map(async (run) => summarizeRun(run, await reader.getVerdict(run.id))));
}

export async function getRunDetail(reader: DojoReader, reviewId: string): Promise<RunDetail | undefined> {
  const run = await reader.getReviewRun(reviewId);
  if (!run) return undefined;
  const [events, findings, verdict, evidence] = await Promise.all([
    reader.listEvents(reviewId),
    reader.listFindings(reviewId),
    reader.getVerdict(reviewId),
    reader.getEvidencePacket(reviewId),
  ]);
  return {
    run,
    summary: summarizeRun(run, verdict),
    events,
    findings,
    verdict: verdict ?? null,
    evidence: evidence ?? null,
    publication: publicationState(run, events),
  };
}
