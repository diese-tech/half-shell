import { describe, expect, it, vi } from 'vitest';

import { ReviewEngineRouter, type ReviewEngineApp } from './reviewEngine.js';
import type { RepoRef, ReviewJob } from './types.js';

const REPO: RepoRef = { owner: 'diese-tech', repo: 'half-shell' };

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    kind: 'review',
    depth: 'standard',
    repo: REPO,
    pullNumber: 42,
    installationId: 1,
    deliveryId: 'delivery-1',
    ...overrides,
  };
}

function fakeApp(): ReviewEngineApp & { enqueue: ReturnType<typeof vi.fn> } {
  return { enqueue: vi.fn().mockResolvedValue(undefined), idle: vi.fn().mockResolvedValue(undefined) };
}

describe('ReviewEngineRouter', () => {
  it('routes every job to v1 when v1 is selected, even with a council engine available', async () => {
    const v1 = fakeApp();
    const council = fakeApp();
    const router = new ReviewEngineRouter(v1, council, 'v1');

    await router.enqueue(job({ kind: 'review' }));
    await router.enqueue(job({ kind: 'explain' }));

    expect(v1.enqueue).toHaveBeenCalledTimes(2);
    expect(council.enqueue).not.toHaveBeenCalled();
  });

  it('routes a review job to council when council is selected', async () => {
    const v1 = fakeApp();
    const council = fakeApp();
    const router = new ReviewEngineRouter(v1, council, 'council');

    await router.enqueue(job({ kind: 'review' }));

    expect(council.enqueue).toHaveBeenCalledTimes(1);
    expect(v1.enqueue).not.toHaveBeenCalled();
  });

  it('still routes verify/reconsider/explain to v1 even when council is selected — council has no lane for them yet', async () => {
    const v1 = fakeApp();
    const council = fakeApp();
    const router = new ReviewEngineRouter(v1, council, 'council');

    await router.enqueue(job({ kind: 'verify' }));
    await router.enqueue(job({ kind: 'reconsider' }));
    await router.enqueue(job({ kind: 'explain' }));

    expect(v1.enqueue).toHaveBeenCalledTimes(3);
    expect(council.enqueue).not.toHaveBeenCalled();
  });

  it('refuses to construct with council selected but no council engine provided', () => {
    const v1 = fakeApp();
    expect(() => new ReviewEngineRouter(v1, undefined, 'council')).toThrow(/council/i);
  });

  it('idle() waits for both engines', async () => {
    const v1 = fakeApp();
    const council = fakeApp();
    const router = new ReviewEngineRouter(v1, council, 'council');

    await router.idle();

    expect(v1.idle).toHaveBeenCalledTimes(1);
    expect(council.idle).toHaveBeenCalledTimes(1);
  });
});
