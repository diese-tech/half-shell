import { describe, expect, it } from 'vitest';

import { buildDiffIndex } from '../github/diff.js';
import type { Finding } from '../protocol/types.js';
import type { CandidateFinding, ChangedFile } from '../types.js';
import { anchorFindings } from './anchor.js';

const files: ChangedFile[] = [
  {
    path: 'src/example.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    truncated: false,
    patch: ['@@ -1,3 +1,4 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;', ' const d = 5;'].join('\n'),
  },
];

function candidate(overrides: Partial<Finding>): CandidateFinding {
  return {
    author: 'Raphael',
    provider: 'test',
    finding: {
      finding_id: 'RAPHAEL-01',
      severity: 'high',
      confidence: 0.8,
      category: 'bug',
      file: 'src/example.ts',
      line: 2,
      start_line: null,
      claim: 'claim',
      evidence: 'evidence',
      failure_mode: 'failure',
      suggested_fix: 'fix',
      corroboration_count: 1,
      corroborating_evidence: [],
      ...overrides,
    },
  };
}

describe('anchorFindings', () => {
  const diffs = buildDiffIndex(files);

  it('keeps a finding that points at a changed line', () => {
    const { kept, dropped } = anchorFindings([candidate({ line: 3 })], diffs);
    expect(dropped).toHaveLength(0);
    expect(kept[0]?.finding.line).toBe(3);
  });

  it('drops findings about files this change never touched', () => {
    const { kept, dropped } = anchorFindings([candidate({ file: 'src/untouched.ts' })], diffs);
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toContain('not part of this change');
  });

  it('falls back to file level rather than trusting a bogus line', () => {
    const { kept } = anchorFindings([candidate({ line: 900 })], diffs);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.finding.line).toBeNull();
  });

  it('snaps a near-miss line onto the closest changed line', () => {
    const { kept } = anchorFindings([candidate({ line: 5 })], diffs);
    expect(kept[0]?.finding.line).toBe(3);
  });

  it('normalizes a/ and ./ prefixed paths from model output', () => {
    const { kept } = anchorFindings([candidate({ file: 'a/src/example.ts' })], diffs);
    expect(kept[0]?.finding.file).toBe('src/example.ts');
  });

  it('discards a start_line that is not above the anchor', () => {
    const { kept } = anchorFindings([candidate({ line: 3, start_line: 3 })], diffs);
    expect(kept[0]?.finding.start_line).toBeNull();
  });
});
