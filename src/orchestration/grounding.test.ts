import { describe, expect, it } from 'vitest';

import { annotatePatch } from '../github/diff.js';
import { renderRelatedFiles } from '../github/related.js';
import { excerptAround, groundQuote, parseChangedFiles } from './grounding.js';

/** One changed file exactly as renderChange (src/council/prompt.ts) writes it. */
function changed(path: string, patch: string): string {
  const added = patch.split('\n').filter((line) => line.startsWith('+')).length;
  return `\n--- ${path} (modified, +${added}/-0)\n${annotatePatch(patch, 10_000)}`;
}

const A = changed('src/a.ts', ['@@ -1,2 +1,3 @@', ' import { items } from "./items";', '+const total = items.length;', ' export { total };'].join('\n'));
const B = changed('src/b.ts', ['@@ -40,1 +40,3 @@', ' // shared helpers', '+const total = items.length;', '+export const onlyInB = "a line only b has";'].join('\n'));

const CONTEXT = [
  'Title: fix totals',
  'Description:',
  'Please check that the description line is never treated as code.',
  '',
  'Changed files (line numbers are the head-side truth):',
  A,
  B,
  renderRelatedFiles([{ path: 'src/related.ts', reason: 'mentions the changed file', content: 'const relatedOnly = callTheChangedCode();', truncated: false }]),
].join('\n');

const files = parseChangedFiles(CONTEXT);
const claim = (file: string, quote: string, line: number | null = null) => groundQuote(files, { file, quote, line });

describe('groundQuote — the quote must come from the claimed changed file', () => {
  it('passes a quote that exists in the claimed file', () => {
    expect(claim('src/a.ts', 'const total = items.length;')).toMatchObject({ ok: true, file: 'src/a.ts' });
  });

  it('fails a quote that exists only in another changed file', () => {
    expect(claim('src/a.ts', 'export const onlyInB = "a line only b has";')).toMatchObject({
      ok: false,
      reason: 'provenance_mismatch',
      detail: expect.stringContaining('src/b.ts'),
    });
  });

  it('fails a quote that exists only in the PR description', () => {
    expect(claim('src/a.ts', 'Please check that the description line is never treated as code.')).toMatchObject({ ok: false, reason: 'ungrounded_quote' });
  });

  it('fails when the claimed file is not a changed file, even if the quote is real elsewhere', () => {
    expect(claim('src/missing.ts', 'const total = items.length;')).toMatchObject({ ok: false, reason: 'provenance_mismatch' });
    expect(claim('src/missing.ts', 'nothing like this line exists')).toMatchObject({ ok: false, reason: 'provenance_mismatch' });
  });

  it('never grounds against related context, which no finding may claim', () => {
    expect(claim('src/related.ts', 'const relatedOnly = callTheChangedCode();')).toMatchObject({ ok: false });
  });

  it('requires the claimed-file match when the same line appears in several files', () => {
    const inA = claim('src/a.ts', 'const total = items.length;', 2);
    const inB = claim('src/b.ts', 'const total = items.length;', 41);
    expect(inA).toMatchObject({ ok: true, file: 'src/a.ts' });
    expect(inB).toMatchObject({ ok: true, file: 'src/b.ts' });
    // B's copy is at line 41: claiming it at A's line 2 is a location mismatch, not a pass.
    expect(claim('src/b.ts', 'const total = items.length;', 2)).toMatchObject({ ok: false, reason: 'provenance_mismatch' });
  });

  it('checks a supplied line number against the head-side line within tolerance', () => {
    expect(claim('src/b.ts', 'export const onlyInB = "a line only b has";', 42)).toMatchObject({ ok: true });
    expect(claim('src/b.ts', 'export const onlyInB = "a line only b has";', 45)).toMatchObject({ ok: true });
    expect(claim('src/b.ts', 'export const onlyInB = "a line only b has";', 120)).toMatchObject({
      ok: false,
      reason: 'provenance_mismatch',
      detail: expect.stringContaining('line 42'),
    });
  });

  it('rejects quotes too short to identify a line', () => {
    expect(claim('src/a.ts', 'total')).toMatchObject({ ok: false, reason: 'ungrounded_quote' });
  });

  it('fails closed when the changed-files section is missing or malformed — no whole-context fallback', () => {
    const noHeading = parseChangedFiles(`Description:\nconst total = items.length;\n${A}`.replace('Changed files', ''));
    expect(noHeading.size).toBe(0);
    expect(groundQuote(noHeading, { file: 'src/a.ts', quote: 'const total = items.length;', line: null })).toMatchObject({ ok: false });

    const noFileHeaders = parseChangedFiles('Changed files (line numbers are the head-side truth):\nconst total = items.length;');
    expect(noFileHeaders.size).toBe(0);
    expect(groundQuote(noFileHeaders, { file: 'src/a.ts', quote: 'const total = items.length;', line: null })).toMatchObject({ ok: false });
  });
});

describe('excerptAround', () => {
  it('returns a bounded slice of the claimed file only, with head-side line numbers', () => {
    const grounded = claim('src/b.ts', 'const total = items.length;', 41);
    if (!grounded.ok) throw new Error('expected grounding');
    const excerpt = excerptAround(files, grounded, 1);
    expect(excerpt).toContain('41  const total = items.length;');
    expect(excerpt).not.toContain('import { items }');
    expect(excerpt.split('\n')).toHaveLength(3);
  });
});
