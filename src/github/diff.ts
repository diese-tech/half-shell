import type { ChangedFile } from '../types.js';

export interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface FileDiff {
  path: string;
  hunks: HunkRange[];
  /** New-file line numbers introduced by this change. */
  addedLines: Set<number>;
  /** Old-file line numbers deleted by this change. */
  removedLines: Set<number>;
  /** New-file line numbers shown as unchanged context inside a hunk. */
  contextLines: Set<number>;
  /** New-file line number -> GitHub review `position` within this patch. */
  positionByLine: Map<number, number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff patch. Half-Shell never trusts a model's line numbers,
 * so this map is the ground truth used to anchor or reject every finding.
 */
export function parsePatch(path: string, patch: string | undefined): FileDiff {
  const diff: FileDiff = {
    path,
    hunks: [],
    addedLines: new Set(),
    removedLines: new Set(),
    contextLines: new Set(),
    positionByLine: new Map(),
  };
  if (!patch) return diff;

  let newLine = 0;
  let oldLine = 0;
  let position = 0;
  let insideHunk = false;

  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      diff.hunks.push({
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
      });
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      // Position counts every line below the first hunk header, headers included.
      if (insideHunk) position += 1;
      insideHunk = true;
      continue;
    }
    if (!insideHunk) continue;

    position += 1;
    const marker = raw[0] ?? ' ';
    if (marker === '+') {
      diff.addedLines.add(newLine);
      diff.positionByLine.set(newLine, position);
      newLine += 1;
    } else if (marker === '-') {
      diff.removedLines.add(oldLine);
      oldLine += 1;
    } else if (marker === '\\') {
      // "\ No newline at end of file" — occupies a position but no line number.
    } else {
      diff.contextLines.add(newLine);
      diff.positionByLine.set(newLine, position);
      newLine += 1;
      oldLine += 1;
    }
  }
  return diff;
}

export function buildDiffIndex(files: ChangedFile[]): Map<string, FileDiff> {
  const index = new Map<string, FileDiff>();
  for (const file of files) {
    index.set(file.path, parsePatch(file.path, file.patch));
  }
  return index;
}

/** Lines that GitHub accepts as inline comment anchors on the RIGHT side. */
export function commentableLines(diff: FileDiff): Set<number> {
  return new Set([...diff.addedLines, ...diff.contextLines]);
}

/**
 * Snap a claimed line to the nearest line the change actually touched.
 * Returns undefined when nothing is close enough to comment on honestly.
 */
export function anchorLine(diff: FileDiff, claimed: number, tolerance = 5): number | undefined {
  if (diff.addedLines.has(claimed)) return claimed;
  const candidates = [...diff.addedLines];
  if (candidates.length === 0) return undefined;

  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of candidates) {
    const distance = Math.abs(line - claimed);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = line;
    }
  }
  return bestDistance <= tolerance ? best : undefined;
}

/** Render a patch with new-file line numbers so reviewers cite real lines. */
export function annotatePatch(patch: string | undefined, maxChars: number): string {
  if (!patch) return '(no textual diff available)';

  const lines: string[] = [];
  let newLine = 0;
  let insideHunk = false;

  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      newLine = Number(header[3]);
      insideHunk = true;
      lines.push(`        ${raw}`);
      continue;
    }
    if (!insideHunk) {
      lines.push(`        ${raw}`);
      continue;
    }
    const marker = raw[0] ?? ' ';
    if (marker === '-') {
      lines.push(`     -  ${raw.slice(1)}`);
    } else if (marker === '\\') {
      lines.push(`        ${raw}`);
    } else {
      const number = String(newLine).padStart(5, ' ');
      lines.push(`${number} ${marker === '+' ? '+' : ' '} ${raw.slice(1)}`);
      newLine += 1;
    }
  }

  const text = lines.join('\n');
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n… patch truncated at ${maxChars} characters …`;
}
