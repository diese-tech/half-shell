import { describe, expect, it } from 'vitest';

import { canPublish, isDuplicateDelivery, isSameGenerationAlreadyHandled, nextGeneration, runsToSupersede } from './identity.js';
import type { ReviewRun } from './types.js';

function run(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'rev_1',
    repositoryId: 'repo_1',
    repositoryFullName: 'diese-tech/half-shell',
    pullRequestNumber: 12,
    baseSha: 'base',
    headSha: 'sha1',
    status: 'running',
    currentPhase: 'CASE_FILE',
    generation: 1,
    trigger: 'webhook',
    supersededByReviewId: null,
    githubDeliveryId: 'delivery-1',
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    error: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('isDuplicateDelivery', () => {
  it('recognizes a delivery id already recorded on an existing run', () => {
    expect(isDuplicateDelivery([run({ githubDeliveryId: 'delivery-1' })], 'delivery-1')).toBe(true);
  });

  it('is not fooled by a null delivery id', () => {
    expect(isDuplicateDelivery([run({ githubDeliveryId: null })], null)).toBe(false);
  });

  it('does not flag a genuinely new delivery', () => {
    expect(isDuplicateDelivery([run({ githubDeliveryId: 'delivery-1' })], 'delivery-2')).toBe(false);
  });
});

describe('isSameGenerationAlreadyHandled', () => {
  it('is true when a run already exists for this exact head SHA', () => {
    expect(isSameGenerationAlreadyHandled([run({ headSha: 'sha1' })], 'sha1')).toBe(true);
  });

  it('is false for a new head SHA', () => {
    expect(isSameGenerationAlreadyHandled([run({ headSha: 'sha1' })], 'sha2')).toBe(false);
  });
});

describe('runsToSupersede', () => {
  it('supersedes only active runs at an older head SHA', () => {
    const older = run({ id: 'rev_old', headSha: 'sha1', status: 'running' });
    const alreadyDone = run({ id: 'rev_done', headSha: 'sha0', status: 'archived' });
    expect(runsToSupersede([older, alreadyDone], 'sha2')).toEqual([older]);
  });

  it('never supersedes a run already at the incoming head SHA', () => {
    const current = run({ headSha: 'sha2', status: 'running' });
    expect(runsToSupersede([current], 'sha2')).toEqual([]);
  });
});

describe('nextGeneration', () => {
  it('starts at 1 with no prior runs', () => {
    expect(nextGeneration([])).toBe(1);
  });

  it('increments past the highest existing generation', () => {
    expect(nextGeneration([run({ generation: 1 }), run({ generation: 3 })])).toBe(4);
  });
});

describe('canPublish', () => {
  it('allows publishing when the head SHA still matches and the run is active', () => {
    expect(canPublish(run({ headSha: 'sha1', status: 'running' }), 'sha1')).toBe(true);
  });

  it('blocks publishing once the PR has moved to a newer head SHA', () => {
    expect(canPublish(run({ headSha: 'sha1', status: 'running' }), 'sha2')).toBe(false);
  });

  it('blocks publishing on a run that is no longer active', () => {
    expect(canPublish(run({ headSha: 'sha1', status: 'superseded' }), 'sha1')).toBe(false);
  });
});
