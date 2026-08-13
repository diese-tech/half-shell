import { anchorLine, type FileDiff } from '../github/diff.js';
import { log } from '../logger.js';
import type { Finding } from '../protocol/types.js';
import type { CandidateFinding } from '../types.js';

export interface AnchorReport {
  kept: CandidateFinding[];
  dropped: { finding: Finding; reason: string }[];
}

function normalizePath(path: string, known: Iterable<string>): string | undefined {
  const cleaned = path.trim().replace(/^\.\//, '').replace(/^[ab]\//, '');
  const paths = [...known];
  if (paths.includes(cleaned)) return cleaned;

  // Models sometimes cite a suffix of the path, or the bare file name.
  const suffixMatches = paths.filter(
    (candidate) => candidate.endsWith(`/${cleaned}`) || cleaned.endsWith(`/${candidate}`),
  );
  if (suffixMatches.length === 1) return suffixMatches[0];

  const base = cleaned.split('/').pop();
  const baseMatches = base ? paths.filter((candidate) => candidate.endsWith(`/${base}`)) : [];
  return baseMatches.length === 1 ? baseMatches[0] : undefined;
}

/**
 * Half-Shell never trusts a model's file paths or line numbers. A finding must
 * point at a file this change actually touched; a line that is not part of the
 * diff is snapped to the nearest changed line or dropped to file level.
 */
export function anchorFindings(
  candidates: CandidateFinding[],
  diffs: Map<string, FileDiff>,
  /**
   * Files the council saw as background. A finding cited against one of these
   * is dropped outright: without this, `normalizePath`'s basename fallback
   * would re-point `src/other/util.ts` at a changed `src/a/util.ts` and publish
   * a comment describing code that is not there.
   */
  relatedPaths: Set<string> = new Set(),
): AnchorReport {
  const kept: CandidateFinding[] = [];
  const dropped: { finding: Finding; reason: string }[] = [];

  for (const candidate of candidates) {
    const cited = candidate.finding.file.trim().replace(/^\.\//, '').replace(/^[ab]\//, '');
    if (relatedPaths.has(cited)) {
      dropped.push({
        finding: candidate.finding,
        reason: `"${cited}" is background context, not part of this change`,
      });
      continue;
    }

    const path = normalizePath(candidate.finding.file, diffs.keys());
    if (!path) {
      dropped.push({
        finding: candidate.finding,
        reason: `file "${candidate.finding.file}" is not part of this change`,
      });
      continue;
    }

    const diff = diffs.get(path) as FileDiff;
    const finding: Finding = { ...candidate.finding, file: path };

    if (finding.line != null) {
      const anchored = anchorLine(diff, finding.line);
      if (anchored === undefined) {
        log.debug('finding line not in diff; falling back to file level', {
          file: path,
          claimed: finding.line,
        });
        finding.line = null;
        finding.start_line = null;
      } else {
        if (anchored !== finding.line) finding.start_line = null;
        finding.line = anchored;
      }
    }

    if (
      finding.start_line != null &&
      finding.line != null &&
      finding.start_line >= finding.line
    ) {
      finding.start_line = null;
    }

    if (diff.addedLines.size === 0 && diff.removedLines.size === 0) {
      dropped.push({ finding, reason: `no reviewable diff for ${path}` });
      continue;
    }

    kept.push({ ...candidate, finding });
  }

  return { kept, dropped };
}
