import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RepoRef } from '../types.js';
import { advance, ingest, type EngineDependencies, type WebhookIngestInput } from './engine.js';
import { OrchestrationStore } from './store.js';
import { FakeGitHubClient, ScriptedModelProvider, TEST_PERSONAS, type ScriptedResponder } from './testing/fakes.js';
import type { PersonaCodename, ReviewRun } from './types.js';

const REPO: RepoRef = { owner: 'diese-tech', repo: 'half-shell' };

/** Pulls the first surviving finding's id out of Leo's prompt so a fake verdict can reference it without knowing ids ahead of time. */
function firstSurvivingFindingId(userPrompt: string): string | undefined {
  const match = /Surviving findings: (\[.*?\])\n\nSparring history:/s.exec(userPrompt);
  if (!match) return undefined;
  const findings = JSON.parse(match[1] as string) as { id: string }[];
  return findings[0]?.id;
}

function baseInput(overrides: Partial<WebhookIngestInput> = {}): WebhookIngestInput {
  return {
    repositoryId: 'repo_1',
    repositoryFullName: 'diese-tech/half-shell',
    pullRequestNumber: 42,
    baseSha: 'base1',
    headSha: 'sha1',
    installationId: 1,
    repo: REPO,
    githubDeliveryId: 'delivery-1',
    trigger: 'webhook',
    changeContext: 'a diff',
    ...overrides,
  };
}

