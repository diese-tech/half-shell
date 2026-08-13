/**
 * Sparring's Shredder challenge budget (Issue #12 section 9), enforced in
 * code. This is deliberately not "ask the model nicely to stop" — a
 * challenge past budget, or one that restates an already-answered
 * objection, is rejected here before it ever reaches a model call.
 */

export interface ChallengeBudgetConfig {
  initialChallengesPerFinding: number;
  followUpRounds: number;
  extendOnlyIfNewEvidence: boolean;
}

export const DEFAULT_CHALLENGE_BUDGET: ChallengeBudgetConfig = {
  initialChallengesPerFinding: 3,
  followUpRounds: 1,
  extendOnlyIfNewEvidence: true,
};

/**
 * A challenge must name what it targets. Issue #11's rule: every challenge
 * states (1) the exact claim challenged, (2) the specific weakness, (3)
 * what evidence would answer it. A challenge missing any of those is
 * malformed and never consumes budget — it's a validation failure, not an
 * adversarial move.
 */
export interface ChallengeAttempt {
  findingId: string;
  targetClaim: string;
  weakness: string;
  evidenceRequired: string;
  /** True only when this challenge follows evidence submitted since the finding's last answered/accepted challenge. */
  respondsToNewEvidence: boolean;
}

export interface ChallengeDecision {
  accepted: boolean;
  reason: string;
}

interface FindingChallengeState {
  count: number;
  /** Normalized (claim, weakness) signatures already raised, to catch goalpost shifting / repeated objections in different words. */
  raisedSignatures: Set<string>;
}

function signature(attempt: ChallengeAttempt): string {
  return `${normalize(attempt.targetClaim)}::${normalize(attempt.weakness)}`;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isWellFormed(attempt: ChallengeAttempt): boolean {
  return [attempt.targetClaim, attempt.weakness, attempt.evidenceRequired].every(
    (field) => field.trim().length > 0,
  );
}

/**
 * Tracks Shredder's challenge budget across one Sparring phase (one
 * instance per review run). Stateful by design — the budget is a running
 * total per finding across however many challenge/response rounds occur.
 */
export class SparringChallengeTracker {
  private readonly state = new Map<string, FindingChallengeState>();

  constructor(private readonly budget: ChallengeBudgetConfig = DEFAULT_CHALLENGE_BUDGET) {}

  /** Decides whether a proposed challenge may proceed, without mutating state — call recordChallenge() after a decision to accept. */
  evaluate(attempt: ChallengeAttempt): ChallengeDecision {
    if (!isWellFormed(attempt)) {
      return {
        accepted: false,
        reason: 'malformed challenge: must state the exact claim, the specific weakness, and what evidence would answer it',
      };
    }

    const existing = this.state.get(attempt.findingId);
    const sig = signature(attempt);

    if (existing?.raisedSignatures.has(sig)) {
      return {
        accepted: false,
        reason: 'goalpost rule: this objection (same claim, same weakness) has already been raised for this finding',
      };
    }

    const countSoFar = existing?.count ?? 0;
    if (countSoFar < this.budget.initialChallengesPerFinding) {
      return { accepted: true, reason: 'within initial challenge budget' };
    }

    const followUpBudgetSpent = countSoFar - this.budget.initialChallengesPerFinding;
    const withinFollowUpRounds = followUpBudgetSpent < this.budget.followUpRounds;
    const newEvidenceSatisfied = !this.budget.extendOnlyIfNewEvidence || attempt.respondsToNewEvidence;

    if (withinFollowUpRounds && newEvidenceSatisfied) {
      return { accepted: true, reason: 'follow-up round granted: new evidence changed the finding' };
    }

    return {
      accepted: false,
      reason: this.budget.extendOnlyIfNewEvidence && !attempt.respondsToNewEvidence
        ? 'challenge budget exhausted and no new evidence was presented to justify another round'
        : 'challenge budget exhausted for this finding',
    };
  }

  /** Records an accepted challenge. Callers must have gotten accepted:true from evaluate() first — recording a rejected attempt is a caller bug. */
  recordChallenge(attempt: ChallengeAttempt): void {
    const existing = this.state.get(attempt.findingId) ?? { count: 0, raisedSignatures: new Set<string>() };
    existing.count += 1;
    existing.raisedSignatures.add(signature(attempt));
    this.state.set(attempt.findingId, existing);
  }

  challengesRaised(findingId: string): number {
    return this.state.get(findingId)?.count ?? 0;
  }
}
