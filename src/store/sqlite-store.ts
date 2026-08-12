import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Resolution } from '../protocol/types.js';
import type { PublishedFindingRecord, RepoRef, ReviewRun } from '../types.js';
import type { Store } from './store.js';

/**
 * SQLite persistence for deployments that outlive a container. Uses Node's
 * built-in driver, so it costs no dependency. Rows keep the protocol objects
 * as JSON — the schema indexes what we query on and does not try to model the
 * protocol, which is versioned separately.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  pull_number  INTEGER NOT NULL,
  head_sha     TEXT NOT NULL,
  finished_at  TEXT NOT NULL,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_pull ON runs (owner, repo, pull_number, finished_at);

CREATE TABLE IF NOT EXISTS published (
  key          TEXT NOT NULL,
  owner        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  pull_number  INTEGER NOT NULL,
  payload      TEXT NOT NULL,
  PRIMARY KEY (owner, repo, pull_number, key)
);

CREATE TABLE IF NOT EXISTS resolutions (
  owner        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  pull_number  INTEGER NOT NULL,
  finding_id   TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  payload      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resolutions_pull ON resolutions (owner, repo, pull_number, recorded_at);
`;

/** Runs kept per pull request; older ones are pruned on write. */
const RUN_HISTORY_LIMIT = 20;

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  async saveRun(run: ReviewRun): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs (id, owner, repo, pull_number, head_sha, finished_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.repo.owner,
        run.repo.repo,
        run.pullNumber,
        run.headSha,
        run.finishedAt,
        JSON.stringify(run),
      );

    this.db
      .prepare(
        `DELETE FROM runs
          WHERE owner = ? AND repo = ? AND pull_number = ?
            AND id NOT IN (
              SELECT id FROM runs
               WHERE owner = ? AND repo = ? AND pull_number = ?
               ORDER BY finished_at DESC, rowid DESC
               LIMIT ?
            )`,
      )
      .run(
        run.repo.owner,
        run.repo.repo,
        run.pullNumber,
        run.repo.owner,
        run.repo.repo,
        run.pullNumber,
        RUN_HISTORY_LIMIT,
      );
  }

  async listRuns(repo: RepoRef, pullNumber: number): Promise<ReviewRun[]> {
    const rows = this.db
      .prepare(
        `SELECT payload FROM runs
          WHERE owner = ? AND repo = ? AND pull_number = ?
          ORDER BY finished_at ASC, rowid ASC`,
      )
      .all(repo.owner, repo.repo, pullNumber) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as ReviewRun);
  }

  async savePublished(records: PublishedFindingRecord[]): Promise<void> {
    if (records.length === 0) return;
    const statement = this.db.prepare(
      `INSERT OR REPLACE INTO published (key, owner, repo, pull_number, payload)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const record of records) {
        statement.run(
          record.key,
          record.repo.owner,
          record.repo.repo,
          record.pullNumber,
          JSON.stringify(record),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async listPublished(repo: RepoRef, pullNumber: number): Promise<PublishedFindingRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT payload FROM published
          WHERE owner = ? AND repo = ? AND pull_number = ?
          ORDER BY rowid ASC`,
      )
      .all(repo.owner, repo.repo, pullNumber) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as PublishedFindingRecord);
  }

  async saveResolution(
    repo: RepoRef,
    pullNumber: number,
    resolution: Resolution & { commentId?: number },
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO resolutions (owner, repo, pull_number, finding_id, recorded_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo.owner,
        repo.repo,
        pullNumber,
        resolution.finding_id,
        new Date().toISOString(),
        JSON.stringify(resolution),
      );

    // Mirror the resolution onto the published record, as FileStore does.
    const published = await this.listPublished(repo, pullNumber);
    const record = published.find((entry) => entry.findingId === resolution.finding_id);
    if (record) {
      record.status = mapStatus(resolution.status);
      await this.savePublished([record]);
    }
  }

  async listResolutions(repo: RepoRef, pullNumber: number): Promise<Resolution[]> {
    const rows = this.db
      .prepare(
        `SELECT payload FROM resolutions
          WHERE owner = ? AND repo = ? AND pull_number = ?
          ORDER BY recorded_at ASC, rowid ASC`,
      )
      .all(repo.owner, repo.repo, pullNumber) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as Resolution);
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
