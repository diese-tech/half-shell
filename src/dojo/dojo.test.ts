import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OrchestrationStore } from '../orchestration/store.js';
import type { CouncilEvent, CouncilFinding, ReviewRun, Verdict } from '../orchestration/types.js';
import { getRunDetail, listRunSummaries, publicationState, summarizeVerdict } from './readModel.js';
import { createDojoServer, isLoopbackHost, loopbackHosts } from './server.js';

function run(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id: 'rev_1',
    repositoryId: 'diese-tech/half-shell',
    repositoryFullName: 'diese-tech/half-shell',
    pullRequestNumber: 12,
    baseSha: 'base000000',
    headSha: 'abcdef1234567890',
    status: 'running',
    currentPhase: 'SPARRING',
    generation: 1,
    trigger: 'webhook',
    supersededByReviewId: null,
    githubDeliveryId: null,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    error: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function finding(overrides: Partial<CouncilFinding> = {}): CouncilFinding {
  return {
    id: 'finding_1',
    reviewId: 'rev_1',
    sourcePersona: 'raph',
    category: 'bug',
    claim: 'Null deref on empty input',
    evidence: 'src/a.ts:10 reads x.y without a guard',
    affectedCode: { file: 'src/a.ts', line: 10, startLine: null },
    consequence: 'crash',
    confidence: 0.8,
    status: 'candidate',
    reproduction: null,
    proposedFix: null,
    severity: 'high',
    historicalContext: null,
    relatedFindings: [],
    corroboration: null,
    rootCause: null,
    ...overrides,
  };
}

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    reviewId: 'rev_1',
    reviewer: 'leonardo',
    overallOutcome: 'blocking_findings_published',
    rationale: 'One real bug.',
    findings: [
      { findingId: 'finding_1', outcome: 'publish', finalSeverity: 'high', publicReason: 'crashes', blocking: true, blockingReason: 'breaks requirement' },
      { findingId: 'finding_2', outcome: 'publish', finalSeverity: 'low', publicReason: 'nit', blocking: false, blockingReason: null },
      { findingId: 'finding_3', outcome: 'reject', finalSeverity: null, publicReason: 'unsupported', blocking: false, blockingReason: null },
    ],
    unresolvedUncertainty: [],
    createdAt: '2026-10-01T00:05:00.000Z',
    ...overrides,
  };
}

function event(overrides: Partial<CouncilEvent>): CouncilEvent {
  return {
    id: 'evt',
    reviewId: 'rev_1',
    sequence: 1,
    phase: 'PUBLICATION',
    actor: 'orchestrator',
    eventType: 'phase_started',
    findingId: null,
    content: null,
    metadata: null,
    createdAt: '2026-10-01T00:06:00.000Z',
    ...overrides,
  };
}

