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
    changeContext: 'Changed files (line numbers are the head-side truth):\n\n--- src/import.ts (modified, +1/-0)\n   12 +   return ids.map((id) => load(id));',
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

  it('runs a genuinely clean review straight through to a clean COMMENT, still inviting Shredder to confirm it', async () => {
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
      'shredder:SPARRING': () => ({ concurs: true, note: 'nothing here warrants a challenge' }),
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
    // Half-Shell never grants APPROVE (review-policy.md D004) — a clean
    // review is still a themed COMMENT.
    expect(github.state.reviews[0]?.event).toBe('COMMENT');
    expect(github.state.reviews[0]?.body).toContain('Shell clear');

    // Early exit skips the per-finding challenge loop, but Shredder — a
    // required role in every review (D050) — still has to actually weigh in
    // once, even with nothing concrete to challenge.
    const shredderCalls = (deps.providerFor('shredder') as ScriptedModelProvider).calls.filter((c) => c.persona === 'shredder');
    expect(shredderCalls).toHaveLength(1);
  });

  it('refuses to publish a clean verdict when Shredder never actually confirmed it (early exit, confirmation call failed)', async () => {
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
      // Shredder's clean-review confirmation does not parse.
      'shredder:SPARRING': () => 'not valid json',
      'leo:LEO_REVIEW': () => ({
        overall_outcome: 'clean_review',
        rationale: 'Nothing material found.',
        findings: [],
        unresolved_uncertainty: [],
      }),
    });

    const result = await ingest(deps, baseInput());
    const verdict = await store.getVerdict(result.reviewId);
    expect(verdict?.overallOutcome).toBe('incomplete');
    expect(github.state.reviews[0]?.event).toBe('COMMENT');
    expect(github.state.reviews[0]?.body).not.toContain('Shell clear');
  });

  it('refuses to publish a clean verdict when Shredder objects during early exit', async () => {
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
      'shredder:SPARRING': () => ({ concurs: false, note: 'the lanes missed the auth bypass in src/x.ts' }),
      'leo:LEO_REVIEW': () => ({
        overall_outcome: 'clean_review',
        rationale: 'Nothing material found.',
        findings: [],
        unresolved_uncertainty: [],
      }),
    });

    const result = await ingest(deps, baseInput());
    const verdict = await store.getVerdict(result.reviewId);
    expect(verdict?.overallOutcome).toBe('incomplete');
    expect(github.state.reviews[0]?.event).toBe('COMMENT');
    expect(github.state.reviews[0]?.body).not.toContain('Shell clear');
  });

  function realFindingScript(leoOverallOutcome: string): Partial<Record<string, ScriptedResponder>> {
    return {
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
            quote: 'return ids.map((id) => load(id));',
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
      'shredder:SYNTHESIS': () => ({ verdict: 'SUPPORTS', reason: 'the call site passes only id' }),
      'shredder:SPARRING': () => ({ action: 'accept' }),
      'leo:LEO_REVIEW': (request) => ({
        overall_outcome: leoOverallOutcome,
        rationale: 'The stale call site fails on every import.',
        findings: [
          {
            finding_id: firstSurvivingFindingId(request.userPrompt),
            outcome: 'publish',
            final_severity: 'high',
            public_reason: 'importRecords still calls load() without the tenant id.',
            blocking: true,
            blocking_reason: 'every import throws at runtime',
          },
        ],
        unresolved_uncertainty: [],
      }),
    };
  }

  it('carries a real finding through Sparring, Leo, and publication to REQUEST_CHANGES', async () => {
    deps = buildDeps(realFindingScript('blocking_findings_published'));

    const result = await ingest(deps, baseInput());
    const run = await store.getReviewRun(result.reviewId);
    expect(run?.status).toBe('archived');

    expect(github.state.reviews).toHaveLength(1);
    expect(github.state.reviews[0]?.event).toBe('REQUEST_CHANGES');
    expect(github.state.reviews[0]?.body).toContain('importRecords still calls load()');

    const findings = await store.listFindings(result.reviewId);
    expect(findings.some((f) => f.status === 'published')).toBe(true);
  });

  it('persists a finding as published when a complete review actually publishes it', async () => {
    deps = buildDeps(realFindingScript('blocking_findings_published'));

    const result = await ingest(deps, baseInput());

    const [finding] = await store.listFindings(result.reviewId);
    expect(finding?.status).toBe('published');
    expect(github.state.reviews[0]?.body).toContain('importRecords still calls load()');
    const decision = (await store.getVerdict(result.reviewId))?.findings.find((d) => d.findingId === finding?.id);
    expect(decision?.outcome).toBe('publish');
  });

  it('never persists published when the PR head moved and nothing was posted', async () => {
    deps = buildDeps(realFindingScript('blocking_findings_published'));
    github.state.headSha = 'moved-on';

    const result = await ingest(deps, baseInput());

    expect(github.state.reviews).toHaveLength(0);
    const [finding] = await store.listFindings(result.reviewId);
    expect(finding?.status).not.toBe('published');
    // Each of Leo's publish decisions is recorded as suppressed, not just the run-level supersession.
    const suppressed = (await store.listEvents(result.reviewId)).filter((e) => e.metadata?.['publication'] === 'suppressed');
    expect(suppressed.map((e) => [e.findingId, e.metadata?.['reason']])).toEqual([[finding?.id, 'stale_head']]);
  });

  it('keeps persisted state consistent with GitHub when a coverage gap (no quarantine) forces incomplete', async () => {
    const script = realFindingScript('non_blocking_findings_published');
    deps = buildDeps({
      ...script,
      'donnie:INDEPENDENT_REVIEW': () => {
        throw new Error('lane provider down');
      },
      'leo:LEO_REVIEW': (request) => {
        const decision = (script['leo:LEO_REVIEW'] as ScriptedResponder)(request) as { findings: Record<string, unknown>[] };
        return { ...decision, findings: decision.findings.map((f) => ({ ...f, blocking: false, blocking_reason: null })) };
      },
    });

    const result = await ingest(deps, baseInput());

    const verdict = await store.getVerdict(result.reviewId);
    expect(verdict?.overallOutcome).toBe('incomplete');
    expect(verdict?.coverageGap).toContain('required independent-review lane failed');
    const [finding] = await store.listFindings(result.reviewId);
    // Leo's decision survives as adjudication history; the effective publication does not.
    expect(verdict?.findings.find((d) => d.findingId === finding?.id)?.outcome).toBe('publish');
    expect(finding?.status).not.toBe('published');
    expect(github.state.reviews[0]?.event).toBe('COMMENT');
    expect(github.state.reviews[0]?.body).not.toContain('importRecords still calls load()');
    // Leo's rationale describes the suppressed finding; an incomplete review publishes only the coverage gap.
    expect(github.state.reviews[0]?.body).not.toContain("Leo's verdict");
    expect(github.state.reviews[0]?.body).toContain('Required coverage was incomplete');
    const suppressed = (await store.listEvents(result.reviewId)).find((e) => e.findingId === finding?.id && e.metadata?.['publication'] === 'suppressed');
    expect(suppressed?.metadata).toMatchObject({ leoOutcome: 'publish', reason: 'review_incomplete' });
  });

  it('records each provenance drop as an event with its reason, and never makes it a candidate', async () => {
    const script = realFindingScript('blocking_findings_published');
    deps = buildDeps({
      ...script,
      'raph:INDEPENDENT_REVIEW': () => ({
        findings: [
          { category: 'security', claim: 'wrong file', evidence: 'e', quote: 'return ids.map((id) => load(id));', file: 'docs/deployment.md', line: 103, consequence: 'c', confidence: 1 },
        ],
      }),
    });

    const result = await ingest(deps, baseInput());

    expect(await store.listFindings(result.reviewId)).toEqual([]);
    const drop = (await store.listEvents(result.reviewId)).find((e) => e.eventType === 'finding_withdrawn');
    expect(drop?.phase).toBe('INDEPENDENT_REVIEW');
    expect(drop?.metadata).toMatchObject({ reason: 'provenance_mismatch', persona: 'raph', file: 'docs/deployment.md' });
  });

  it.each([
    ['CONTRADICTS', 'semantic_contradiction'],
    ['INSUFFICIENT', 'insufficient_evidence'],
  ])('rejects a %s finding before Sparring, recording why', async (verdict, reason) => {
    deps = buildDeps({ ...realFindingScript('blocking_findings_published'), 'shredder:SYNTHESIS': () => ({ verdict, reason: 'because' }) });

    const result = await ingest(deps, baseInput());

    const [finding] = await store.listFindings(result.reviewId);
    expect(finding?.status).toBe('rejected');
    const events = await store.listEvents(result.reviewId);
    const withdrawn = events.find((e) => e.eventType === 'finding_withdrawn' && e.findingId === finding?.id);
    expect(withdrawn).toMatchObject({ phase: 'SYNTHESIS', actor: 'shredder', metadata: { reason, verification: verdict } });
    expect(events.some((e) => e.phase === 'SPARRING' && e.findingId === finding?.id)).toBe(false);
    expect(github.state.reviews[0]?.event).not.toBe('REQUEST_CHANGES');
  });

  /** A case file with an open unknown, so a review left with zero survivors cannot take the early exit. */
  const OPEN_CASE_FILE = () => ({
    facts: [{ statement: 'load() gained a required tenantId parameter' }],
    sources: [{ kind: 'diff', reference: 'src/import.ts' }],
    relevance: ['the contract change'],
    inferences: [],
    unknowns: [{ question: 'whether legacy callers still pass only an id' }],
    stated_intent: 'scope loading to a tenant',
    unresolved_context: [],
  });
  const CLEAN_LEO = () => ({ overall_outcome: 'clean_review', rationale: 'nothing survived', findings: [], unresolved_uncertainty: [] });

  function zeroSurvivorScript(shredderSays: object): Partial<Record<string, ScriptedResponder>> {
    return {
      ...realFindingScript('clean_review'),
      'april:CASE_FILE': OPEN_CASE_FILE,
      'shredder:SYNTHESIS': () => ({ verdict: 'CONTRADICTS', reason: 'the call site passes the tenant' }),
      'shredder:SPARRING': () => shredderSays,
      'leo:LEO_REVIEW': CLEAN_LEO,
    };
  }

  it('quarantines a finding whose verifier gives no valid verdict: never published, review incomplete', async () => {
    // Leo never sees the quarantined finding, so from where Leo sits nothing survived.
    deps = buildDeps({ ...realFindingScript('blocking_findings_published'), 'shredder:SYNTHESIS': () => 'not json at all', 'leo:LEO_REVIEW': CLEAN_LEO });

    const result = await ingest(deps, baseInput());

    const [finding] = await store.listFindings(result.reviewId);
    expect(finding?.status).toBe('quarantined');
    const events = await store.listEvents(result.reviewId);
    expect(events.find((e) => e.eventType === 'finding_updated' && e.findingId === finding?.id)?.metadata).toMatchObject({ verification: 'unavailable', reason: 'verifier_unavailable' });
    expect(events.some((e) => e.phase === 'SPARRING' && e.findingId === finding?.id)).toBe(false);
    expect((await store.getVerdict(result.reviewId))?.overallOutcome).toBe('incomplete');
    expect(github.state.reviews[0]?.event).toBe('COMMENT');
    expect(github.state.reviews[0]?.body).not.toContain('importRecords still calls load()');
    // Leo's rationale describes the suppressed finding; an incomplete review publishes only the coverage gap.
    expect(github.state.reviews[0]?.body).not.toContain("Leo's verdict");
    expect(github.state.reviews[0]?.body).toContain('Required coverage was incomplete');
  });

  it('forces the review incomplete on any quarantine, even when another verified blocking finding publishes', async () => {
    const script = realFindingScript('blocking_findings_published');
    deps = buildDeps({
      ...script,
      'donnie:INDEPENDENT_REVIEW': () => ({
        findings: [{ category: 'contract', claim: 'second claim on the same call', evidence: 'e', quote: 'return ids.map((id) => load(id));', file: 'src/import.ts', line: 12, consequence: 'c', confidence: 0.8 }],
      }),
      'shredder:SYNTHESIS': (request) => (request.userPrompt.includes('second claim') ? 'garbage' : { verdict: 'SUPPORTS', reason: 'only id is passed' }),
    });

    const result = await ingest(deps, baseInput());

    const findings = await store.listFindings(result.reviewId);
    expect(findings.map((f) => f.status).sort()).toContain('quarantined');
    const verdict = await store.getVerdict(result.reviewId);
    expect(verdict?.overallOutcome).toBe('incomplete');
    expect(github.state.reviews[0]?.event).toBe('COMMENT');

    // The verified finding Leo chose to publish: Leo's decision is kept, but
    // GitHub received no finding, so persisted state must not claim one.
    const verified = findings.find((f) => f.status !== 'quarantined');
    expect(verdict?.findings.find((d) => d.findingId === verified?.id)?.outcome).toBe('publish');
    expect(verified?.status).not.toBe('published');
    expect(findings.some((f) => f.status === 'published')).toBe(false);
    expect(github.state.reviews[0]?.body).not.toContain('importRecords still calls load()');
    // Leo's rationale describes the suppressed finding; an incomplete review publishes only the coverage gap.
    expect(github.state.reviews[0]?.body).not.toContain("Leo's verdict");
    expect(github.state.reviews[0]?.body).toContain('Required coverage was incomplete');
    expect((await store.listEvents(result.reviewId)).some((e) => e.findingId === verified?.id && e.metadata?.['publication'] === 'suppressed')).toBe(true);
  });

  it('with zero survivors, a clean verdict still requires Shredder to CONCUR_CLEAN on the case file', async () => {
    deps = buildDeps(zeroSurvivorScript({ result: 'CONCUR_CLEAN', note: 'the unknown does not block merge-readiness' }));

    const result = await ingest(deps, baseInput());

    const completion = (await store.listEvents(result.reviewId)).find((e) => e.phase === 'SPARRING' && e.actor === 'shredder');
    expect(completion).toMatchObject({ eventType: 'challenge_accepted', metadata: { completion: 'CONCUR_CLEAN' } });
    expect((await store.getVerdict(result.reviewId))?.overallOutcome).toBe('clean_review');
    expect(github.state.reviews[0]?.body).toContain('Shell clear');
  });

  it.each([
    ['OBJECT', { result: 'OBJECT', note: 'the legacy caller path was never examined' }, 'objected'],
    ['INSUFFICIENT_COVERAGE', { result: 'INSUFFICIENT_COVERAGE', note: 'too much was dropped' }, 'coverage insufficient'],
    ['an invalid answer', { concurs: true }, 'never completed'],
  ])('with zero survivors, %s from Shredder makes the review incomplete, never clean', async (_label, shredderSays, why) => {
    deps = buildDeps(zeroSurvivorScript(shredderSays));

    const result = await ingest(deps, baseInput());

    const verdict = await store.getVerdict(result.reviewId);
    expect(verdict?.overallOutcome).toBe('incomplete');
    expect(verdict?.coverageGap).toContain(why);
    expect(github.state.reviews[0]?.body).not.toContain('Shell clear');
  });

  it('with zero survivors, CONCUR_CLEAN still cannot make a review with a quarantined finding clean', async () => {
    deps = buildDeps({ ...zeroSurvivorScript({ result: 'CONCUR_CLEAN', note: 'fine' }), 'shredder:SYNTHESIS': () => 'garbage' });

    const result = await ingest(deps, baseInput());

    expect((await store.getVerdict(result.reviewId))?.overallOutcome).toBe('incomplete');
    expect(github.state.reviews[0]?.body).not.toContain('Shell clear');
  });

  const FABRICATED_BLOCKER = {
    finding_id: 'finding_fabricated',
    outcome: 'publish',
    final_severity: 'critical',
    public_reason: 'A fabricated defect that was never raised.',
    blocking: true,
    blocking_reason: 'made up',
  };

  it.each([
    ['OBJECT', { result: 'OBJECT', note: 'something was missed' }],
    ['an invalid completion', { concurs: true }],
  ])('a fabricated blocking decision never outweighs a zero-survivor completion of %s', async (_label, shredderSays) => {
    deps = buildDeps({
      ...zeroSurvivorScript(shredderSays),
      'leo:LEO_REVIEW': () => ({ overall_outcome: 'blocking_findings_published', rationale: 'r', findings: [FABRICATED_BLOCKER], unresolved_uncertainty: [] }),
    });

    const result = await ingest(deps, baseInput());

    expect((await store.getVerdict(result.reviewId))?.overallOutcome).toBe('incomplete');
    expect(github.state.reviews[0]?.event).toBe('COMMENT');
    expect(github.state.reviews[0]?.body).not.toContain('A fabricated defect');
  });

  it('forces incomplete when Leo rules on a finding it was never given, even beside a real blocking finding', async () => {
    const script = realFindingScript('blocking_findings_published');
    deps = buildDeps({
      ...script,
      'leo:LEO_REVIEW': (request) => {
        const real = (script['leo:LEO_REVIEW'] as ScriptedResponder)(request) as { findings: Record<string, unknown>[] };
        return { ...real, findings: [...real.findings, FABRICATED_BLOCKER] };
      },
    });

    const result = await ingest(deps, baseInput());

    const verdict = await store.getVerdict(result.reviewId);
    expect(verdict?.overallOutcome).toBe('incomplete');
    expect(verdict?.coverageGap).toContain('never given');
    expect(verdict?.findings.map((d) => d.findingId)).toContain('finding_fabricated');
    expect(github.state.reviews[0]?.event).toBe('COMMENT');
    expect(github.state.reviews[0]?.body).not.toContain('A fabricated defect');
    expect((await store.listFindings(result.reviewId)).some((f) => f.status === 'published')).toBe(false);
  });

  it('records suppression for an incomplete verdict\'s publish decision even when its finding id does not exist', async () => {
    const script = realFindingScript('incomplete');
    deps = buildDeps({
      ...script,
      'leo:LEO_REVIEW': (request) => {
        const real = (script['leo:LEO_REVIEW'] as ScriptedResponder)(request) as { findings: Record<string, unknown>[] };
        return { ...real, findings: [...real.findings, { ...real.findings[0], finding_id: 'finding_hallucinated' }] };
      },
    });

    const result = await ingest(deps, baseInput());

    const suppressed = (await store.listEvents(result.reviewId)).filter((e) => e.metadata?.['publication'] === 'suppressed');
    expect(suppressed.map((e) => e.findingId)).toContain('finding_hallucinated');
    expect(suppressed).toHaveLength(2);
  });

  it('explains an incomplete verdict Leo returned itself, in orchestrator words only', async () => {
    deps = buildDeps(realFindingScript('incomplete'));

    const result = await ingest(deps, baseInput());

    const verdict = await store.getVerdict(result.reviewId);
    expect(verdict?.overallOutcome).toBe('incomplete');
    expect(verdict?.rationale).toBe('The stale call site fails on every import.');
    const body = github.state.reviews[0]?.body ?? '';
    expect(body).toContain('Leonardo could not reach a verdict');
    expect(body).not.toContain('The stale call site fails on every import.');
    expect(body).not.toContain('importRecords still calls load()');
  });

  it.each([
    ['CONCUR_CLEAN', 'clean_review'],
    ['OBJECT', 'incomplete'],
  ])('routes filtered findings through Shredder completion even when early exit would apply (%s)', async (shredderResult, outcome) => {
    // realFindingScript's case file has no unknowns and every lane is clean, so
    // canEarlyExit is true once the only finding is rejected by the verifier.
    deps = buildDeps({
      ...realFindingScript('clean_review'),
      'shredder:SYNTHESIS': () => ({ verdict: 'CONTRADICTS', reason: 'the call site passes the tenant' }),
      'shredder:SPARRING': () => ({ result: shredderResult, note: 'n' }),
      'leo:LEO_REVIEW': CLEAN_LEO,
    });

    const result = await ingest(deps, baseInput());

    const completion = (await store.listEvents(result.reviewId)).find((e) => e.phase === 'SPARRING' && e.actor === 'shredder');
    expect(completion?.metadata).toMatchObject({ completion: shredderResult });
    expect((await store.getVerdict(result.reviewId))?.overallOutcome).toBe(outcome);
  });

  it('derives the verdict label from Leo\'s decisions when Leo mislabels it', async () => {
    deps = buildDeps(realFindingScript('non_blocking_findings_published'));

    const result = await ingest(deps, baseInput());

    expect((await store.getVerdict(result.reviewId))?.overallOutcome).toBe('blocking_findings_published');
    expect(github.state.reviews[0]?.event).toBe('REQUEST_CHANGES');
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

    // Fail-safe invariant: even though Leo's own output said "clean_review",
    // the orchestrator overrides it — in code, not just in the prompt —
    // because a required lane never completed. Never manufacture confidence.
    const verdict = await store.getVerdict(result.reviewId);
    expect(verdict?.overallOutcome).toBe('incomplete');
    expect(github.state.reviews[0]?.body).not.toContain('Shell clear');
    expect(github.state.reviews[0]?.body).toContain('could not complete this round');
  });

  it('marks the run failed_retryable, not forever running, when a phase provider throws', async () => {
    deps = buildDeps({
      'april:CASE_FILE': () => {
        throw new Error('all providers failed: ollama request failed: timeout');
      },
    });

    const { reviewId } = await ingest(deps, baseInput());

    const run = await store.getReviewRun(reviewId);
    expect(run?.status).toBe('failed_retryable');
    expect(run?.currentPhase).toBe('CASE_FILE');
    expect(run?.error).toContain('all providers failed');
    const events = await store.listEvents(reviewId);
    expect(events.at(-1)?.eventType).toBe('run_failed');
    expect(github.state.reviews).toHaveLength(0);
  });

  it('deduplicates a repeated webhook delivery for the same review generation', async () => {
    deps = buildDeps({
      'april:CASE_FILE': () => ({ facts: [], sources: [], relevance: [], inferences: [], unknowns: [], stated_intent: '', unresolved_context: [] }),
      'raph:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'donnie:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'mikey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'casey:INDEPENDENT_REVIEW': () => ({ findings: [] }),
      'shredder:SPARRING': () => ({ concurs: true, note: 'nothing to challenge' }),
      'leo:LEO_REVIEW': () => ({ overall_outcome: 'clean_review', rationale: 'clean', findings: [], unresolved_uncertainty: [] }),
    });

    const first = await ingest(deps, baseInput({ githubDeliveryId: 'delivery-dup' }));
    const second = await ingest(deps, baseInput({ githubDeliveryId: 'delivery-dup' }));

    expect(second.outcome).toBe('duplicate_delivery');
    expect(second.reviewId).toBe(first.reviewId);
    expect(github.state.reviews).toHaveLength(1);
  });

  it('starts a fresh review for an explicit @half-shell after a finished same-SHA review (D012)', async () => {
    deps = buildDeps(realFindingScript('blocking_findings_published'));

    const first = await ingest(deps, baseInput({ githubDeliveryId: 'delivery-auto' }));
    const again = await ingest(deps, baseInput({ githubDeliveryId: 'delivery-auto-retry' }));
    const mention = await ingest(deps, baseInput({ githubDeliveryId: 'delivery-mention', trigger: 'manual' }));

    expect(again).toEqual({ reviewId: first.reviewId, outcome: 'already_handled_generation' });
    expect(mention.outcome).toBe('started');
    expect(mention.reviewId).not.toBe(first.reviewId);
    expect((await store.getReviewRun(mention.reviewId))?.generation).toBe(2);
    expect(github.state.reviews).toHaveLength(2);
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
      'shredder:SPARRING': () => ({ concurs: true, note: 'nothing to challenge' }),
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
      'shredder:SPARRING': () => ({ concurs: true, note: 'nothing to challenge' }),
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
      'shredder:SPARRING': () => ({ concurs: true, note: 'nothing to challenge' }),
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
