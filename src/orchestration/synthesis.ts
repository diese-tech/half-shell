/**
 * SYNTHESIS (Issue #12 section 7). Normalizes candidate findings from
 * INDEPENDENT_REVIEW before Sparring, without deciding which survive:
 * deduplicates literal repeats, links distinct findings that describe the
 * same underlying defect while preserving each one's own evidence, and
 * computes corroboration. Deliberately has no persona lead — Issue #12
 * lists a lead for every phase except this one, because grouping and
 * dedup is orchestrator bookkeeping, not council judgment.
 *
 * Operates on CouncilFinding records that already have stable ids (minted
 * when INDEPENDENT_REVIEW's raw output is first persisted) rather than
 * minting new ones here — a finding's identity survives synthesis, which
 * keeps the whole pipeline resumable from stored rows instead of needing a
 * separate raw-findings table.
 */
import { classifyCorroboration, type CorroboratingClaim } from './corroboration.js';
import { newFindingId } from './ids.js';
import type { Corroboration, CouncilFinding, FindingCategory, PersonaCodename } from './types.js';

export interface RawFinding {
  sourcePersona: PersonaCodename;
  category: FindingCategory;
  claim: string;
  evidence: string;
  affectedCode: { file: string; line: number | null; startLine: number | null };
  consequence: string;
  confidence: number;
  reproduction?: string | null;
  proposedFix?: string | null;
  rootCause?: string | null;
  /**
   * Normalized identifier for the concrete evidence behind this claim.
   * Defaults to the evidence text itself (trimmed/lowercased) when the
   * caller doesn't supply one — good enough to tell "cited the exact same
   * test" from "cited a different one" without requiring semantic
   * comparison synthesis doesn't have the information to do reliably.
   */
  evidenceKey?: string;
  isUnsupportedAssumption?: boolean;
}

/** Turns one specialist's raw output into a stored candidate finding with a permanent id. */
export function toCandidate(reviewId: string, raw: RawFinding): CouncilFinding {
  return {
    id: newFindingId(),
    reviewId,
    sourcePersona: raw.sourcePersona,
    category: raw.category,
    claim: raw.claim,
    evidence: raw.evidence,
    affectedCode: raw.affectedCode,
    consequence: raw.consequence,
    confidence: raw.confidence,
    status: 'candidate',
    reproduction: raw.reproduction ?? null,
    proposedFix: raw.proposedFix ?? null,
    severity: null,
    historicalContext: null,
    relatedFindings: [],
    corroboration: null,
    rootCause: raw.rootCause ?? null,
  };
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function groupKey(finding: CouncilFinding): string {
  return `${finding.affectedCode.file}::${finding.category}`;
}

function toClaim(finding: CouncilFinding, evidenceKeyOverride?: Map<string, string>): CorroboratingClaim {
  return {
    sourcePersona: finding.sourcePersona,
    evidenceKey: evidenceKeyOverride?.get(finding.id) ?? normalize(finding.evidence),
    isUnsupportedAssumption: finding.evidence.trim().length === 0,
  };
}

function applyEffect(base: number, effect: Corroboration['confidenceEffect']): number {
  const delta: Record<Corroboration['confidenceEffect'], number> = {
    no_confidence_gain: 0,
    confidence_penalty: -0.15,
    small_confidence_gain: 0.05,
    strong_confidence_gain: 0.15,
  };
  return Math.min(1, Math.max(0, base + delta[effect]));
}

/**
 * Groups candidate findings that touch the same file + category, then:
 *  - collapses claims that are literally the same statement: the first
 *    keeps its id and becomes canonical, the rest are marked "merged"
 *    pointing at it via relatedFindings, and every contributing persona is
 *    recorded in the canonical finding's corroboration
 *  - keeps claims that reach the same area but say something different as
 *    separate, linked findings — each keeps its own id and evidence, and
 *    both carry the same corroboration classification
 *  - a finding alone in its group is returned unchanged — nothing to
 *    compare it against yet
 */
export function synthesize(findings: CouncilFinding[]): CouncilFinding[] {
  const groups = new Map<string, CouncilFinding[]>();
  for (const finding of findings) {
    const key = groupKey(finding);
    const bucket = groups.get(key) ?? [];
    bucket.push(finding);
    groups.set(key, bucket);
  }

  const results: CouncilFinding[] = [];

  for (const group of groups.values()) {
    const byClaim = new Map<string, CouncilFinding[]>();
    for (const finding of group) {
      const key = normalize(finding.claim);
      const bucket = byClaim.get(key) ?? [];
      bucket.push(finding);
      byClaim.set(key, bucket);
    }
    const distinctClaimGroups = [...byClaim.values()];

    if (distinctClaimGroups.length === 1) {
      const [canonical, ...duplicates] = distinctClaimGroups[0] as CouncilFinding[];
      if (duplicates.length === 0) {
        results.push(canonical as CouncilFinding);
        continue;
      }
      const claims = [canonical as CouncilFinding, ...duplicates].map((f) => toClaim(f));
      const corroboration = classifyCorroboration(claims);
      results.push({
        ...(canonical as CouncilFinding),
        confidence: applyEffect((canonical as CouncilFinding).confidence, corroboration.confidenceEffect),
        corroboration,
      });
      for (const duplicate of duplicates) {
        results.push({ ...duplicate, status: 'merged', relatedFindings: [(canonical as CouncilFinding).id] });
      }
      continue;
    }

    // Multiple genuinely different claims about the same file+category —
    // link them rather than picking a winner. Each keeps its own id and evidence.
    const canonicalPerClaim = distinctClaimGroups.map((dupes) => dupes[0] as CouncilFinding);
    const claims = canonicalPerClaim.map((f) => toClaim(f));
    const corroboration = classifyCorroboration(claims);
    const ids = canonicalPerClaim.map((f) => f.id);
    canonicalPerClaim.forEach((finding, index) => {
      const relatedFindings = ids.filter((_, j) => j !== index);
      results.push({
        ...finding,
        confidence: applyEffect(finding.confidence, corroboration.confidenceEffect),
        relatedFindings,
        corroboration,
      });
      // Any literal duplicates of this particular claim, beyond the first, still merge into it.
      const dupesOfThisClaim = (distinctClaimGroups[index] as CouncilFinding[]).slice(1);
      for (const duplicate of dupesOfThisClaim) {
        results.push({ ...duplicate, status: 'merged', relatedFindings: [finding.id] });
      }
    });
  }

  return results;
}

/** The view Sparring's participants actually see — no source_persona, no internal lineage. */
export interface AnonymousFindingView {
  id: string;
  category: FindingCategory;
  claim: string;
  evidence: string;
  affectedCode: CouncilFinding['affectedCode'];
  consequence: string;
  confidence: number;
  proposedFix: string | null;
}

export function anonymize(finding: CouncilFinding): AnonymousFindingView {
  return {
    id: finding.id,
    category: finding.category,
    claim: finding.claim,
    evidence: finding.evidence,
    affectedCode: finding.affectedCode,
    consequence: finding.consequence,
    confidence: finding.confidence,
    proposedFix: finding.proposedFix,
  };
}
