import { describe, expect, it } from 'vitest';

import { minimalPersonaConfig, throwingProvider, ScriptedModelProvider } from '../testing/fakes.js';
import type { ModelProvider } from '../provider.js';
import type { PersonaCodename } from '../types.js';
import { INDEPENDENT_REVIEWERS, runIndependentReview } from './independentReview.js';

describe('runIndependentReview', () => {
  it('runs all four specialists and normalizes their findings', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      findings: [
        {
          category: 'regression',
          claim: 'a real finding',
          evidence: 'proof',
          file: 'src/a.ts',
          line: 3,
          consequence: 'it breaks',
          confidence: 0.7,
        },
      ],
    }));

    const outcomes = await runIndependentReview(
      () => provider,
      (codename) => minimalPersonaConfig({ codename }),
      'the diff',
    );

    expect(outcomes).toHaveLength(4);
    expect(outcomes.map((o) => o.persona).sort()).toEqual([...INDEPENDENT_REVIEWERS].sort());
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
      expect(outcome.findings).toHaveLength(1);
      expect(outcome.findings[0]?.claim).toBe('a real finding');
    }
  });

  it('never lets one specialist see another\'s output — every lane gets the exact same context, nothing more', async () => {
    const provider = new ScriptedModelProvider();
    await runIndependentReview(() => provider, (codename) => minimalPersonaConfig({ codename }), 'shared context only');
    for (const call of provider.calls) {
      expect(call.userPrompt).toBe('shared context only');
    }
  });

  it('records a failed lane as missing, not as a clean empty result', async () => {
    const providerFor = (persona: PersonaCodename): ModelProvider =>
      persona === 'raph' ? throwingProvider : new ScriptedModelProvider({}, () => ({ findings: [] }));

    const outcomes = await runIndependentReview(providerFor, (codename) => minimalPersonaConfig({ codename }), 'the diff');

    const raphOutcome = outcomes.find((o) => o.persona === 'raph');
    expect(raphOutcome?.ok).toBe(false);
    expect(raphOutcome?.error).toBeDefined();
    expect(raphOutcome?.findings).toEqual([]);

    // The other three lanes are unaffected by Raph's failure.
    const others = outcomes.filter((o) => o.persona !== 'raph');
    expect(others.every((o) => o.ok)).toBe(true);
  });

  it('discards a malformed finding (missing required fields) without discarding the whole lane', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      findings: [
        { category: 'regression', claim: 'missing evidence and consequence', file: 'src/a.ts' },
        { category: 'regression', claim: 'valid one', evidence: 'proof', consequence: 'breaks', file: 'src/a.ts', confidence: 0.5 },
      ],
    }));
    const outcomes = await runIndependentReview(() => provider, (codename) => minimalPersonaConfig({ codename }), 'ctx');
    expect(outcomes[0]?.findings).toHaveLength(1);
    expect(outcomes[0]?.findings[0]?.claim).toBe('valid one');
  });

  it('lets Casey submit an observation with no root cause — root_cause is optional, not required', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      findings: [
        {
          category: 'operational_abuse',
          claim: 'hitting the endpoint twice writes twice',
          evidence: 'reproduced by calling it back to back',
          file: 'src/handler.ts',
          line: 9,
          consequence: 'duplicate records',
          confidence: 0.6,
          root_cause: null,
        },
      ],
    }));
    const outcomes = await runIndependentReview(() => provider, (codename) => minimalPersonaConfig({ codename }), 'ctx');
    const outcome = outcomes.find((o) => o.persona === 'casey');
    expect(outcome?.ok).toBe(true);
    expect(outcome?.findings[0]?.rootCause).toBeNull();
    expect(outcome?.findings[0]?.claim).toContain('twice writes twice');
  });
});
