import { describe, expect, it } from 'vitest';

import { toCandidate } from '../synthesis.js';
import { DEFAULT_CHALLENGE_BUDGET, SparringChallengeTracker } from '../sparring.js';
import { minimalPersonaConfig, ScriptedModelProvider } from '../testing/fakes.js';
import { spar } from './sparring.js';

function candidate() {
  return toCandidate('rev_1', {
    sourcePersona: 'raph',
    category: 'regression',
    claim: 'the stale call site is reachable',
    evidence: 'it is in the diff and unconditionally invoked',
    affectedCode: { file: 'src/import.ts', line: 12, startLine: null },
    consequence: 'every import throws',
    confidence: 0.7,
  });
}

describe('spar', () => {
  it('marks a finding as surviving when Shredder accepts immediately', async () => {
    const shredder = new ScriptedModelProvider({}, () => ({ action: 'accept' }));
    const raph = new ScriptedModelProvider({}, () => ({ action: 'defend' }));

    const outcome = await spar(shredder, minimalPersonaConfig({ codename: 'shredder' }), raph, minimalPersonaConfig({ codename: 'raph' }), candidate());

    expect(outcome.finding.status).toBe('surviving_sparring');
    expect(outcome.challengesRaised).toBe(0);
  });

  it('withdraws a finding when the defender concedes', async () => {
    const shredder = new ScriptedModelProvider({}, () => ({
      action: 'challenge',
      target_claim: 'reachability',
      weakness: 'no evidence this path executes',
      evidence_required: 'a trace',
    }));
    const raph = new ScriptedModelProvider({}, () => ({ action: 'withdraw' }));

    const outcome = await spar(shredder, minimalPersonaConfig({ codename: 'shredder' }), raph, minimalPersonaConfig({ codename: 'raph' }), candidate());

    expect(outcome.finding.status).toBe('withdrawn');
  });

  it('narrows a finding\'s claim when the defender narrows instead of fully defending', async () => {
    const shredder = new ScriptedModelProvider({}, () => ({
      action: 'challenge',
      target_claim: 'scope',
      weakness: 'the claim is broader than the evidence',
      evidence_required: 'a narrower claim',
    }));
    const raph = new ScriptedModelProvider({}, () => ({ action: 'narrow', narrowed_claim: 'a smaller, fully-supported claim' }));

    const outcome = await spar(shredder, minimalPersonaConfig({ codename: 'shredder' }), raph, minimalPersonaConfig({ codename: 'raph' }), candidate());

    expect(outcome.finding.status).toBe('narrowed');
    expect(outcome.finding.claim).toBe('a smaller, fully-supported claim');
  });

  it('never lets the loop run longer than the configured budget allows, even if Shredder keeps challenging', async () => {
    let shredderCalls = 0;
    const shredder = new ScriptedModelProvider({}, () => {
      shredderCalls += 1;
      return {
        action: 'challenge',
        target_claim: `claim variant ${shredderCalls}`,
        weakness: `weakness variant ${shredderCalls}`,
        evidence_required: 'more evidence',
      };
    });
    const raph = new ScriptedModelProvider({}, () => ({ action: 'defend', additional_evidence: 'new evidence each time' }));

    const budget = { initialChallengesPerFinding: 2, followUpRounds: 1, extendOnlyIfNewEvidence: true };
    const tracker = new SparringChallengeTracker(budget);
    const outcome = await spar(shredder, minimalPersonaConfig({ codename: 'shredder' }), raph, minimalPersonaConfig({ codename: 'raph' }), candidate(), tracker, budget);

    // At most initialChallengesPerFinding + followUpRounds challenges can
    // ever be *accepted*, regardless of how many times Shredder tries.
    expect(outcome.challengesRaised).toBeLessThanOrEqual(budget.initialChallengesPerFinding + budget.followUpRounds);
    // The loop terminates — this assertion running at all proves it did.
    expect(outcome.finding.status).not.toBe('candidate');
  });

  it('records a malformed Shredder response as a validation failure instead of silently treating it as acceptance', async () => {
    const shredder = new ScriptedModelProvider({}, () => 'this is not valid json at all');
    const raph = new ScriptedModelProvider({}, () => ({ action: 'defend' }));

    const outcome = await spar(shredder, minimalPersonaConfig({ codename: 'shredder' }), raph, minimalPersonaConfig({ codename: 'raph' }), candidate());

    // The finding still resolves safely (fail-safe default is "accept"),
    // but the malformed response is on record, not invisible.
    expect(outcome.finding.status).toBe('surviving_sparring');
    expect(outcome.transcriptEvents.some((e) => e.content.includes('validation_failed'))).toBe(true);
  });

  it('shares one tracker across findings so budgets are enforced per finding across the whole Sparring phase', async () => {
    const shredder = new ScriptedModelProvider({}, () => ({
      action: 'challenge',
      target_claim: 'x',
      weakness: 'y',
      evidence_required: 'z',
    }));
    const raph = new ScriptedModelProvider({}, () => ({ action: 'defend', additional_evidence: null }));

    const tracker = new SparringChallengeTracker(DEFAULT_CHALLENGE_BUDGET);
    const findingA = candidate();
    const findingB = candidate();

    await spar(shredder, minimalPersonaConfig({ codename: 'shredder' }), raph, minimalPersonaConfig({ codename: 'raph' }), findingA, tracker);
    await spar(shredder, minimalPersonaConfig({ codename: 'shredder' }), raph, minimalPersonaConfig({ codename: 'raph' }), findingB, tracker);

    expect(tracker.challengesRaised(findingA.id)).toBeGreaterThan(0);
    expect(tracker.challengesRaised(findingB.id)).toBeGreaterThan(0);
    // Each finding got its own budget — one finding's challenges didn't eat into the other's.
    expect(tracker.challengesRaised(findingA.id)).toBeLessThanOrEqual(DEFAULT_CHALLENGE_BUDGET.initialChallengesPerFinding + DEFAULT_CHALLENGE_BUDGET.followUpRounds);
  });
});
