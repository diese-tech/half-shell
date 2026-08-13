import { describe, expect, it } from 'vitest';

import { applyCorroborationEffect, classifyCorroboration, type CorroboratingClaim } from './corroboration.js';

function claim(overrides: Partial<CorroboratingClaim>): CorroboratingClaim {
  return { sourcePersona: 'raph', evidenceKey: 'evidence-a', isUnsupportedAssumption: false, ...overrides };
}

describe('classifyCorroboration', () => {
  it('gives independent reviewers citing distinct evidence a strong confidence gain', () => {
    // The Issue #12 worked example: Raph reproduces a duplicate-write path,
    // Donnie independently traces the non-atomic state dependency that
    // causes it. Different evidence, same underlying bug.
    const result = classifyCorroboration([
      claim({ sourcePersona: 'raph', evidenceKey: 'duplicate-write-repro' }),
      claim({ sourcePersona: 'donnie', evidenceKey: 'non-atomic-state-trace' }),
    ]);
    expect(result.type).toBe('independent_distinct_evidence');
    expect(result.confidenceEffect).toBe('strong_confidence_gain');
    expect(result.contributingSourcePersonas).toEqual(['raph', 'donnie']);
  });

  it('gives independent reviewers citing the exact same evidence only a small gain', () => {
    const result = classifyCorroboration([
      claim({ sourcePersona: 'raph', evidenceKey: 'same-test-name' }),
      claim({ sourcePersona: 'mikey', evidenceKey: 'same-test-name' }),
    ]);
    expect(result.type).toBe('independent_same_evidence');
    expect(result.confidenceEffect).toBe('small_confidence_gain');
  });

  it('penalizes multiple reviewers repeating one unsupported assumption', () => {
    const result = classifyCorroboration([
      claim({ sourcePersona: 'raph', isUnsupportedAssumption: true }),
      claim({ sourcePersona: 'casey', isUnsupportedAssumption: true }),
      claim({ sourcePersona: 'mikey', isUnsupportedAssumption: true }),
    ]);
    expect(result.type).toBe('repeated_unsupported_assumption');
    expect(result.confidenceEffect).toBe('confidence_penalty');
  });

  it('does not treat reviewer count as evidence on its own — three unsupported claims is one unsupported argument', () => {
    const twoReviewers = classifyCorroboration([
      claim({ sourcePersona: 'raph', isUnsupportedAssumption: true }),
      claim({ sourcePersona: 'casey', isUnsupportedAssumption: true }),
    ]);
    const threeReviewers = classifyCorroboration([
      claim({ sourcePersona: 'raph', isUnsupportedAssumption: true }),
      claim({ sourcePersona: 'casey', isUnsupportedAssumption: true }),
      claim({ sourcePersona: 'mikey', isUnsupportedAssumption: true }),
    ]);
    // Same classification and same effect regardless of how many reviewers piled on.
    expect(twoReviewers.type).toBe(threeReviewers.type);
    expect(twoReviewers.confidenceEffect).toBe(threeReviewers.confidenceEffect);
  });

  it('gives no gain to a single persona repeating their own assumption without evidence', () => {
    const result = classifyCorroboration([
      claim({ sourcePersona: 'raph', isUnsupportedAssumption: true }),
      claim({ sourcePersona: 'raph', isUnsupportedAssumption: true }),
    ]);
    expect(result.type).toBe('shared_assumption');
    expect(result.confidenceEffect).toBe('no_confidence_gain');
  });

  it('requires at least two claims', () => {
    expect(() => classifyCorroboration([claim({})])).toThrow();
  });
});

describe('applyCorroborationEffect', () => {
  it('clamps to [0, 1]', () => {
    expect(applyCorroborationEffect(0.95, 'strong_confidence_gain')).toBeLessThanOrEqual(1);
    expect(applyCorroborationEffect(0.05, 'confidence_penalty')).toBeGreaterThanOrEqual(0);
  });

  it('leaves confidence untouched for no_confidence_gain', () => {
    expect(applyCorroborationEffect(0.5, 'no_confidence_gain')).toBe(0.5);
  });
});
