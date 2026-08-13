/**
 * Core domain types for the council orchestration engine. These mirror
 * /schemas/*.json — the JSON Schemas are the actual validated contract for
 * anything that crosses a model or persistence boundary; these types exist
 * so the engine's own code is type-checked against the same shape.
 */

export const PHASE_ORDER = [
  'RECEIVED',
  'CASE_FILE',
  'INDEPENDENT_REVIEW',
  'MENTORSHIP',
  'SYNTHESIS',
  'SPARRING',
  'LEO_REVIEW',
  'PUBLICATION',
  'ARCHIVED',
] as const;

export type Phase = (typeof PHASE_ORDER)[number];

export const TERMINAL_ERROR_STATES = [
  'failed_retryable',
  'failed_final',
  'cancelled',
  'superseded',
] as const;

export type RunStatus = 'running' | 'archived' | (typeof TERMINAL_ERROR_STATES)[number];

export type PersonaCodename =
  | 'leo'
  | 'raph'
  | 'donnie'
  | 'mikey'
  | 'splinter'
  | 'april'
  | 'casey'
  | 'shredder';

export type EventActor = 'orchestrator' | PersonaCodename;

export const EVENT_TYPES = [
  'phase_started',
  'phase_completed',
  'persona_message',
  'finding_created',
  'finding_updated',
  'finding_merged',
  'finding_withdrawn',
  'evidence_added',
  'challenge',
  'challenge_answered',
  'challenge_accepted',
  'experiment_proposed',
  'observation_recorded',
  'lesson_added',
  'verdict_recorded',
  'github_publication_started',
  'github_publication_completed',
  'run_superseded',
  'run_failed',
  'validation_failed',
] as const;

export type CouncilEventType = (typeof EVENT_TYPES)[number];

export interface RepoIdentity {
  repositoryId: string;
  repositoryFullName: string;
}

export interface ReviewRun {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  status: RunStatus;
  currentPhase: Phase;
  generation: number;
  trigger: 'webhook' | 'manual' | 'retry' | 'reopened';
  supersededByReviewId: string | null;
  githubDeliveryId: string | null;
  tokenUsage: { promptTokens: number; completionTokens: number };
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CouncilEvent {
  id: string;
  reviewId: string;
  sequence: number;
  phase: Phase;
  actor: EventActor;
  eventType: CouncilEventType;
  findingId: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type FindingCategory =
  | 'bug'
  | 'regression'
  | 'security'
  | 'contract'
  | 'incomplete_change'
  | 'missing_test'
  | 'undocumented_behavior'
  | 'operational'
  | 'human_experience'
  | 'operational_abuse'
  | 'engineering_discipline';

export type FindingStatus =
  | 'candidate'
  | 'surviving_sparring'
  | 'narrowed'
  | 'merged'
  | 'withdrawn'
  | 'investigation_requested'
  | 'published'
  | 'rejected';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type CorroborationType =
  | 'shared_assumption'
  | 'repeated_unsupported_assumption'
  | 'independent_same_evidence'
  | 'independent_distinct_evidence';

export type CorroborationEffect =
  | 'no_confidence_gain'
  | 'confidence_penalty'
  | 'small_confidence_gain'
  | 'strong_confidence_gain';

export interface Corroboration {
  type: CorroborationType;
  confidenceEffect: CorroborationEffect;
  contributingSourcePersonas: PersonaCodename[];
}

export interface CouncilFinding {
  id: string;
  reviewId: string;
  sourcePersona: PersonaCodename;
  category: FindingCategory;
  claim: string;
  evidence: string;
  affectedCode: { file: string; line: number | null; startLine: number | null };
  consequence: string;
  confidence: number;
  status: FindingStatus;
  reproduction: string | null;
  proposedFix: string | null;
  severity: Severity | null;
  historicalContext: { recurring: boolean; priorFindingIds: string[]; lesson: string | null } | null;
  relatedFindings: string[];
  corroboration: Corroboration | null;
  rootCause: string | null;
}

export interface EvidenceFact {
  statement: string;
}

export interface EvidenceSource {
  kind: 'diff' | 'pull_request' | 'linked_issue' | 'comment' | 'repository_guidance' | 'commit_history' | 'related_pull_request';
  reference: string;
}

export interface EvidenceInference {
  statement: string;
  basis: string;
}

export interface EvidenceUnknown {
  question: string;
  whyItMatters: string | null;
}

export interface EvidencePacket {
  reviewId: string;
  facts: EvidenceFact[];
  sources: EvidenceSource[];
  relevance: string[];
  inferences: EvidenceInference[];
  unknowns: EvidenceUnknown[];
  statedIntent: string;
  unresolvedContext: string[];
  createdAt: string;
}

export type VerdictOutcome =
  | 'publish'
  | 'reject'
  | 'merge'
  | 'narrow'
  | 'raise_severity'
  | 'lower_severity'
  | 'request_more_investigation';

export interface VerdictFindingDecision {
  findingId: string;
  outcome: VerdictOutcome;
  finalSeverity: Severity | null;
  publicReason: string;
}

export type OverallOutcome =
  | 'clean_review'
  | 'non_blocking_findings_published'
  | 'blocking_findings_published'
  | 'incomplete';

export interface Verdict {
  reviewId: string;
  reviewer: 'leonardo';
  overallOutcome: OverallOutcome;
  rationale: string;
  findings: VerdictFindingDecision[];
  unresolvedUncertainty: string[];
  createdAt: string;
}

export type GitHubReviewOutcome = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
