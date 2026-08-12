import { describe, expect, it } from 'vitest';

import { anchorLine, annotatePatch, commentableLines, parsePatch } from './diff.js';

const PATCH = [
  '@@ -1,4 +1,6 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  ' const e = 6;',
  '@@ -20,3 +22,4 @@',
  ' function run() {',
  '+  guard();',
  ' }',
].join('\n');

describe('parsePatch', () => {
  it('maps added and context lines to head-side line numbers', () => {
    const diff = parsePatch('src/example.ts', PATCH);

    expect([...diff.addedLines].sort((a, b) => a - b)).toEqual([2, 3, 23]);
    expect([...diff.removedLines]).toEqual([2]);
    expect(diff.contextLines.has(1)).toBe(true);
    expect(diff.contextLines.has(4)).toBe(true);
    expect(diff.hunks).toHaveLength(2);
  });

  it('assigns GitHub review positions counting from the first hunk header', () => {
    const diff = parsePatch('src/example.ts', PATCH);

    // Position 1 is the line directly below the first @@ header.
    expect(diff.positionByLine.get(1)).toBe(1);
    expect(diff.positionByLine.get(2)).toBe(3);
    expect(diff.positionByLine.get(23)).toBe(9);
  });

  it('returns an empty map for a missing patch', () => {
    const diff = parsePatch('image.png', undefined);
    expect(diff.addedLines.size).toBe(0);
    expect(diff.hunks).toHaveLength(0);
  });

  it('ignores the no-newline marker without consuming a line number', () => {
    const diff = parsePatch('a.txt', ['@@ -1 +1 @@', '-old', '+new', '\\ No newline at end of file'].join('\n'));
    expect([...diff.addedLines]).toEqual([1]);
  });
});

describe('anchorLine', () => {
  const diff = parsePatch('src/example.ts', PATCH);

  it('keeps a line that the change actually added', () => {
    expect(anchorLine(diff, 3)).toBe(3);
  });

  it('snaps a near miss onto the closest added line', () => {
    expect(anchorLine(diff, 5)).toBe(3);
  });

  it('refuses to anchor a line far from the change', () => {
    expect(anchorLine(diff, 500)).toBeUndefined();
  });
});

describe('commentableLines', () => {
  it('includes context lines, which GitHub accepts on the right side', () => {
    const lines = commentableLines(parsePatch('src/example.ts', PATCH));
    expect(lines.has(1)).toBe(true);
    expect(lines.has(3)).toBe(true);
  });
});

describe('annotatePatch', () => {
  it('prefixes head-side line numbers so reviewers cite real lines', () => {
    const annotated = annotatePatch(PATCH, 10_000);
    expect(annotated).toContain('    3 + const c = 4;');
    expect(annotated).toContain('     -  const b = 2;');
  });

  it('truncates at the configured budget', () => {
    const annotated = annotatePatch(PATCH, 40);
    expect(annotated).toContain('patch truncated');
  });
});
