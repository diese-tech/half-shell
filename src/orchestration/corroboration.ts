/**
 * Corroboration and correlated-reasoning rules (Issue #12 section 8).
 * Reviewer count is never itself evidence — these rules distinguish a
 * shared assumption repeated by several reviewers from genuinely
 * independent confirmation.
 */
import type { Corroboration, CorroborationEffect, CorroborationType, PersonaCodename } from './types.js';

/**
 * One specialist's contribution toward a candidate group of findings that
 * synthesis believes describe the same underlying issue.
 */
export interface CorroboratingClaim {
  sourcePersona: PersonaCodename;
  /**
   * A normalized identifier for the concrete evidence behind the claim
   * (e.g. a hash of the cited test name + line, or the specific
   * reproduction). Two claims sharing an evidenceKey used the same
   * evidence; different keys mean genuinely distinct evidence paths.
   */
  evidenceKey: string;
  /**
   * True when the claim cites no concrete evidence of its own — it is
   * repeating a premise (e.g. "this looks unsafe") rather than pointing at
   * something checkable.
   */
  isUnsupportedAssumption: boolean;
}

const EFFECT_BY_TYPE: Record<CorroborationType, CorroborationEffect> = {
  shared_assumption: 'no_confidence_gain',
  repeated_unsupported_assumption: 'confidence_penalty',
  independent_same_evidence: 'small_confidence_gain',
  independent_distinct_evidence: 'strong_confidence_gain',
};

/**
 * Classifies a group of claims that synthesis has already decided describe
 * the same finding. A single claim has nothing to corroborate against, so
 * callers should only invoke this for groups of two or more.
 */
export function classifyCorroboration(claims: CorroboratingClaim[]): Corroboration {
  if (claims.length < 2) {
    throw new Error('classifyCorroboration requires at least two claims to compare');
  }

  const contributingSourcePersonas = [...new Set(claims.map((c) => c.sourcePersona))];
  const distinctEvidenceKeys = new Set(claims.map((c) => c.evidenceKey));
  const anyUnsupported = claims.some((c) => c.isUnsupportedAssumption);
  const allUnsupported = claims.every((c) => c.isUnsupportedAssumption);

  let type: CorroborationType;
  if (allUnsupported) {
    // Every claim in the group cites no real evidence. If they're at least
    // pointing at literally the same thing, it's a shared assumption; if
    // multiple independent reviewers stated the same unsupported claim
    // without evidence, that's worse, not better — flag the penalty.
    type = contributingSourcePersonas.length > 1 ? 'repeated_unsupported_assumption' : 'shared_assumption';
  } else if (anyUnsupported) {
    // A mix — treat conservatively as a shared assumption rather than
    // rewarding a poorly-evidenced claim just because one contributor did
    // better than the others.
    type = 'shared_assumption';
  } else if (distinctEvidenceKeys.size === 1) {
    type = 'independent_same_evidence';
  } else {
    type = 'independent_distinct_evidence';
  }

  return {
    type,
    confidenceEffect: EFFECT_BY_TYPE[type],
    contributingSourcePersonas,
  };
}

/** Applies a corroboration effect to a base confidence, clamped to [0, 1]. */
export function applyCorroborationEffect(baseConfidence: number, effect: CorroborationEffect): number {
  const delta: Record<CorroborationEffect, number> = {
    no_confidence_gain: 0,
    confidence_penalty: -0.15,
    small_confidence_gain: 0.05,
    strong_confidence_gain: 0.15,
  };
  return Math.min(1, Math.max(0, baseConfidence + delta[effect]));
}
