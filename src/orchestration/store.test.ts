import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OrchestrationStore } from './store.js';
import type { CouncilFinding, EvidencePacket, ReviewRun, Verdict } from './types.js';

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

describe('OrchestrationStore', () => {
  let store: OrchestrationStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'half-shell-orch-store-'));
    store = new OrchestrationStore(join(dir, 'orch.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a review run', async () => {
    await store.saveReviewRun(run());
    expect(await store.getReviewRun('rev_1')).toEqual(run());
  });

  it('returns undefined for a run that does not exist', async () => {
    expect(await store.getReviewRun('nope')).toBeUndefined();
  });

  it('lists every run recorded for a pull request, in insertion order', async () => {
    await store.saveReviewRun(run({ id: 'rev_1', generation: 1 }));
    await store.saveReviewRun(run({ id: 'rev_2', generation: 2, headSha: 'sha2' }));
    const runs = await store.listRunsForPullRequest('repo_1', 12);
    expect(runs.map((r) => r.id)).toEqual(['rev_1', 'rev_2']);
  });

  it('scopes listRunsForPullRequest to the exact repository and PR number', async () => {
    await store.saveReviewRun(run({ id: 'rev_1' }));
    await store.saveReviewRun(run({ id: 'rev_other_pr', pullRequestNumber: 99 }));
    const runs = await store.listRunsForPullRequest('repo_1', 12);
    expect(runs.map((r) => r.id)).toEqual(['rev_1']);
  });

  it('round-trips findings for a review', async () => {
    const finding: CouncilFinding = {
      id: 'finding_1',
      reviewId: 'rev_1',
      sourcePersona: 'raph',
      category: 'regression',
      claim: 'x',
      evidence: 'y',
      affectedCode: { file: 'src/a.ts', line: 1, startLine: null },
      consequence: 'z',
      confidence: 0.5,
      status: 'candidate',
      reproduction: null,
      proposedFix: null,
      severity: null,
      historicalContext: null,
      relatedFindings: [],
      corroboration: null,
      rootCause: null,
    };
    await store.saveFinding(finding);
    expect(await store.getFinding('finding_1')).toEqual(finding);
    expect(await store.listFindings('rev_1')).toEqual([finding]);
  });

  it('round-trips an evidence packet, one per review', async () => {
    const packet: EvidencePacket = {
      reviewId: 'rev_1',
      facts: [],
      sources: [],
      relevance: [],
      inferences: [],
      unknowns: [],
      statedIntent: '',
      unresolvedContext: [],
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    await store.saveEvidencePacket(packet);
    expect(await store.getEvidencePacket('rev_1')).toEqual(packet);
  });

  it('round-trips a verdict, one per review', async () => {
    const verdict: Verdict = {
      reviewId: 'rev_1',
      reviewer: 'leonardo',
      overallOutcome: 'clean_review',
      rationale: 'nothing material',
      findings: [],
      unresolvedUncertainty: [],
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    await store.saveVerdict(verdict);
    expect(await store.getVerdict('rev_1')).toEqual(verdict);
  });

  it('persists across instances pointing at the same file', async () => {
    const path = join(dir, 'nested', 'orch.db');
    const first = new OrchestrationStore(path);
    await first.saveReviewRun(run());
    first.close();

    const second = new OrchestrationStore(path);
    expect(await second.getReviewRun('rev_1')).toBeDefined();
    second.close();
  });
});