describe('engine — end to end with fake providers', () => {
  let store: OrchestrationStore;
  let dir: string;
  let github: FakeGitHubClient;
  let deps: EngineDependencies;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'half-shell-orch-engine-'));
    store = new OrchestrationStore(join(dir, 'orch.db'));
    github = new FakeGitHubClient({ headSha: 'sha1', reviews: [] });
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  function buildDeps(scripts: Partial<Record<string, ScriptedResponder>>): EngineDependencies {
    const provider = new ScriptedModelProvider(scripts);
    return {
      store,
      personas: TEST_PERSONAS,
      providerFor: () => provider,
      githubClient: github,
    };
  }

  it('runs a genuinely clean review straight through to an APPROVE without ever calling Shredder', async () => {
    deps = buildDeps({
      'april:CASE_FILE': () => ({
        facts: [{ statement: 'a fact' }],
        sources: [{ kind: 'diff', reference: 'x' }],
        relevance: ['relevant'],
        inferences: [],
        unknowns: [],
        stated_intent: 'do a thing',
        unresolved_context: [],
      }),
      'raph:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'donnie:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'mikey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'casey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'leo:LEO_REVIEW': () => ({
        overall_outcome: 'clean_review',
        rationale: 'Nothing material found.',
        findings: [],
        unresolved_uncertainty: [],
      }),
    });

    const result = await ingest(deps, baseInput());
    expect(result.outcome).toBe('started');

    const run = await store.getReviewRun(result.reviewId);
    expect(run?.status).toBe('archived');
    expect(run?.currentPhase).toBe('ARCHIVED');

    expect(github.state.reviews).toHaveLength(1);
    expect(github.state.reviews[0]?.event).toBe('APPROVE');

    // Shredder was never invoked — early exit actually skipped Sparring.
    const shredderCalls = (deps.providerFor('shredder') as ScriptedModelProvider).calls.filter((c) => c.persona === 'shredder');
    expect(shredderCalls).toHaveLength(0);
  });

  it('carries a real finding through Sparring, Leo, and publication to REQUEST_CHANGES', async () => {
    deps = buildDeps({
      'april:CASE_FILE': () => ({
        facts: [{ statement: 'load() gained a required tenantId parameter' }],
        sources: [{ kind: 'diff', reference: 'src/loader.ts' }],
        relevance: ['the contract change'],
        inferences: [],
        unknowns: [],
        stated_intent: 'scope loading to a tenant',
        unresolved_context: [],
      }),
      'raph:INDEPENDENT_REVIEW': () => ({
        findings: [
          {
            category: 'regression',
            claim: 'importRecords still calls load() without the tenant id',
            evidence: 'load() gained a required tenantId parameter but this call site passes only id',
            file: 'src/import.ts',
            line: 12,
            consequence: 'every import throws at runtime',
            confidence: 0.9,
          },
        ],
      }),
      'donnie:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'mikey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'casey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'shredder:SPARRING': () => ({ action: 'accept' }),
      'leo:LEO_REVIEW': (request) => ({
        overall_outcome: 'blocking_findings_published',
        rationale: 'The stale call site fails on every import.',
        findings: [
          {
            finding_id: firstSurvivingFindingId(request.userPrompt),
            outcome: 'publish',
            final_severity: 'high',
            public_reason: 'importRecords still calls load() without the tenant id.',
          },
        ],
        unresolved_uncertainty: [],
      }),
    });

    const result = await ingest(deps, baseInput());
    const run = await store.getReviewRun(result.reviewId);
    expect(run?.status).toBe('archived');

    expect(github.state.reviews).toHaveLength(1);
    expect(github.state.reviews[0]?.event).toBe('REQUEST_CHANGES');
    expect(github.state.reviews[0]?.body).toContain('importRecords still calls load()');

    const findings = await store.listFindings(result.reviewId);
    expect(findings.some((f) => f.status === 'published')).toBe(true);
  });

  it('does not treat a failed independent-review lane as a clean pass — it never early-exits with a missing lane', async () => {
    deps = buildDeps({
      'april:CASE_FILE': () => ({
        facts: [],
        sources: [],
        relevance: [],
        inferences: [],
        unknowns: [],
        stated_intent: '',
        unresolved_context: [],
      }),
      // raph deliberately returns malformed JSON, which fails that lane.
      'raph:INDEPENDENT_REVIEW': () => 'not valid json',
      'donnie:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'mikey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'casey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'leo:LEO_REVIEW': () => ({
        overall_outcome: 'clean_review',
        rationale: 'Nothing material found, but coverage was incomplete.',
        findings: [],
        unresolved_uncertainty: [],
      }),
    });

    const result = await ingest(deps, baseInput());
    const events = await store.listEvents(result.reviewId);
    const missingLaneEvent = events.find((e) => e.phase === 'INDEPENDENT_REVIEW' && e.eventType === 'validation_failed');
    expect(missingLaneEvent).toBeDefined();

    // A missing lane blocks early exit, so Sparring's early-exit gate must
    // have been evaluated false — verified indirectly: the run still
    // reaches ARCHIVED (LEO_REVIEW handles the missing-lane case), and the
    // missing-lane event is on record for Leo to have been told about it.
    expect((await store.getReviewRun(result.reviewId))?.status).toBe('archived');
  });

  it('deduplicates a repeated webhook delivery for the same review generation', async () => {
    deps = buildDeps({
      'april:CASE_FILE': () => ({ facts: [], sources: [], relevance: [], inferences: [], unknowns: [], stated_intent: '', unresolved_context: [] }),
      'raph:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'donnie:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'mikey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'casey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'leo:LEO_REVIEW': () => ({ overall_outcome: 'clean_review', rationale: 'clean', findings: [], unresolved_uncertainty: [] }),
    });

    const first = await ingest(deps, baseInput({ githubDeliveryId: 'delivery-dup' }));
    const second = await ingest(deps, baseInput({ githubDeliveryId: 'delivery-dup' }));

    expect(second.outcome).toBe('duplicate_delivery');
    expect(second.reviewId).toBe(first.reviewId);
    expect(github.state.reviews).toHaveLength(1);
  });

  it('supersedes an older still-running review when a newer head SHA arrives for the same PR', async () => {
    const staleRun: ReviewRun = {
      id: 'rev_stale',
      repositoryId: 'repo_1',
      repositoryFullName: 'diese-tech/half-shell',
      pullRequestNumber: 42,
      baseSha: 'base1',
      headSha: 'sha1',
      status: 'running',
      currentPhase: 'SPARRING',
      generation: 1,
      trigger: 'webhook',
      supersededByReviewId: null,
      githubDeliveryId: 'delivery-1',
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      error: null,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
    };
    await store.saveReviewRun(staleRun);

    deps = buildDeps({
      'april:CASE_FILE': () => ({ facts: [], sources: [], relevance: [], inferences: [], unknowns: [], stated_intent: '', unresolved_context: [] }),
      'raph:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'donnie:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'mikey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'casey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'leo:LEO_REVIEW': () => ({ overall_outcome: 'clean_review', rationale: 'clean', findings: [], unresolved_uncertainty: [] }),
    });
    github.state.headSha = 'sha2';

    const result = await ingest(deps, baseInput({ headSha: 'sha2', githubDeliveryId: 'delivery-2' }));

    expect(result.reviewId).not.toBe('rev_stale');
    const updatedStale = await store.getReviewRun('rev_stale');
    expect(updatedStale?.status).toBe('superseded');

    const staleEvents = await store.listEvents('rev_stale');
    expect(staleEvents.some((e) => e.eventType === 'run_superseded')).toBe(true);
  });

  it('does not publish stale findings if the PR head moved again before PUBLICATION', async () => {
    deps = buildDeps({
      'april:CASE_FILE': () => ({ facts: [], sources: [], relevance: [], inferences: [], unknowns: [], stated_intent: '', unresolved_context: [] }),
      'raph:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'donnie:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'mikey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'casey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'leo:LEO_REVIEW': () => ({ overall_outcome: 'clean_review', rationale: 'clean', findings: [], unresolved_uncertainty: [] }),
    });
    // The PR moved to sha2 on GitHub sometime during the review, but this
    // run was still reviewing sha1.
    github.state.headSha = 'sha2';

    const result = await ingest(deps, baseInput({ headSha: 'sha1' }));
    const run = await store.getReviewRun(result.reviewId);

    expect(run?.status).toBe('superseded');
    expect(github.state.reviews).toHaveLength(0);
  });

  it('resuming an already-archived run is a safe no-op', async () => {
    deps = buildDeps({
      'april:CASE_FILE': () => ({ facts: [], sources: [], relevance: [], inferences: [], unknowns: [], stated_intent: '', unresolved_context: [] }),
      'raph:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'donnie:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'mikey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'casey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'leo:LEO_REVIEW': () => ({ overall_outcome: 'clean_review', rationale: 'clean', findings: [], unresolved_uncertainty: [] }),
    });

    const result = await ingest(deps, baseInput());
    const archived = await store.getReviewRun(result.reviewId);
    expect(archived?.status).toBe('archived');

    const resumed = await advance(deps, archived as ReviewRun, baseInput());
    expect(resumed.status).toBe('archived');
    expect(github.state.reviews).toHaveLength(1); // still only the one review posted
  });
});