describe('Dojo read model', () => {
  let dir: string;
  let writer: OrchestrationStore;
  let reader: OrchestrationStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'half-shell-dojo-'));
    const path = join(dir, 'council.db');
    writer = new OrchestrationStore(path);
    reader = new OrchestrationStore(path, { readOnly: true });
  });

  afterEach(async () => {
    reader.close();
    writer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('lists recent runs newest-first by creation time, even after an older run is updated', async () => {
    await writer.saveReviewRun(run({ id: 'rev_old', createdAt: '2026-10-01T00:00:00.000Z' }));
    await writer.saveReviewRun(run({ id: 'rev_new', createdAt: '2026-10-02T00:00:00.000Z' }));
    // INSERT OR REPLACE moves rev_old's rowid to the end; ordering must not follow it.
    await writer.saveReviewRun(run({ id: 'rev_old', createdAt: '2026-10-01T00:00:00.000Z', currentPhase: 'LEO_REVIEW' }));

    const runs = await reader.listRecentReviewRuns(10);
    expect(runs.map((r) => r.id)).toEqual(['rev_new', 'rev_old']);
    expect(runs[1]!.currentPhase).toBe('LEO_REVIEW');
    expect(await reader.listRecentReviewRuns(1)).toHaveLength(1);
  });

  it('cannot write through a read-only store', async () => {
    await expect(reader.saveReviewRun(run())).rejects.toThrow();
    await expect(
      reader.appendEvent({ id: 'evt_x', reviewId: 'rev_1', phase: 'RECEIVED', actor: 'orchestrator', eventType: 'phase_started', findingId: null, content: null, metadata: null, createdAt: '' }),
    ).rejects.toThrow();
  });

  it('summarizes runs with short SHA, activity, and verdict counts', async () => {
    await writer.saveReviewRun(run({ status: 'archived', currentPhase: 'ARCHIVED' }));
    await writer.saveVerdict(verdict());
    await writer.appendEvent({ id: 'evt_pub', reviewId: 'rev_1', phase: 'PUBLICATION', actor: 'orchestrator', eventType: 'github_publication_completed', findingId: null, content: null, metadata: { reviewId: 99, githubReviewOutcome: 'REQUEST_CHANGES' }, createdAt: 't9' });
    const [summary] = await listRunSummaries(reader, 10);
    expect(summary).toMatchObject({
      id: 'rev_1',
      repository: 'diese-tech/half-shell',
      pullRequestNumber: 12,
      shortHeadSha: 'abcdef1',
      phase: 'ARCHIVED',
      status: 'archived',
      active: false,
      verdict: { overallOutcome: 'blocking_findings_published', blocking: 1, nonBlocking: 1, notPublished: 1 },
    });
    expect(summarizeVerdict(undefined, publicationState(run(), []))).toBeNull();
  });

  it('reports zero published findings for an incomplete review, whatever Leo would have published', () => {
    const posted = publicationState(run({ status: 'archived' }), [event({ eventType: 'github_publication_completed', metadata: { reviewId: 99, githubReviewOutcome: 'COMMENT' } })]);
    expect(summarizeVerdict(verdict({ overallOutcome: 'incomplete' }), posted)).toEqual({
      overallOutcome: 'incomplete',
      blocking: 0,
      nonBlocking: 0,
      notPublished: 3,
    });
  });

  it('reports zero published findings when GitHub received nothing: superseded, failed, or not yet posted', async () => {
    const superseded = publicationState(run({ status: 'superseded' }), [event({ eventType: 'run_superseded', content: 'head moved' })]);
    for (const publication of [superseded, publicationState(run({ status: 'failed_retryable' }), []), publicationState(run(), [])]) {
      expect(summarizeVerdict(verdict(), publication)).toMatchObject({ blocking: 0, nonBlocking: 0, notPublished: 3 });
    }

    await writer.saveReviewRun(run({ status: 'superseded' }));
    await writer.saveVerdict(verdict());
    await writer.appendEvent({ id: 'evt_sup', reviewId: 'rev_1', phase: 'PUBLICATION', actor: 'orchestrator', eventType: 'run_superseded', findingId: null, content: 'head moved', metadata: null, createdAt: 't9' });
    const [summary] = await listRunSummaries(reader, 10);
    expect(summary?.verdict).toMatchObject({ blocking: 0, nonBlocking: 0, notPublished: 3 });
    expect((await getRunDetail(reader, 'rev_1'))?.summary.verdict).toMatchObject({ blocking: 0, nonBlocking: 0 });
  });

  it('builds run detail with events in sequence order', async () => {
    await writer.saveReviewRun(run());
    await writer.appendEvent({ id: 'evt_a', reviewId: 'rev_1', phase: 'INDEPENDENT_REVIEW', actor: 'raph', eventType: 'persona_message', findingId: null, content: 'first', metadata: null, createdAt: 't1' });
    await writer.appendEvent({ id: 'evt_b', reviewId: 'rev_1', phase: 'SPARRING', actor: 'shredder', eventType: 'challenge', findingId: 'finding_1', content: 'second', metadata: null, createdAt: 't2' });
    await writer.saveFinding(finding());

    const detail = await getRunDetail(reader, 'rev_1');
    expect(detail!.events.map((e) => [e.sequence, e.actor, e.content])).toEqual([
      [1, 'raph', 'first'],
      [2, 'shredder', 'second'],
    ]);
    expect(detail!.findings).toHaveLength(1);
    expect(detail!.verdict).toBeNull();
    expect(detail!.publication.state).toBe('not_started');
    expect(await getRunDetail(reader, 'rev_missing')).toBeUndefined();
  });

  it('derives publication state from the event stream', () => {
    const archived = run({ status: 'archived', currentPhase: 'ARCHIVED' });
    expect(
      publicationState(archived, [
        event({ eventType: 'github_publication_started' }),
        event({ eventType: 'github_publication_completed', metadata: { reviewId: 99, githubReviewOutcome: 'REQUEST_CHANGES' } }),
      ]),
    ).toMatchObject({ state: 'published', githubReviewOutcome: 'REQUEST_CHANGES', githubReviewId: 99 });
    expect(publicationState(run({ status: 'superseded' }), [event({ eventType: 'run_superseded', content: 'head moved' })])).toMatchObject({ state: 'superseded', detail: 'head moved' });
    expect(publicationState(run(), [event({ eventType: 'github_publication_started' })]).state).toBe('in_progress');
    expect(publicationState(run({ status: 'failed_final', error: 'boom' }), []).state).toBe('failed');
  });
});

