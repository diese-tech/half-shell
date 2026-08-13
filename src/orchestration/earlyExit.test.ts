import { describe, expect, it } from 'vitest';

import { canEarlyExit, type EarlyExitInputs } from './earlyExit.js';

function clean(overrides: Partial<EarlyExitInputs> = {}): EarlyExitInputs {
  return {
    caseFileComplete: true,
    allRequiredLanesCleanAndComplete: true,
    noUnresolvedContext: true,
    noMaterialObservations: true,
    noGuardrailOrHistoryTrigger: true,
    ...overrides,
  };
}

describe('canEarlyExit', () => {
  it('allows early exit when every condition holds', () => {
    expect(canEarlyExit(clean())).toBe(true);
  });

  it('blocks early exit when a lane is missing or failed', () => {
    expect(canEarlyExit(clean({ allRequiredLanesCleanAndComplete: false }))).toBe(false);
  });

  it('blocks early exit when April has an unresolved unknown', () => {
    expect(canEarlyExit(clean({ noUnresolvedContext: false }))).toBe(false);
  });

  it('blocks early exit when any specialist raised a material observation', () => {
    expect(canEarlyExit(clean({ noMaterialObservations: false }))).toBe(false);
  });

  it('blocks early exit when Splinter found a guardrail or history trigger', () => {
    expect(canEarlyExit(clean({ noGuardrailOrHistoryTrigger: false }))).toBe(false);
  });

  it('blocks early exit when CASE_FILE never completed', () => {
    expect(canEarlyExit(clean({ caseFileComplete: false }))).toBe(false);
  });

  it('never exits early on file-type reasoning alone — a docs-only PR still needs every condition explicitly true', () => {
    // The inputs intentionally have no "looks like docs" field at all: the
    // policy has nothing to short-circuit on except the five real signals.
    const docsLookingButUnresolved = clean({ noUnresolvedContext: false });
    expect(canEarlyExit(docsLookingButUnresolved)).toBe(false);
  });
});
