import { describe, expect, it } from 'vitest';

import { minimalPersonaConfig, throwingProvider, ScriptedModelProvider } from '../testing/fakes.js';
import type { ModelProvider } from '../provider.js';
import type { PersonaCodename } from '../types.js';
import { INDEPENDENT_REVIEWERS, runIndependentReview } from './independentReview.js';

const CHANGE = [
  'Description: fix totals',
  'Changed files (line numbers are the head-side truth):',
  '',
  '--- src/a.ts (modified, +1/-0)',
  '        @@ -2,1 +2,2 @@',
  '    2   import { items } from "./items";',
  '    3 + const total = items.length;',
  '',
  '--- src/b.ts (added, +1/-0)',
  '    1 + export const elsewhere = "only in b.ts";',
].join('\n');

describe('independent review provenance gate', () => {
  it('keeps grounded findings and drops the rest with a reason, before they can reach Sparring', async () => {
    const finding = { category: 'security', claim: 'no escaping', evidence: 'looks unsafe', file: 'src/a.ts', line: 3, consequence: 'XSS', confidence: 1 };
    const provider = new ScriptedModelProvider({}, () => ({
      findings: [
        { ...finding, claim: 'invented', quote: 'res.end(userInput);' },
        { ...finding, claim: 'unquoted' },
        { ...finding, claim: 'wrong file', quote: 'export const elsewhere = "only in b.ts";' },
        { ...finding, claim: 'grounded', quote: 'const total = items.length;' },
      ],
    }));
    const [outcome] = await runIndependentReview(() => provider, (codename) => minimalPersonaConfig({ codename }), CHANGE);
    expect(outcome?.findings.map((f) => f.claim)).toEqual(['grounded']);
    expect(outcome?.findings[0]?.evidence).toContain('Quoted: const total = items.length;');
    expect(outcome?.dropped.map((d) => [d.claim, d.reason])).toEqual([
      ['invented', 'ungrounded_quote'],
      ['unquoted', 'ungrounded_quote'],
      ['wrong file', 'provenance_mismatch'],
    ]);
  });
});

describe('runIndependentReview', () => {
  it('runs all four specialists and normalizes their findings', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      findings: [
        {
          category: 'regression',
          claim: 'a real finding',
          evidence: 'proof',
          quote: 'const total = items.length;',
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
      CHANGE,
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
        null,
        { category: 'regression', claim: 'valid one', evidence: 'proof', quote: 'const total = items.length;', consequence: 'breaks', file: 'src/a.ts', confidence: 0.5 },
      ],
    }));
    const outcomes = await runIndependentReview(() => provider, (codename) => minimalPersonaConfig({ codename }), CHANGE);
    expect(outcomes[0]?.findings).toHaveLength(1);
    expect(outcomes[0]?.findings[0]?.claim).toBe('valid one');
    // Discarded output is never invisible: each malformed item is a recorded drop.
    expect(outcomes[0]?.dropped.map((d) => [d.reason, d.detail])).toEqual([
      ['malformed_finding', 'missing or invalid: evidence, consequence'],
      ['malformed_finding', 'missing or invalid: category, file, claim, evidence, consequence'],
    ]);
  });

  it('lets Casey submit an observation with no root cause — root_cause is optional, not required', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      findings: [
        {
          category: 'operational_abuse',
          claim: 'hitting the endpoint twice writes twice',
          evidence: 'reproduced by calling it back to back',
          quote: 'const total = items.length;',
          file: 'src/a.ts',
          line: 3,
          consequence: 'duplicate records',
          confidence: 0.6,
          root_cause: null,
        },
      ],
    }));
    const outcomes = await runIndependentReview(() => provider, (codename) => minimalPersonaConfig({ codename }), CHANGE);
    const outcome = outcomes.find((o) => o.persona === 'casey');
    expect(outcome?.ok).toBe(true);
    expect(outcome?.findings[0]?.rootCause).toBeNull();
    expect(outcome?.findings[0]?.claim).toContain('twice writes twice');
  });
});
