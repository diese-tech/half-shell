import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeGitHubClient } from '../testing/fakes.js';
import { OrchestrationStore } from '../store.js';
import type { ReviewRun, Verdict } from '../types.js';
import { determineOutcome, publish, renderReviewBody } from './publication.js';

const REPO = { owner: 'diese-tech', repo: 'half-shell' };

function run(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'rev_1',
    repositoryId: 'repo_1',
    repositoryFullName: 'diese-tech/half-shell',
    pullRequestNumber: 12,
    baseSha: 'base',
    headSha: 'sha1',
    status: 'running',
    currentPhase: 'PUBLICATION',
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

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    reviewId: 'rev_1',
    reviewer: 'leonardo',
    overallOutcome: 'blocking_findings_published',
    rationale: 'One stale call site fails on every import.',
    findings: [{ findingId: 'finding_1', outcome: 'publish', finalSeverity: 'high', publicReason: 'Fails on every import.' }],
    unresolvedUncertainty: [],
    createdAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('determineOutcome', () => {
  it('maps a blocking-severity published finding to REQUEST_CHANGES', () => {
    expect(determineOutcome(verdict())).toBe('REQUEST_CHANGES');
  });

  it('maps a published-but-non-blocking finding to COMMENT', () => {
    const v = verdict({ findings: [{ findingId: 'f1', outcome: 'publish', finalSeverity: 'low', publicReason: 'minor' }] });
    expect(determineOutcome(v)).toBe('COMMENT');
  });

  it('maps no publishable findings to APPROVE', () => {
    const v = verdict({ findings: [{ findingId: 'f1', outcome: 'reject', finalSeverity: null, publicReason: 'not material' }] });
    expect(determineOutcome(v)).toBe('APPROVE');
  });

  it('respects a configured blocking threshold', () => {
    const v = verdict({ findings: [{ findingId: 'f1', outcome: 'publish', finalSeverity: 'medium', publicReason: 'x' }] });
    expect(determineOutcome(v, { blockingSeverityThreshold: 'medium' })).toBe('REQUEST_CHANGES');
    expect(determineOutcome(v, { blockingSeverityThreshold: 'critical' })).toBe('COMMENT');
  });
});

describe('renderReviewBody — public output excludes internal chatter', () => {
  it('includes only published findings and the verdict rationale', () => {
    const body = renderReviewBody(verdict());
    expect(body).toContain('Fails on every import.');
    expect(body).toContain('One stale call site fails on every import.');
  });

  it('never mentions rejected findings or their reasoning in the public body', () => {
    const v = verdict({
      findings: [
        { findingId: 'f1', outcome: 'publish', finalSeverity: 'high', publicReason: 'the published one' },
        { findingId: 'f2', outcome: 'reject', finalSeverity: null, publicReason: 'internal reasoning for rejecting f2' },
      ],
    });
    const body = renderReviewBody(v);
    expect(body).toContain('the published one');
    expect(body).not.toContain('internal reasoning for rejecting f2');
  });
});

describe('publish', () => {
  let store: OrchestrationStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'half-shell-orch-publish-'));
    store = new OrchestrationStore(join(dir, 'orch.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('publishes and archives the run when the head SHA still matches', async () => {
    const client = new FakeGitHubClient({ headSha: 'sha1', reviews: [] });
    const result = await publish(store, client, run(), verdict(), 1, REPO);
    expect(result.outcome).toBe('published');
    expect(result.githubReviewOutcome).toBe('REQUEST_CHANGES');
    expect(client.state.reviews).toHaveLength(1);

    const stored = await store.getReviewRun('rev_1');
    expect(stored?.status).toBe('archived');
    expect(stored?.currentPhase).toBe('ARCHIVED');
  });

  it('refuses to publish stale findings against a newer PR revision', async () => {
    const client = new FakeGitHubClient({ headSha: 'sha2', reviews: [] });
    const result = await publish(store, client, run({ headSha: 'sha1' }), verdict(), 1, REPO);
    expect(result.outcome).toBe('superseded_stale_sha');
    expect(client.state.reviews).toHaveLength(0);

    const stored = await store.getReviewRun('rev_1');
    expect(stored?.status).toBe('superseded');
  });

  it('is idempotent: a second publish attempt for an already-published run does not post twice', async () => {
    const client = new FakeGitHubClient({ headSha: 'sha1', reviews: [] });
    await publish(store, client, run(), verdict(), 1, REPO);
    const secondAttempt = await publish(store, client, run(), verdict(), 1, REPO);

    expect(secondAttempt.outcome).toBe('already_published');
    expect(client.state.reviews).toHaveLength(1);
  });

  it('retries publication after a simulated failure without re-deciding the verdict', async () => {
    // Seeded the way the real engine would have it: the run row already
    // exists from ingest(), long before PUBLICATION runs.
    await store.saveReviewRun(run());

    let calls = 0;
    const client = new FakeGitHubClient({ headSha: 'sha1', reviews: [] });
    const originalCreateReview = client.createReview.bind(client);
    client.createReview = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated GitHub 500');
      return originalCreateReview(...args);
    };

    await expect(publish(store, client, run(), verdict(), 1, REPO)).rejects.toThrow();
    // The run is still active (never marked archived by the failed attempt).
    expect((await store.getReviewRun('rev_1'))?.status).toBe('running');

    const retried = await publish(store, client, run(), verdict(), 1, REPO);
    expect(retried.outcome).toBe('published');
    expect(client.state.reviews).toHaveLength(1);
  });
});
