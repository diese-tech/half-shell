import { describe, expect, it } from 'vitest';

import type { Finding } from '../protocol/types.js';
import type { PoolItem } from '../types.js';
import { assembleVerdict, type Adjudication } from './verdict.js';

function item(id: string, overrides: Partial<Finding> = {}): PoolItem {
  return {
    authors: ['Raphael'],
    mergedFrom: [id],
    finding: {
      finding_id: id,
      severity: 'medium',
      confidence: 0.7,
      category: 'bug',
      file: 'src/example.ts',
      line: 12,
      start_line: null,
      claim: `claim ${id}`,
      evidence: 'evidence',
      failure_mode: 'failure',
      suggested_fix: 'fix',
      corroboration_count: 1,
      corroborating_evidence: [],
      ...overrides,
    },
  };
}

function adjudication(overrides: Partial<Adjudication> = {}): Adjudication {
  return { ok: true, decisions: [], unresolvedUncertainty: [], ...overrides };
}

const BASE = {
  reviewedSha: 'def5678abc',
  baseSha: 'abc1234def',
  coverage: '1 changed file reviewed; no files omitted.',
  coverageLimitations: [],
  laneFailures: 0,
  challengeFailures: 0,
};

describe('assembleVerdict', () => {
  it('publishes only what Leonardo approved', () => {
    const pool = [item('HS-001'), item('HS-002')];
    const { verdict } = assembleVerdict({
      ...BASE,
      pool,
      adjudication: adjudication({
        decisions: [
          { finding_id: 'HS-001', decision: 'PUBLISH', reasoning: 'evidence holds' },
          { finding_id: 'HS-002', decision: 'REJECT', reasoning: 'pre-existing' },
        ],
      }),
    });

    expect(verdict.published_findings.map((f) => f.finding_id)).toEqual(['HS-001']);
    expect(verdict.rejected_count).toBe(1);
    expect(verdict.complete).toBe(true);
  });

  it('withholds findings Leonardo never adjudicated', () => {
    const { verdict } = assembleVerdict({ ...BASE, pool: [item('HS-001')], adjudication: adjudication() });

    expect(verdict.published_findings).toHaveLength(0);
    expect(verdict.unresolved_uncertainty?.join(' ')).toContain('no adjudication');
  });

  it('applies an adjusted severity when Leonardo downgrades', () => {
    const { verdict } = assembleVerdict({
      ...BASE,
      pool: [item('HS-001', { severity: 'high' })],
      adjudication: adjudication({
        decisions: [
          { finding_id: 'HS-001', decision: 'DOWNGRADE', reasoning: 'limited blast radius', severity: 'low' },
        ],
      }),
    });

    expect(verdict.published_findings[0]?.severity).toBe('low');
  });

  it('folds a merged finding into its target as corroboration', () => {
    const pool = [item('HS-001'), item('HS-002', { evidence: 'second evidence path' })];
    const { verdict } = assembleVerdict({
      ...BASE,
      pool,
      adjudication: adjudication({
        decisions: [
          { finding_id: 'HS-001', decision: 'PUBLISH', reasoning: 'holds' },
          { finding_id: 'HS-002', decision: 'MERGE_FINDINGS', reasoning: 'same defect', merge_into: 'HS-001' },
        ],
      }),
    });

    expect(verdict.published_findings).toHaveLength(1);
    expect(verdict.published_findings[0]?.corroboration_count).toBe(2);
    expect(verdict.published_findings[0]?.corroborating_evidence).toContain('second evidence path');
  });

  it('never reports a clean review when a lane failed', () => {
    const { verdict } = assembleVerdict({
      ...BASE,
      laneFailures: 1,
      coverageLimitations: ['The raphael lane did not complete: timeout'],
      pool: [],
      adjudication: adjudication(),
    });

    expect(verdict.complete).toBe(false);
    expect(verdict.published_findings).toHaveLength(0);
  });

  it('publishes nothing when adjudication itself failed', () => {
    const { verdict } = assembleVerdict({
      ...BASE,
      pool: [item('HS-001')],
      adjudication: adjudication({
        ok: false,
        decisions: [{ finding_id: 'HS-001', decision: 'PUBLISH', reasoning: 'ignored' }],
      }),
    });

    expect(verdict.published_findings).toHaveLength(0);
    expect(verdict.complete).toBe(false);
    expect(verdict.coverage_limitations?.join(' ')).toContain('Adjudication failed');
  });
});
