import { describe, expect, it } from 'vitest';

import type { Finding } from '../protocol/types.js';
import type { CandidateFinding } from '../types.js';
import { buildAnonymousPool, isSameProblem, renderPool } from './pool.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'X-01',
    severity: 'medium',
    confidence: 0.6,
    category: 'bug',
    file: 'src/example.ts',
    line: 10,
    start_line: null,
    claim: 'The tenant identifier is dropped before the query runs.',
    evidence: 'The new call site omits tenantId.',
    failure_mode: 'The query returns rows from every tenant.',
    suggested_fix: 'Pass tenantId through to the query.',
    corroboration_count: 1,
    corroborating_evidence: [],
    ...overrides,
  };
}

function candidate(author: string, overrides: Partial<Finding> = {}): CandidateFinding {
  return { finding: finding(overrides), author, provider: 'test' };
}

describe('isSameProblem', () => {
  it('merges near-identical claims in the same file', () => {
    const a = finding();
    const b = finding({ claim: 'Tenant identifier is dropped before the query runs.', line: 40 });
    expect(isSameProblem(a, b)).toBe(true);
  });

  it('does not merge unrelated findings that share a file', () => {
    const a = finding();
    const b = finding({
      category: 'missing_test',
      claim: 'The retry path has no regression test.',
      line: 90,
    });
    expect(isSameProblem(a, b)).toBe(false);
  });

  it('does not merge across files', () => {
    expect(isSameProblem(finding(), finding({ file: 'src/other.ts' }))).toBe(false);
  });
});

describe('buildAnonymousPool', () => {
  it('counts independent discovery once per investigator', () => {
    const pool = buildAnonymousPool([
      candidate('Raphael'),
      candidate('Donatello', { evidence: 'The contract now requires tenantId.' }),
      candidate('Raphael', { evidence: 'Repeated by the same lane.' }),
    ]);

    expect(pool).toHaveLength(1);
    expect(pool[0]?.finding.corroboration_count).toBe(2);
    expect(pool[0]?.finding.corroborating_evidence).toContain('The contract now requires tenantId.');
  });

  it('keeps the strongest supported severity and highest confidence', () => {
    const pool = buildAnonymousPool([
      candidate('Raphael', { severity: 'medium', confidence: 0.5 }),
      candidate('Splinter', { severity: 'high', confidence: 0.9 }),
    ]);

    expect(pool[0]?.finding.severity).toBe('high');
    expect(pool[0]?.finding.confidence).toBe(0.9);
  });

  it('assigns anonymous ids that carry no authorship', () => {
    const pool = buildAnonymousPool([
      candidate('Casey Jones', { severity: 'low', claim: 'Malformed input is not rejected.', line: 80 }),
      candidate('Splinter', { severity: 'critical', claim: 'The admin check was removed.', line: 5 }),
    ]);

    expect(pool.map((item) => item.finding.finding_id)).toEqual(['HS-001', 'HS-002']);
    // Severity ordering, not authorship, decides the ids.
    expect(pool[0]?.finding.severity).toBe('critical');
  });

  it('never leaks authorship into the deliberation view', () => {
    const pool = buildAnonymousPool([candidate('Michelangelo')]);
    const rendered = renderPool(pool);

    expect(rendered).toContain('HS-001');
    expect(rendered).not.toContain('Michelangelo');
  });
});
