import { describe, expect, it } from 'vitest';

import type { Finding, Verdict } from '../protocol/types.js';
import type { ChangeContext, PublishedFindingRecord } from '../types.js';
import { buildDiffIndex } from './diff.js';
import {
  findMovedFindings,
  findingKey,
  findingMarker,
  MAX_INLINE_COMMENTS,
  renderMovedComment,
  renderReview,
} from './publish.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'HS-001',
    severity: 'high',
    confidence: 0.9,
    category: 'contract',
    file: 'src/loader.ts',
    line: 2,
    start_line: null,
    claim: 'Callers still invoke load() without a tenant id.',
    evidence: 'evidence',
    failure_mode: 'failure',
    suggested_fix: 'fix',
    corroboration_count: 1,
    corroborating_evidence: [],
    ...overrides,
  };
}

function record(overrides: Partial<PublishedFindingRecord> = {}): PublishedFindingRecord {
  const base = finding();
  return {
    key: findingKey(base),
    findingId: base.finding_id,
    repo: { owner: 'diese-tech', repo: 'half-shell' },
    pullNumber: 42,
    headSha: 'old1234',
    file: base.file,
    line: base.line ?? null,
    claim: base.claim,
    commentId: 555,
    status: 'published',
    publishedAt: new Date().toISOString(),
    ...overrides,
  };
}

const context = {
  repo: { owner: 'diese-tech', repo: 'half-shell' },
  files: [
    {
      path: 'src/loader.ts',
      status: 'modified' as const,
      additions: 2,
      deletions: 1,
      truncated: false,
      patch: ['@@ -1,3 +1,4 @@', ' const a = 1;', '+const b = 2;', '+const c = 3;', ' const d = 4;'].join('\n'),
    },
  ],
} as unknown as ChangeContext;

function verdict(findings: Finding[]): Verdict {
  return {
    protocol_version: '1.0.0',
    reviewed_sha: 'def5678',
    base_sha: 'abc1234',
    coverage: '1 file reviewed',
    candidate_count: findings.length,
    rejected_count: 0,
    published_findings: findings,
    complete: true,
  };
}

describe('findMovedFindings', () => {
  it('reports a finding whose line moved under a push', () => {
    const moved = findMovedFindings([finding({ line: 57 })], [record({ line: 2 })]);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.finding.line).toBe(57);
  });

  it('stays quiet when the anchor did not move', () => {
    expect(findMovedFindings([finding({ line: 2 })], [record({ line: 2 })])).toHaveLength(0);
  });

  it('ignores findings it has never published', () => {
    expect(findMovedFindings([finding({ claim: 'a brand new claim' })], [record()])).toHaveLength(0);
  });

  it('cannot re-anchor a finding with no known thread', () => {
    expect(findMovedFindings([finding({ line: 57 })], [record({ line: 2, commentId: undefined })])).toHaveLength(0);
  });

  it('leaves resolved and withdrawn findings alone', () => {
    expect(findMovedFindings([finding({ line: 57 })], [record({ line: 2, status: 'resolved' })])).toHaveLength(0);
    expect(findMovedFindings([finding({ line: 57 })], [record({ line: 2, status: 'withdrawn' })])).toHaveLength(0);
  });

  it('states the new location without claiming a status', () => {
    const body = renderMovedComment(finding({ line: 57 }), 'abcdef1234');
    expect(body).toContain('src/loader.ts:57');
    expect(body).toContain('abcdef1');
    expect(body).not.toMatch(/resolved|fixed/i);
  });
});

describe('renderReview', () => {
  const diffs = buildDiffIndex(context.files);

  it('anchors a finding to a changed line and embeds its marker', () => {
    const target = finding({ line: 2 });
    const { comments } = renderReview(context, verdict([target]), diffs, new Map());

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ path: 'src/loader.ts', line: 2, side: 'RIGHT' });
    expect(comments[0]?.body).toContain(findingMarker(target));
  });

  it('summarizes a finding that has no safe anchor instead of guessing', () => {
    const { comments, body } = renderReview(
      context,
      verdict([finding({ line: null })]),
      diffs,
      new Map(),
    );

    expect(comments).toHaveLength(0);
    expect(body).toContain('Findings without a safe line anchor');
  });

  it('caps inline comments and summarizes the remainder', () => {
    const many = Array.from({ length: MAX_INLINE_COMMENTS + 5 }, (_, i) =>
      finding({ finding_id: `HS-${i}`, claim: `claim number ${i}`, line: 2 }),
    );

    const { comments, body } = renderReview(context, verdict(many), diffs, new Map());

    expect(comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(body).toContain('Findings without a safe line anchor');
  });

  it('keeps the most severe findings inline when it has to shed some', () => {
    const low = Array.from({ length: MAX_INLINE_COMMENTS }, (_, i) =>
      finding({ finding_id: `LOW-${i}`, severity: 'low', claim: `low claim ${i}`, line: 2 }),
    );
    const critical = finding({ finding_id: 'CRIT', severity: 'critical', claim: 'critical claim', line: 3 });

    const { comments } = renderReview(context, verdict([...low, critical]), diffs, new Map());

    expect(comments.some((comment) => comment.body.includes('critical claim'))).toBe(true);
  });

  it('says plainly when a review did not complete', () => {
    const incomplete = { ...verdict([]), complete: false };
    const { body } = renderReview(context, incomplete, diffs, new Map());

    expect(body).toContain('Review did not complete');
    expect(body).not.toContain('found nothing that met the publication standard');
  });
});
