import { createHash } from 'node:crypto';

import type { Finding, Verdict } from '../protocol/types.js';
import type { ChangeContext } from '../types.js';
import { commentableLines, type FileDiff } from './diff.js';
import type { ReviewComment } from './client.js';

export interface RenderedReview {
  body: string;
  comments: ReviewComment[];
}

const SEVERITY_LABEL: Record<Finding['severity'], string> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/** Stable identity for a finding across pushes, used to avoid re-posting. */
export function findingKey(finding: Finding): string {
  const basis = `${finding.file}|${finding.category}|${finding.claim.toLowerCase().replace(/\s+/g, ' ').trim()}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

/** Hidden marker so a posted comment can be matched back to its finding. */
export function findingMarker(finding: Finding): string {
  return `<!-- half-shell-finding:${findingKey(finding)} -->`;
}

export function renderFindingComment(finding: Finding, rationale?: string): string {
  const lines = [
    findingMarker(finding),
    `**${SEVERITY_LABEL[finding.severity]} · ${finding.category}** — ${finding.claim}`,
    '',
    `**Evidence.** ${finding.evidence}`,
    `**Failure mode.** ${finding.failure_mode}`,
    `**Suggested fix.** ${finding.suggested_fix}`,
  ];
  if (finding.corroboration_count > 1) {
    lines.push(
      '',
      `Independently identified by ${finding.corroboration_count} reviewers in different lanes.`,
    );
  }
  if (rationale) lines.push('', `_Verdict: ${rationale}_`);
  lines.push('', `<sub>Half-Shell · ${finding.finding_id} · confidence ${finding.confidence.toFixed(2)}</sub>`);
  return lines.join('\n');
}

/**
 * Builds the review payload. Findings that cannot be anchored to a line GitHub
 * will accept are summarized in the review body rather than dropped or
 * attached to an arbitrary line.
 */
export function renderReview(
  context: ChangeContext,
  verdict: Verdict,
  diffs: Map<string, FileDiff>,
  rationale: Map<string, string>,
): RenderedReview {
  const comments: ReviewComment[] = [];
  const unanchored: Finding[] = [];

  for (const finding of verdict.published_findings) {
    const diff = diffs.get(finding.file);
    const anchorable = diff ? commentableLines(diff) : new Set<number>();
    if (finding.line != null && anchorable.has(finding.line)) {
      const comment: ReviewComment = {
        path: finding.file,
        line: finding.line,
        side: 'RIGHT',
        body: renderFindingComment(finding, rationale.get(finding.finding_id)),
      };
      if (
        finding.start_line != null &&
        finding.start_line < finding.line &&
        anchorable.has(finding.start_line)
      ) {
        comment.start_line = finding.start_line;
      }
      comments.push(comment);
    } else {
      unanchored.push(finding);
    }
  }

  return { body: renderBody(context, verdict, unanchored, rationale), comments };
}

function renderBody(
  context: ChangeContext,
  verdict: Verdict,
  unanchored: Finding[],
  rationale: Map<string, string>,
): string {
  const published = verdict.published_findings.length;
  const sections: string[] = ['## Half-Shell — The Verdict', ''];

  if (!verdict.complete) {
    sections.push(
      '> Review did not complete. The findings below, if any, are partial and',
      '> this pull request has **not** received a clean review.',
      '',
    );
  }

  sections.push(
    published === 0
      ? verdict.complete
        ? 'The Dojo found nothing that met the publication standard.'
        : 'No findings survived the protocol, but coverage was incomplete.'
      : `${published} finding${published === 1 ? '' : 's'} survived Sparring, Shredder's challenge, and adjudication.`,
    '',
  );

  if (unanchored.length > 0) {
    sections.push('### Findings without a safe line anchor', '');
    for (const finding of unanchored) {
      sections.push(
        `- **${finding.file}** — ${renderFindingComment(finding, rationale.get(finding.finding_id))
          .split('\n')
          .join('\n  ')}`,
      );
    }
    sections.push('');
  }

  if ((verdict.unresolved_uncertainty ?? []).length > 0) {
    sections.push('### Unresolved uncertainty', '');
    sections.push(...(verdict.unresolved_uncertainty ?? []).map((entry) => `- ${entry}`));
    sections.push('');
  }

  if ((verdict.coverage_limitations ?? []).length > 0) {
    sections.push('### Coverage limitations', '');
    sections.push(...(verdict.coverage_limitations ?? []).map((entry) => `- ${entry}`));
    sections.push('');
  }

  sections.push(
    '<details><summary>Review record</summary>',
    '',
    `- Protocol: v${verdict.protocol_version}`,
    `- Reviewed: \`${verdict.reviewed_sha.slice(0, 7)}\` against \`${(verdict.base_sha ?? '').slice(0, 7)}\``,
    `- Coverage: ${verdict.coverage}`,
    `- Candidates: ${verdict.candidate_count} · rejected: ${verdict.rejected_count}`,
    `- Files in scope: ${context.files.length}`,
    '',
    '</details>',
    '',
    'Reply in a thread to challenge a finding, or comment `@half-shell verify` after pushing a fix.',
  );

  return sections.join('\n');
}
