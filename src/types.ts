import type { Finding, Verdict } from './protocol/types.js';

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  /** Unified diff for this file. Absent for binaries and oversized blobs. */
  patch?: string;
  truncated: boolean;
}

/** Context beyond the diff, included as background only. */
export interface RelatedFile {
  path: string;
  reason: 'covering test' | 'calls changed code';
  content: string;
  truncated: boolean;
}

/** Everything the council is allowed to see about a change. */
export interface ChangeContext {
  repo: RepoRef;
  pullNumber: number;
  title: string;
  description: string;
  author: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  files: ChangedFile[];
  /** Files omitted from context, with the reason, so coverage stays honest. */
  omittedFiles: { path: string; reason: string }[];
  linkedIssues: { number: number; title: string; body: string }[];
  repoInstructions?: string;
  /** Background context; never reviewable, never a valid finding location. */
  relatedFiles: RelatedFile[];
}

export type ReviewDepth = 'standard' | 'deep';

export type JobKind = 'review' | 'verify' | 'reconsider' | 'explain';

export interface ReviewJob {
  kind: JobKind;
  depth: ReviewDepth;
  repo: RepoRef;
  pullNumber: number;
  installationId: number;
  deliveryId: string;
  /** Set for follow-up jobs originating inside a review thread. */
  thread?: {
    commentId: number;
    inReplyToId?: number;
    body: string;
    author: string;
    path?: string;
    line?: number;
    /**
     * True when the reply carried no explicit command and was picked up only
     * because it landed in a review thread. Such a job is dropped unless the
     * parent comment is a known Half-Shell finding.
     */
    implicit?: boolean;
  };
}

/** A finding as it left an investigator lane, before anonymization. */
export interface CandidateFinding {
  finding: Finding;
  /** Never exposed to the council during deliberation. */
  author: string;
  provider: string;
}

export interface PoolItem {
  finding: Finding;
  /** Hidden authorship kept only for run records and post-hoc debugging. */
  authors: string[];
  mergedFrom: string[];
}

export interface LaneOutcome {
  role: string;
  ok: boolean;
  findings: number;
  provider?: string;
  error?: string;
}

/** What one review cost, for capacity planning and cost control. */
export interface RunTelemetry {
  durationMs: number;
  /** Wall-clock milliseconds per protocol phase. */
  phaseMs: Record<string, number>;
  providerCalls: number;
  providerFailures: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ReviewRun {
  id: string;
  repo: RepoRef;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  protocolVersion: string;
  startedAt: string;
  finishedAt: string;
  verdict: Verdict;
  lanes: LaneOutcome[];
  providersUsed: string[];
  telemetry: RunTelemetry;
}

export interface PublishedFindingRecord {
  key: string;
  findingId: string;
  repo: RepoRef;
  pullNumber: number;
  headSha: string;
  file: string;
  line: number | null;
  claim: string;
  commentId?: number;
  status: 'published' | 'resolved' | 'withdrawn' | 'still_valid' | 'partially_resolved';
  publishedAt: string;
}
