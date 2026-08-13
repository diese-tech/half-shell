import { describe, expect, it } from 'vitest';

import { toCandidate, type RawFinding } from '../synthesis.js';
import { minimalPersonaConfig, ScriptedModelProvider } from '../testing/fakes.js';
import { applyLessons, MAX_HISTORICAL_CONTEXT_CHARS, runMentorship } from './mentorship.js';

function candidate(overrides: Partial<RawFinding> = {}) {
  return toCandidate('rev_1', {
    sourcePersona: 'raph',
    category: 'regression',
    claim: 'a claim',
    evidence: 'evidence',
    affectedCode: { file: 'src/a.ts', line: 1, startLine: null },
    consequence: 'breaks',
    confidence: 0.7,
    ...overrides,
  });
}

describe('runMentorship', () => {
  it('attaches a lesson only to the finding Splinter actually has history about', async () => {
    const findings = [candidate({ claim: 'first' }), candidate({ claim: 'second' })];
    const provider = new ScriptedModelProvider({}, () => ({
      lessons: [{ finding_index: 1, recurring: true, prior_finding_ids: ['finding_old'], lesson: 'we missed this exact pattern before' }],
      guardrail_recommendations: [],
    }));

    const result = await runMentorship(provider, minimalPersonaConfig({ codename: 'splinter' }), findings, 'history');
    expect(result.ok).toBe(true);
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0]?.findingIndex).toBe(1);

    const applied = applyLessons(findings, result.lessons);
    expect(applied[0]?.historicalContext).toBeNull();
    expect(applied[1]?.historicalContext?.recurring).toBe(true);
    expect(applied[1]?.historicalContext?.lesson).toContain('missed this exact pattern');
  });

  it("does not let history become proof: mentorship does not change a finding's status or confidence, only its historicalContext", async () => {
    const findings = [candidate({ claim: 'only one' })];
    const provider = new ScriptedModelProvider({}, () => ({
      lessons: [{ finding_index: 0, recurring: true, prior_finding_ids: ['finding_old'], lesson: 'seen this before' }],
      guardrail_recommendations: [],
    }));

    const result = await runMentorship(provider, minimalPersonaConfig({ codename: 'splinter' }), findings, 'history');
    const applied = applyLessons(findings, result.lessons);

    expect(applied[0]?.status).toBe(findings[0]?.status);
    expect(applied[0]?.confidence).toBe(findings[0]?.confidence);
    expect(applied[0]?.severity).toBeNull();
  });

  it('ignores an out-of-range finding_index rather than crashing or attaching it anywhere', async () => {
    const findings = [candidate()];
    const provider = new ScriptedModelProvider({}, () => ({
      lessons: [{ finding_index: 5, recurring: true, prior_finding_ids: [], lesson: 'out of range' }],
      guardrail_recommendations: [],
    }));
    const result = await runMentorship(provider, minimalPersonaConfig({ codename: 'splinter' }), findings, 'history');
    expect(result.lessons).toEqual([]);
  });

  it('does not call the model at all when there are no candidate findings', async () => {
    const provider = new ScriptedModelProvider();
    const result = await runMentorship(provider, minimalPersonaConfig({ codename: 'splinter' }), [], 'history');
    expect(result.ok).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it('bounds historical context rather than passing an unlimited amount to the model', async () => {
    const provider = new ScriptedModelProvider({}, () => ({ lessons: [], guardrail_recommendations: [] }));
    const hugeHistory = 'x'.repeat(MAX_HISTORICAL_CONTEXT_CHARS * 3);

    await runMentorship(provider, minimalPersonaConfig({ codename: 'splinter' }), [candidate()], hugeHistory);

    const sentPrompt = provider.calls[0]?.userPrompt ?? '';
    expect(sentPrompt.length).toBeLessThan(hugeHistory.length);
    expect(sentPrompt).toContain('truncated');
  });

  it('surfaces a guardrail recommendation independent of any specific finding', async () => {
    const provider = new ScriptedModelProvider({}, () => ({
      lessons: [],
      guardrail_recommendations: ['add a test that would have caught this class of bug'],
    }));
    const result = await runMentorship(provider, minimalPersonaConfig({ codename: 'splinter' }), [candidate()], 'history');
    expect(result.guardrailRecommendations).toEqual(['add a test that would have caught this class of bug']);
  });
});