describe('Dojo server', () => {
  let dir: string;
  let writer: OrchestrationStore;
  let reader: OrchestrationStore;
  let server: Server;
  let base: string;
  let port: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'half-shell-dojo-srv-'));
    const path = join(dir, 'council.db');
    writer = new OrchestrationStore(path);
    reader = new OrchestrationStore(path, { readOnly: true });
    await writer.saveReviewRun(run());
    await writer.appendEvent({ id: 'evt_a', reviewId: 'rev_1', phase: 'INDEPENDENT_REVIEW', actor: 'raph', eventType: 'persona_message', findingId: null, content: '<script>alert(1)</script>', metadata: null, createdAt: '2026-10-01T00:01:00.000Z' });
    await writer.appendEvent({ id: 'evt_b', reviewId: 'rev_1', phase: 'SPARRING', actor: 'shredder', eventType: 'challenge', findingId: 'finding_1', content: 'prove it', metadata: null, createdAt: '2026-10-01T00:02:00.000Z' });
    await writer.saveFinding(finding());
    server = createDojoServer({ getReader: () => reader, databasePath: path, allowedHosts: undefined });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    reader.close();
    writer.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('renders the recent-runs home page', async () => {
    const res = await fetch(`${base}/dojo`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain('diese-tech/half-shell#12');
    expect(html).toContain('abcdef1');
    expect(html).toContain('SPARRING');
    expect(html).toContain('href="/dojo/runs/rev_1"');
  });

  it('renders run detail with ordered, escaped events and named actors', async () => {
    const html = await (await fetch(`${base}/dojo/runs/rev_1`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const raph = html.indexOf('Raphael');
    const shredder = html.indexOf('Shredder');
    expect(raph).toBeGreaterThan(-1);
    expect(shredder).toBeGreaterThan(raph);
    expect(html).toContain('data-active="true"');
    expect(html).toContain('Null deref on empty input');
  });

  it('serves a polling fragment that reflects new events without a restart', async () => {
    const before = await (await fetch(`${base}/dojo/runs/rev_1?fragment=1`)).text();
    expect(before.startsWith('<div id="dojo-live"')).toBe(true);
    expect(before).not.toContain('Leonardo has spoken');
    await writer.appendEvent({ id: 'evt_c', reviewId: 'rev_1', phase: 'LEO_REVIEW', actor: 'leo', eventType: 'verdict_recorded', findingId: null, content: 'Leonardo has spoken', metadata: null, createdAt: '2026-10-01T00:03:00.000Z' });
    await writer.saveReviewRun(run({ status: 'archived', currentPhase: 'ARCHIVED' }));
    const after = await (await fetch(`${base}/dojo/runs/rev_1?fragment=1`)).text();
    expect(after).toContain('Leonardo has spoken');
    expect(after).toContain('data-active="false"');
  });

  it('exposes JSON read endpoints and 404s unknown runs', async () => {
    const list = (await (await fetch(`${base}/dojo/api/runs`)).json()) as { runs: { id: string }[] };
    expect(list.runs.map((r) => r.id)).toEqual(['rev_1']);
    expect((await fetch(`${base}/dojo/api/runs/rev_1`)).status).toBe(200);
    expect((await fetch(`${base}/dojo/runs/nope`)).status).toBe(404);
    expect((await fetch(`${base}/dojo/api/runs/nope`)).status).toBe(404);
  });

  it('rejects every non-read method', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/dojo/runs/rev_1`, { method });
      expect(res.status).toBe(405);
    }
  });

  it('rejects unexpected Host headers when loopback-bound', async () => {
    const allowedHosts = new Set<string>();
    const guarded = createDojoServer({ getReader: () => reader, databasePath: 'x', allowedHosts });
    await new Promise<void>((resolve) => guarded.listen(0, '127.0.0.1', resolve));
    const guardedPort = (guarded.address() as AddressInfo).port;
    for (const host of loopbackHosts(guardedPort)) allowedHosts.add(host);
    // fetch() forbids overriding Host, so use node:http directly.
    const statusFor = (host: string) =>
      new Promise<number>((resolve, reject) => {
        request({ host: '127.0.0.1', port: guardedPort, path: '/dojo', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on('error', reject)
          .end();
      });
    try {
      expect(await statusFor(`127.0.0.1:${guardedPort}`)).toBe(200);
      expect(await statusFor(`localhost:${guardedPort}`)).toBe(200);
      expect(await statusFor('evil.example')).toBe(403);
    } finally {
      await new Promise((resolve) => guarded.close(resolve));
    }
  });

  it('shows a waiting page when the database does not exist yet', async () => {
    const empty = createDojoServer({ getReader: () => undefined, databasePath: '/nowhere/council.db' });
    await new Promise<void>((resolve) => empty.listen(0, '127.0.0.1', resolve));
    try {
      const html = await (await fetch(`http://127.0.0.1:${(empty.address() as AddressInfo).port}/dojo`)).text();
      expect(html).toContain('No Council database yet');
      expect(html).toContain('/nowhere/council.db');
    } finally {
      await new Promise((resolve) => empty.close(resolve));
    }
  });
});

describe('loopback detection', () => {
  it('accepts loopback hosts only', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'example.com']) expect(isLoopbackHost(host)).toBe(false);
  });
});
