/**
 * Types mirroring the machine-readable contracts in
 * `skills/half-shell-review/v1/schemas/`. The schemas remain authoritative;
 * these exist so the runtime can talk about protocol objects in TypeScript.
 */

export const PROTOCOL_VERSION = '1.0.0';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

export type Category =
  | 'bug'
  | 'regression'
  | 'security'
  | 'contract'
  | 'incomplete_change'
  | 'missing_test'
  | 'undocumented_behavior'
  | 'operational';

export interface Finding {
  finding_id: string;
  severity: Severity;
  confidence: number;
  category: Category;
  file: string;
  line?: number | null;
  start_line?: number | null;
  claim: string;
  evidence: string;
  failure_mode: string;
  suggested_fix: string;
  corroboration_count: number;
  corroborating_evidence?: string[];
}

export type CritiqueAction =
  | 'SUPPORT'
  | 'CHALLENGE'
  | 'ADD_EVIDENCE'
  | 'LOWER_SEVERITY'
  | 'RAISE_SEVERITY'
  | 'MARK_DUPLICATE'
  | 'REQUEST_INVESTIGATION';

export interface Critique {
  finding_id: string;
  action: CritiqueAction;
  reasoning: string;
  evidence?: string | null;
  suggested_severity?: Severity | null;
  duplicate_of?: string | null;
}

export type ResolutionStatus =
  | 'RESOLVED'
  | 'STILL_VALID'
  | 'PARTIALLY_RESOLVED'
  | 'WITHDRAWN'
  | 'NEEDS_MORE_EVIDENCE';

export interface Resolution {
  finding_id: string;
  status: ResolutionStatus;
  reasoning: string;
  evidence?: string | null;
  reviewed_sha?: string | null;
}

export interface Verdict {
  protocol_version: string;
  reviewed_sha: string;
  base_sha?: string | null;
  coverage: string;
  candidate_count: number;
  rejected_count: number;
  published_findings: Finding[];
  unresolved_uncertainty?: string[];
  coverage_limitations?: string[];
  complete: boolean;
}

/** Leonardo's per-finding adjudication, before it is folded into a Verdict. */
export type VerdictDecisionKind =
  | 'PUBLISH'
  | 'REJECT'
  | 'MERGE_FINDINGS'
  | 'DOWNGRADE'
  | 'UPGRADE'
  | 'REQUEST_MORE_INVESTIGATION';

export interface VerdictDecision {
  finding_id: string;
  decision: VerdictDecisionKind;
  reasoning: string;
  severity?: Severity | null;
  merge_into?: string | null;
}
