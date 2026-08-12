import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { log } from '../logger.js';
import type { Resolution } from '../protocol/types.js';
import type { PublishedFindingRecord, RepoRef, ReviewRun } from '../types.js';

export interface Store {
  saveRun(run: ReviewRun): Promise<void>;
  listRuns(repo: RepoRef, pullNumber: number): Promise<ReviewRun[]>;
  savePublished(records: PublishedFindingRecord[]): Promise<void>;
  listPublished(repo: RepoRef, pullNumber: number): Promise<PublishedFindingRecord[]>;
  saveResolution(
    repo: RepoRef,
    pullNumber: number,
    resolution: Resolution & { commentId?: number },
  ): Promise<void>;
  listResolutions(repo: RepoRef, pullNumber: number): Promise<Resolution[]>;
}

interface PullState {
  runs: ReviewRun[];
  published: PublishedFindingRecord[];
  resolutions: (Resolution & { commentId?: number })[];
}

const EMPTY: PullState = { runs: [], published: [], resolutions: [] };

/**
 * JSON-file persistence, one file per pull request. Deliberately boring: the
 * protocol only needs finding state to survive between webhook deliveries, and
 * this keeps the service deployable without a database.
 */
export class FileStore implements Store {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {}

  private path(repo: RepoRef, pullNumber: number): string {
    const safe = `${repo.owner}__${repo.repo}__${pullNumber}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    return join(this.dataDir, `${safe}.json`);
  }

  private async read(repo: RepoRef, pullNumber: number): Promise<PullState> {
    try {
      const raw = await readFile(this.path(repo, pullNumber), 'utf8');
      return { ...EMPTY, ...(JSON.parse(raw) as Partial<PullState>) };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /** Serializes read-modify-write per pull request to avoid lost updates. */
  private async update(
    repo: RepoRef,
    pullNumber: number,
    mutate: (state: PullState) => void,
  ): Promise<void> {
    const key = this.path(repo, pullNumber);
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const state = await this.read(repo, pullNumber);
        mutate(state);
        await mkdir(this.dataDir, { recursive: true });
        await writeFile(key, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      })
      .catch((error) => {
        log.error('failed to persist state', { key, error: String(error) });
      });
    this.writes.set(key, next);
    return next;
  }

  async saveRun(run: ReviewRun): Promise<void> {
    await this.update(run.repo, run.pullNumber, (state) => {
      state.runs.push(run);
      // Keep the tail bounded; older runs are already reflected in GitHub.
      if (state.runs.length > 20) state.runs = state.runs.slice(-20);
    });
  }

  async listRuns(repo: RepoRef, pullNumber: number): Promise<ReviewRun[]> {
    return (await this.read(repo, pullNumber)).runs;
  }

  async savePublished(records: PublishedFindingRecord[]): Promise<void> {
    if (records.length === 0) return;
    const first = records[0] as PublishedFindingRecord;
    await this.update(first.repo, first.pullNumber, (state) => {
      for (const record of records) {
        const index = state.published.findIndex((entry) => entry.key === record.key);
        if (index >= 0) state.published[index] = record;
        else state.published.push(record);
      }
    });
  }

  async listPublished(repo: RepoRef, pullNumber: number): Promise<PublishedFindingRecord[]> {
    return (await this.read(repo, pullNumber)).published;
  }

  async saveResolution(
    repo: RepoRef,
    pullNumber: number,
    resolution: Resolution & { commentId?: number },
  ): Promise<void> {
    await this.update(repo, pullNumber, (state) => {
      state.resolutions.push(resolution);
      const record = state.published.find((entry) => entry.findingId === resolution.finding_id);
      if (record) record.status = mapStatus(resolution.status);
    });
  }

  async listResolutions(repo: RepoRef, pullNumber: number): Promise<Resolution[]> {
    return (await this.read(repo, pullNumber)).resolutions;
  }
}

function mapStatus(status: Resolution['status']): PublishedFindingRecord['status'] {
  switch (status) {
    case 'RESOLVED':
      return 'resolved';
    case 'WITHDRAWN':
      return 'withdrawn';
    case 'PARTIALLY_RESOLVED':
      return 'partially_resolved';
    case 'STILL_VALID':
      return 'still_valid';
    default:
      return 'published';
  }
}
