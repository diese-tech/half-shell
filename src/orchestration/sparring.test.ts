import { describe, expect, it } from 'vitest';

import { SparringChallengeTracker, type ChallengeAttempt } from './sparring.js';

function attempt(overrides: Partial<ChallengeAttempt> = {}): ChallengeAttempt {
  return {
    findingId: 'finding_1',
    targetClaim: 'the call site is reachable',
    weakness: 'no evidence it is ever invoked in production',
    evidenceRequired: 'a trace showing the call site executes',
    respondsToNewEvidence: false,
    ...overrides,
  };
}

describe('SparringChallengeTracker — budget enforcement', () => {
  it('accepts challenges within the initial budget', () => {
    const tracker = new SparringChallengeTracker({ initialChallengesPerFinding: 3, followUpRounds: 1, extendOnlyIfNewEvidence: true });
    for (let i = 0; i < 3; i += 1) {
      const decision = tracker.evaluate(attempt({ weakness: `weakness ${i}` }));
      expect(decision.accepted).toBe(true);
      tracker.recordChallenge(attempt({ weakness: `weakness ${i}` }));
    }
    expect(tracker.challengesRaised('finding_1')).toBe(3);
  });

  it('rejects a challenge past budget with no new evidence', () => {
    const tracker = new SparringChallengeTracker({ initialChallengesPerFinding: 1, followUpRounds: 0, extendOnlyIfNewEvidence: true });
    tracker.recordChallenge(attempt({ weakness: 'first' }));
    const decision = tracker.evaluate(attempt({ weakness: 'second', respondsToNewEvidence: false }));
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toMatch(/budget exhausted/);
  });

  it('grants exactly one follow-up round when new evidence justifies it, and no more', () => {
    const tracker = new SparringChallengeTracker({ initialChallengesPerFinding: 1, followUpRounds: 1, extendOnlyIfNewEvidence: true });
    tracker.recordChallenge(attempt({ weakness: 'first' }));

    const followUp = tracker.evaluate(attempt({ weakness: 'second, prompted by new evidence', respondsToNewEvidence: true }));
    expect(followUp.accepted).toBe(true);
    tracker.recordChallenge(attempt({ weakness: 'second, prompted by new evidence', respondsToNewEvidence: true }));

    const secondFollowUp = tracker.evaluate(attempt({ weakness: 'third, also new evidence', respondsToNewEvidence: true }));
    expect(secondFollowUp.accepted).toBe(false);
  });

  it('never grants a follow-up round without new evidence, even with rounds remaining', () => {
    const tracker = new SparringChallengeTracker({ initialChallengesPerFinding: 1, followUpRounds: 2, extendOnlyIfNewEvidence: true });
    tracker.recordChallenge(attempt({ weakness: 'first' }));
    const decision = tracker.evaluate(attempt({ weakness: 'second', respondsToNewEvidence: false }));
    expect(decision.accepted).toBe(false);
  });

  it('tracks budgets per finding independently', () => {
    const tracker = new SparringChallengeTracker({ initialChallengesPerFinding: 1, followUpRounds: 0, extendOnlyIfNewEvidence: true });
    tracker.recordChallenge(attempt({ findingId: 'finding_a' }));
    const decision = tracker.evaluate(attempt({ findingId: 'finding_b' }));
    expect(decision.accepted).toBe(true);
  });

  it('rejects a malformed challenge without consuming budget', () => {
    const tracker = new SparringChallengeTracker({ initialChallengesPerFinding: 1, followUpRounds: 0, extendOnlyIfNewEvidence: true });
    const decision = tracker.evaluate(attempt({ weakness: '' }));
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toMatch(/malformed/);
    expect(tracker.challengesRaised('finding_1')).toBe(0);
    // Budget is untouched, so a real challenge right after still gets through.
    expect(tracker.evaluate(attempt()).accepted).toBe(true);
  });
});

describe('SparringChallengeTracker — goalpost rule', () => {
  it('rejects an objection restating the same claim and weakness already raised', () => {
    const tracker = new SparringChallengeTracker({ initialChallengesPerFinding: 3, followUpRounds: 1, extendOnlyIfNewEvidence: true });
    tracker.recordChallenge(attempt());
    const restated = tracker.evaluate(attempt({ targetClaim: '  THE call SITE is  reachable ', weakness: 'No Evidence It Is Ever Invoked In Production' }));
    expect(restated.accepted).toBe(false);
    expect(restated.reason).toMatch(/goalpost/);
  });

  it('accepts a genuinely different weakness against the same claim', () => {
    const tracker = new SparringChallengeTracker({ initialChallengesPerFinding: 3, followUpRounds: 1, extendOnlyIfNewEvidence: true });
    tracker.recordChallenge(attempt({ weakness: 'no evidence it is reachable' }));
    const different = tracker.evaluate(attempt({ weakness: 'the proposed fix does not address the root cause' }));
    expect(different.accepted).toBe(true);
  });
});
