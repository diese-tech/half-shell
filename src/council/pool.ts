import type { Finding, Severity } from '../protocol/types.js';
import { SEVERITIES } from '../protocol/types.js';
import type { CandidateFinding, PoolItem } from '../types.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'for',
  'and', 'or', 'not', 'this', 'that', 'it', 'its', 'with', 'when', 'if', 'will', 'can', 'may',
  'does', 'do', 'no', 'but', 'as', 'at', 'by', 'from', 'has', 'have',
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

export function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

function strongest(a: Severity, b: Severity): Severity {
  return severityRank(a) <= severityRank(b) ? a : b;
}

/**
 * Two findings describe the same problem when they sit in the same file and
 * either point at the same region for the same reason, or state the same claim.
 * Touching the same file is never sufficient on its own.
 */
export function isSameProblem(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;

  const claimSimilarity = similarity(a.claim, b.claim);
  if (claimSimilarity >= 0.7) return true;

  const sameCategory = a.category === b.category;
  const nearby =
    a.line !== null && a.line !== undefined && b.line !== null && b.line !== undefined
      ? Math.abs(a.line - b.line) <= 10
      : false;

  return sameCategory && nearby && claimSimilarity >= 0.35;
}

/**
 * Phase 3. Strips authorship and merges semantically equivalent findings while
 * preserving independent corroboration and distinct evidence paths.
 */
export function buildAnonymousPool(candidates: CandidateFinding[]): PoolItem[] {
  const groups: CandidateFinding[][] = [];

  for (const candidate of candidates) {
    const group = groups.find((existing) =>
      existing.some((member) => isSameProblem(member.finding, candidate.finding)),
    );
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }

  const items = groups.map((group) => mergeGroup(group));

  items.sort((a, b) => {
    const bySeverity = severityRank(a.finding.severity) - severityRank(b.finding.severity);
    if (bySeverity !== 0) return bySeverity;
    if (a.finding.file !== b.finding.file) return a.finding.file < b.finding.file ? -1 : 1;
    return (a.finding.line ?? 0) - (b.finding.line ?? 0);
  });

  // Anonymous ids are assigned only after ordering, so nothing about the id
  // leaks which investigator raised the finding.
  return items.map((item, index) => ({
    ...item,
    finding: { ...item.finding, finding_id: `HS-${String(index + 1).padStart(3, '0')}` },
  }));
}

function mergeGroup(group: CandidateFinding[]): PoolItem {
  const primary = [...group].sort((a, b) => {
    const bySeverity = severityRank(a.finding.severity) - severityRank(b.finding.severity);
    if (bySeverity !== 0) return bySeverity;
    return b.finding.confidence - a.finding.confidence;
  })[0] as CandidateFinding;

  const authors = [...new Set(group.map((entry) => entry.author))];
  const merged: Finding = { ...primary.finding };

  merged.severity = group.reduce<Severity>(
    (severity, entry) => strongest(severity, entry.finding.severity),
    primary.finding.severity,
  );
  merged.confidence = Math.max(...group.map((entry) => entry.finding.confidence));
  merged.line = primary.finding.line ?? group.find((e) => e.finding.line != null)?.finding.line ?? null;
  // Independent discovery is corroboration; one investigator repeating itself is not.
  merged.corroboration_count = authors.length;
  merged.corroborating_evidence = [
    ...new Set(
      group
        .filter((entry) => entry !== primary)
        .map((entry) => entry.finding.evidence.trim())
        .filter(Boolean),
    ),
  ];

  return {
    finding: merged,
    authors,
    mergedFrom: group.map((entry) => entry.finding.finding_id),
  };
}

/** The council never sees authorship — this is the deliberation view. */
export function renderPool(pool: PoolItem[]): string {
  if (pool.length === 0) return 'The anonymous finding pool is empty.';
  return pool
    .map((item) => {
      const finding = item.finding;
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      return [
        `Finding ${finding.finding_id}`,
        `Severity: ${finding.severity}`,
        `Category: ${finding.category}`,
        `Confidence: ${finding.confidence.toFixed(2)}`,
        `Location: ${location}`,
        `Independent corroboration: ${finding.corroboration_count}`,
        `Claim: ${finding.claim}`,
        `Evidence: ${finding.evidence}`,
        `Failure mode: ${finding.failure_mode}`,
        `Suggested fix: ${finding.suggested_fix}`,
        ...(finding.corroborating_evidence?.length
          ? [`Additional evidence paths: ${finding.corroborating_evidence.join(' | ')}`]
          : []),
      ].join('\n');
    })
    .join('\n\n');
}
