import { describe, expect, it } from 'vitest';

import { minimalPersonaConfig, ScriptedModelProvider } from '../testing/fakes.js';
import { runCaseFile } from './caseFile.js';

describe('runCaseFile', () => {
  it('keeps facts, inferences, and unknowns in separate labeled buckets — an inference never becomes a fact', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      facts: [{ statement: 'load() gained a required tenantId parameter.' }],
      sources: [{ kind: 'diff', reference: 'src/loader.ts@abc123' }],
      relevance: ['This is the contract change every caller must satisfy.'],
      inferences: [{ statement: 'The author likely missed src/import.ts.', basis: 'It is not mentioned in the PR description.' }],
      unknowns: [{ question: 'Are there other unlisted callers?', why_it_matters: 'Would change the scope.' }],
      stated_intent: 'Scope record loading to a tenant.',
      unresolved_context: [],
    }));

    const result = await runCaseFile(provider, minimalPersonaConfig({ codename: 'april' }), 'rev_1', 'the diff');
    expect(result.ok).toBe(true);
    expect(result.packet?.facts).toEqual([{ statement: 'load() gained a required tenantId parameter.' }]);
    expect(result.packet?.inferences[0]?.statement).toContain('likely missed');
    expect(result.packet?.inferences[0]?.basis).toBeDefined();
    // The inference never leaks into facts, and vice versa.
    expect(result.packet?.facts.some((f) => f.statement.includes('likely missed'))).toBe(false);
  });

  it('accepts an empty unknowns list — an incomplete picture is still a valid, honest result', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      facts: [{ statement: 'fact' }],
      sources: [{ kind: 'diff', reference: 'x' }],
      relevance: ['relevant'],
      inferences: [],
      unknowns: [],
      stated_intent: '',
      unresolved_context: [],
    }));
    const result = await runCaseFile(provider, minimalPersonaConfig({ codename: 'april' }), 'rev_1', 'ctx');
    expect(result.ok).toBe(true);
    expect(result.packet?.unknowns).toEqual([]);
    expect(result.packet?.statedIntent).toBe('');
  });

  it('never fabricates intent — an empty stated_intent from the model passes straight through, not a guessed default', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      facts: [],
      sources: [],
      relevance: [],
      inferences: [],
      unknowns: [{ question: 'What is this PR actually trying to do?' }],
      stated_intent: '',
      unresolved_context: ['no PR description was provided'],
    }));
    const result = await runCaseFile(provider, minimalPersonaConfig({ codename: 'april' }), 'rev_1', 'ctx');
    expect(result.ok).toBe(true);
    expect(result.packet?.statedIntent).toBe('');
    expect(result.packet?.unresolvedContext).toContain('no PR description was provided');
  });

  it('retries once on malformed JSON, then succeeds on a valid response', async () => {
    let attempts = 0;
    const provider = new ScriptedModelProvider({}, () => {
      attempts += 1;
      if (attempts === 1) return 'not json at all';
      return {
        facts: [{ statement: 'ok' }],
        sources: [{ kind: 'diff', reference: 'x' }],
        relevance: ['ok'],
        inferences: [],
        unknowns: [],
        stated_intent: '',
        unresolved_context: [],
      };
    });
    const result = await runCaseFile(provider, minimalPersonaConfig({ codename: 'april' }), 'rev_1', 'ctx');
    expect(result.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it('fails cleanly after exhausting retries on a response that never validates', async () => {
    const provider = new ScriptedModelProvider({}, () => 'still not json');
    const result = await runCaseFile(provider, minimalPersonaConfig({ codename: 'april' }), 'rev_1', 'ctx');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
