import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { CouncilEvent, CouncilFinding, EvidencePacket, ReviewRun, Verdict } from './types.js';

/**
 * Durable persistence for the council orchestration engine. Separate from
 * src/store/* (the existing v1 pipeline's store) — this is additive, not a
 * replacement, so the shipped pipeline keeps working unchanged. Rows keep
 * the domain objects as JSON and index only what the engine actually
 * queries on, same convention as src/store/sqlite-store.ts.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS review_runs (
  id                      TEXT PRIMARY KEY,
  repository_id           TEXT NOT NULL,
  pull_request_number     INTEGER NOT NULL,
  head_sha                TEXT NOT NULL,
  status                  TEXT NOT NULL,
  github_delivery_id      TEXT,
  updated_at              TEXT NOT NULL,
  payload                 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_runs_pr ON review_runs (repository_id, pull_request_number);
CREATE INDEX IF NOT EXISTS review_runs_delivery ON review_runs (github_delivery_id);

CREATE TABLE IF NOT EXISTS council_events (
  id          TEXT PRIMARY KEY,
  review_id   TEXT NOT NULL,
  sequence    INTEGER NOT NULL,
  payload     TEXT NOT NULL,
  UNIQUE (review_id, sequence)
);
CREATE INDEX IF NOT EXISTS council_events_review ON council_events (review_id, sequence);

CREATE TABLE IF NOT EXISTS council_findings (
  id          TEXT PRIMARY KEY,
  review_id   TEXT NOT NULL,
  status      TEXT NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS council_findings_review ON council_findings (review_id);

CREATE TABLE IF NOT EXISTS evidence_packets (
  review_id   TEXT PRIMARY KEY,
  payload     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS council_verdicts (
  review_id   TEXT PRIMARY KEY,
  payload     TEXT NOT NULL
);
`;

export class OrchestrationStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // --- review runs ---------------------------------------------------

  async saveReviewRun(run: ReviewRun): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO review_runs
           (id, repository_id, pull_request_number, head_sha, status, github_delivery_id, updated_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.repositoryId,
        run.pullRequestNumber,
        run.headSha,
        run.status,
        run.githubDeliveryId,
        run.updatedAt,
        JSON.stringify(run),
      );
  }

  async getReviewRun(id: string): Promise<ReviewRun | undefined> {
    const row = this.db.prepare(`SELECT payload FROM review_runs WHERE id = ?`).get(id) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as ReviewRun) : undefined;
  }

  /** Every run ever recorded for this pull request, oldest first — the basis for identity/supersession decisions. */
  async listRunsForPullRequest(repositoryId: string, pullRequestNumber: number): Promise<ReviewRun[]> {
    const rows = this.db
      .prepare(
        `SELECT payload FROM review_runs
          WHERE repository_id = ? AND pull_request_number = ?
          ORDER BY rowid ASC`,
      )
      .all(repositoryId, pullRequestNumber) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as ReviewRun);
  }

  // --- council events (append-only) -----------------------------------

  /**
   * Appends one event, assigning the next sequence number for this review
   * itself so callers never race on it. The UNIQUE(review_id, sequence)
   * constraint is the backstop if two writers ever did race.
   */
  async appendEvent(event: Omit<CouncilEvent, 'sequence'>): Promise<CouncilEvent> {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM council_events WHERE review_id = ?`)
      .get(event.reviewId) as { max_sequence: number };
    const sequence = row.max_sequence + 1;
    const full: CouncilEvent = { ...event, sequence };
    this.db
      .prepare(`INSERT INTO council_events (id, review_id, sequence, payload) VALUES (?, ?, ?, ?)`)
      .run(full.id, full.reviewId, full.sequence, JSON.stringify(full));
    return full;
  }

  async listEvents(reviewId: string): Promise<CouncilEvent[]> {
    const rows = this.db
      .prepare(`SELECT payload FROM council_events WHERE review_id = ? ORDER BY sequence ASC`)
      .all(reviewId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as CouncilEvent);
  }

  // --- findings ---------------------------------------------------------

  async saveFinding(finding: CouncilFinding): Promise<void> {
    this.db
      .prepare(`INSERT OR REPLACE INTO council_findings (id, review_id, status, payload) VALUES (?, ?, ?, ?)`)
      .run(finding.id, finding.reviewId, finding.status, JSON.stringify(finding));
  }

  async saveFindings(findings: CouncilFinding[]): Promise<void> {
    for (const finding of findings) await this.saveFinding(finding);
  }

  async getFinding(id: string): Promise<CouncilFinding | undefined> {
    const row = this.db.prepare(`SELECT payload FROM council_findings WHERE id = ?`).get(id) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as CouncilFinding) : undefined;
  }

  async listFindings(reviewId: string): Promise<CouncilFinding[]> {
    const rows = this.db
      .prepare(`SELECT payload FROM council_findings WHERE review_id = ? ORDER BY rowid ASC`)
      .all(reviewId) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as CouncilFinding);
  }

  // --- evidence packet (one per review) ---------------------------------

  async saveEvidencePacket(packet: EvidencePacket): Promise<void> {
    this.db
      .prepare(`INSERT OR REPLACE INTO evidence_packets (review_id, payload) VALUES (?, ?)`)
      .run(packet.reviewId, JSON.stringify(packet));
  }

  async getEvidencePacket(reviewId: string): Promise<EvidencePacket | undefined> {
    const row = this.db.prepare(`SELECT payload FROM evidence_packets WHERE review_id = ?`).get(reviewId) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as EvidencePacket) : undefined;
  }

  // --- verdict (one per review) ------------------------------------------

  async saveVerdict(verdict: Verdict): Promise<void> {
    this.db
      .prepare(`INSERT OR REPLACE INTO council_verdicts (review_id, payload) VALUES (?, ?)`)
      .run(verdict.reviewId, JSON.stringify(verdict));
  }

  async getVerdict(reviewId: string): Promise<Verdict | undefined> {
    const row = this.db.prepare(`SELECT payload FROM council_verdicts WHERE review_id = ?`).get(reviewId) as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as Verdict) : undefined;
  }
}
