import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PublishedFindingRecord, ReviewRun } from '../types.js';
import { SqliteStore } from './sqlite-store.js';
import { FileStore, type Store } from './store.js';

const repo = { owner: 'diese-tech', repo: 'half-shell' };

function run(id: string, headSha = 'abc1234', finishedAt = new Date().toISOString()): ReviewRun {
  return {
    id,
    repo,
    pullNumber: 42,
    headSha,
    baseSha: 'base123',
    protocolVersion: '1.0.0',
    startedAt: finishedAt,
    finishedAt,
    lanes: [],
    providersUsed: ['stub'],
    telemetry: {
      durationMs: 100,
      phaseMs: { lanes: 50 },
      providerCalls: 15,
      providerFailures: 0,
      promptTokens: 1000,
      completionTokens: 200,
    },
    verdict: {
      protocol_version: '1.0.0',
      reviewed_sha: headSha,
      base_sha: 'base123',
      coverage: 'all files reviewed',
      candidate_count: 1,
      rejected_count: 0,
      published_findings: [],
      complete: true,
    },
  };
}

function record(key: string): PublishedFindingRecord {
  return {
    key,
    findingId: 'HS-001',
    repo,
    pullNumber: 42,
    headSha: 'abc1234',
    file: 'src/loader.ts',
    line: 12,
    claim: 'a claim',
    status: 'published',
    publishedAt: new Date().toISOString(),
  };
}

/**
 * Both implementations must be interchangeable — the app only knows `Store`.
 * Running one suite against both keeps them honest.
 */
describe.each([
  ['FileStore', (dir: string): Store => new FileStore(dir)],
  ['SqliteStore', (dir: string): Store => new SqliteStore(join(dir, 'half-shell.db'))],
])('%s', (_name, create) => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'half-shell-store-'));
    store = create(dir);
  });

  afterEach(async () => {
    (store as { close?: () => void }).close?.();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns nothing for a pull request it has never seen', async () => {
    expect(await store.listRuns(repo, 999)).toEqual([]);
    expect(await store.listPublished(repo, 999)).toEqual([]);
    expect(await store.listResolutions(repo, 999)).toEqual([]);
  });

  it('round-trips a run, including telemetry', async () => {
    await store.saveRun(run('run-1'));

    const runs = await store.listRuns(repo, 42);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe('run-1');
    expect(runs[0]?.telemetry.providerCalls).toBe(15);
    expect(runs[0]?.verdict.complete).toBe(true);
  });

  it('keeps runs in chronological order', async () => {
    await store.saveRun(run('run-1', 'aaa1111', '2026-01-01T00:00:00.000Z'));
    await store.saveRun(run('run-2', 'bbb2222', '2026-01-02T00:00:00.000Z'));

    expect((await store.listRuns(repo, 42)).map((entry) => entry.id)).toEqual(['run-1', 'run-2']);
  });

  it('bounds run history rather than growing without limit', async () => {
    for (let i = 0; i < 25; i += 1) {
      await store.saveRun(run(`run-${String(i).padStart(2, '0')}`, 'sha', `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));
    }

    const runs = await store.listRuns(repo, 42);
    expect(runs.length).toBeLessThanOrEqual(20);
    // The most recent run survives.
    expect(runs.at(-1)?.id).toBe('run-24');
  });

  it('upserts a published finding by key instead of duplicating it', async () => {
    await store.savePublished([record('key-1')]);
    await store.savePublished([{ ...record('key-1'), commentId: 555 }]);

    const published = await store.listPublished(repo, 42);
    expect(published).toHaveLength(1);
    expect(published[0]?.commentId).toBe(555);
  });

  it('records a resolution and reflects it on the published finding', async () => {
    await store.savePublished([record('key-1')]);
    await store.saveResolution(
      repo,
      42,
      { finding_id: 'HS-001', status: 'RESOLVED', reasoning: 'fixed in the latest push' },
      'key-1',
    );

    const resolutions = await store.listResolutions(repo, 42);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]?.status).toBe('RESOLVED');

    const published = await store.listPublished(repo, 42);
    expect(published[0]?.status).toBe('resolved');
  });

  it('resolves the right finding when two runs share a run-local id', async () => {
    // Both were published as HS-001 on different runs; only the keys differ.
    await store.savePublished([
      { ...record('key-first'), findingId: 'HS-001', claim: 'the first finding' },
      { ...record('key-second'), findingId: 'HS-001', claim: 'the second finding' },
    ]);

    await store.saveResolution(
      repo,
      42,
      { finding_id: 'HS-001', status: 'RESOLVED', reasoning: 'the second one was fixed' },
      'key-second',
    );

    const published = await store.listPublished(repo, 42);
    expect(published.find((entry) => entry.key === 'key-second')?.status).toBe('resolved');
    // The unrelated finding keeps standing.
    expect(published.find((entry) => entry.key === 'key-first')?.status).toBe('published');
  });

  it('keeps pull requests separate', async () => {
    await store.savePublished([record('key-1')]);
    await store.savePublished([{ ...record('key-2'), pullNumber: 43 }]);

    expect(await store.listPublished(repo, 42)).toHaveLength(1);
    expect(await store.listPublished(repo, 43)).toHaveLength(1);
  });

  it('preserves publishedAt across an update, so callers can order by it', async () => {
    // The two stores do not order listPublished identically — SQLite's
    // INSERT OR REPLACE reassigns the rowid it orders by — so selectTarget
    // sorts by publishedAt instead. That only works if updates preserve it.
    const first = { ...record('key-1'), publishedAt: '2026-01-01T00:00:00.000Z' };
    await store.savePublished([first]);
    await store.savePublished([{ ...first, line: 99 }]);

    const [updated] = await store.listPublished(repo, 42);
    expect(updated?.publishedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(updated?.line).toBe(99);
  });

  it('sorting by publishedAt yields the same newest record in either store', async () => {
    await store.savePublished([
      { ...record('key-old'), publishedAt: '2026-01-01T00:00:00.000Z' },
      { ...record('key-new'), publishedAt: '2026-02-01T00:00:00.000Z' },
    ]);
    // Update the older one — under SQLite this moves it to the end of rowid order.
    await store.savePublished([
      { ...record('key-old'), publishedAt: '2026-01-01T00:00:00.000Z', status: 'still_valid' },
    ]);

    const published = await store.listPublished(repo, 42);
    const newest = [...published].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).at(-1);
    expect(newest?.key).toBe('key-new');
  });

  it('survives concurrent writes without losing records', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.savePublished([record(`key-${i}`)])),
    );

    expect(await store.listPublished(repo, 42)).toHaveLength(10);
  });
});

describe('SqliteStore', () => {
  it('persists across instances pointing at the same file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'half-shell-store-'));
    const path = join(dir, 'nested', 'half-shell.db');

    const first = new SqliteStore(path);
    await first.saveRun(run('run-1'));
    first.close();

    const second = new SqliteStore(path);
    expect(await second.listRuns(repo, 42)).toHaveLength(1);
    second.close();

    await rm(dir, { recursive: true, force: true });
  });
});
