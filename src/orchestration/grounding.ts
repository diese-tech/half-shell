/**
 * Quote provenance for Council findings (review-policy.md section 8, Quote
 * grounding). Every independent-review finding must quote, verbatim, a line
 * from the changed file it claims — not merely something that appears
 * somewhere in the prompt. Small models cite real text from the wrong file
 * (or from the PR description), so grounding is checked per file, against
 * the head-side line numbers the rendered diff carries.
 *
 * Fails closed: if the changed-files section of the rendered context can't
 * be parsed, nothing is grounded. Falling back to the whole context would
 * let PR-description text satisfy grounding, which the policy forbids.
 */

const CODE_HEADING = 'Changed files (line numbers are the head-side truth):';
/** Where the changed-files section ends (src/council/prompt.ts, src/github/related.ts). */
const SECTION_ENDS = ['Files omitted from this prompt for size', 'Related context — these files are NOT part of this change'];
/** `--- path (status, +A/-D)`, exactly as renderChange writes each changed file. */
const FILE_HEADER = /^--- (.+) \(([a-z]+), \+\d+\/-\d+\)$/;
/** Head-side lines from annotatePatch: `   12 + code` (added) or `   12   code` (context). */
const NUMBERED = /^\s*(\d+) [+ ] (.*)$/;
/** Removed lines carry no head-side number: `     -  code`. */
const REMOVED = /^\s+- {2}(.*)$/;

/** Shorter quotes ("}", "return x;") match almost any diff and prove nothing. */
export const MIN_QUOTE_CHARS = 12;
/** Same slack anchorLine (src/github/diff.ts) gives a model's line number. */
export const LINE_TOLERANCE = 5;

export interface RenderedLine {
  line: number | null;
  code: string;
}

/** Changed file path -> its rendered lines, in order. Empty when unparseable. */
export type ChangedFiles = Map<string, RenderedLine[]>;

export type DropReason = 'ungrounded_quote' | 'provenance_mismatch';

export type Grounding =
  | { ok: true; file: string; index: number }
  | { ok: false; reason: DropReason; detail: string };

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function parseChangedFiles(changeContext: string): ChangedFiles {
  const files: ChangedFiles = new Map();
  const start = changeContext.indexOf(CODE_HEADING);
  if (start === -1) return files;
  let section = changeContext.slice(start + CODE_HEADING.length);
  for (const marker of SECTION_ENDS) {
    const end = section.indexOf(marker);
    if (end !== -1) section = section.slice(0, end);
  }

  let current: RenderedLine[] | undefined;
  for (const raw of section.split('\n')) {
    const header = FILE_HEADER.exec(raw);
    if (header) {
      current = [];
      files.set(header[1] as string, current);
      continue;
    }
    if (!current) continue;
    const numbered = NUMBERED.exec(raw);
    if (numbered) {
      current.push({ line: Number(numbered[1]), code: numbered[2] as string });
      continue;
    }
    const removed = REMOVED.exec(raw);
    if (removed) current.push({ line: null, code: removed[1] as string });
    // Hunk headers, "(no textual diff available)", truncation notes: no code.
  }
  return files;
}

/**
 * Checks that `quote` is a line of the claimed changed file and, when the
 * finding names a line and the matching lines carry head-side numbers, that
 * it sits within LINE_TOLERANCE of it.
 */
export function groundQuote(files: ChangedFiles, claim: { file: string; line: number | null; quote: string }): Grounding {
  const needle = squash(claim.quote);
  if (needle.length < MIN_QUOTE_CHARS) {
    return { ok: false, reason: 'ungrounded_quote', detail: 'quote missing or shorter than a line' };
  }
  const hitsIn = (lines: RenderedLine[]): number[] =>
    lines.flatMap((rendered, index) => (squash(rendered.code).includes(needle) ? [index] : []));

  const lines = files.get(claim.file);
  const hits = lines ? hitsIn(lines) : [];
  if (hits.length === 0) {
    const elsewhere = [...files].find(([path, other]) => path !== claim.file && hitsIn(other).length > 0)?.[0];
    if (elsewhere) return { ok: false, reason: 'provenance_mismatch', detail: `quote is from ${elsewhere}, not ${claim.file}` };
    if (!lines) return { ok: false, reason: 'provenance_mismatch', detail: `${claim.file} is not a changed file in this review` };
    return { ok: false, reason: 'ungrounded_quote', detail: `quote does not appear in ${claim.file}` };
  }

  const claimed = claim.line;
  const numbered = hits.filter((index) => lines![index]!.line !== null);
  if (claimed === null || numbered.length === 0) return { ok: true, file: claim.file, index: hits[0]! };
  const distance = (index: number) => Math.abs(lines![index]!.line! - claimed);
  const nearest = numbered.reduce((best, index) => (distance(index) < distance(best) ? index : best));
  if (distance(nearest) > LINE_TOLERANCE) {
    return { ok: false, reason: 'provenance_mismatch', detail: `quote is at line ${lines![nearest]!.line}, not near claimed line ${claimed}` };
  }
  return { ok: true, file: claim.file, index: nearest };
}

/** A bounded slice of the claimed file around a grounded quote — the only code a verifier sees. */
export function excerptAround(files: ChangedFiles, grounded: { file: string; index: number }, radius = 6, maxChars = 1500): string {
  const lines = files.get(grounded.file) ?? [];
  const slice = lines.slice(Math.max(0, grounded.index - radius), grounded.index + radius + 1);
  return slice
    .map((rendered) => `${rendered.line === null ? '    -' : String(rendered.line).padStart(5, ' ')}  ${rendered.code}`)
    .join('\n')
    .slice(0, maxChars);
}

const QUOTE_MARKER = '\nQuoted: ';

/** Appends the grounded quote to a finding's evidence, so later phases and Leo see the line. */
export function withQuote(evidence: string, quote: string): string {
  return `${evidence}${QUOTE_MARKER}${quote}`;
}

/** The quote a grounded finding carries in its evidence, or undefined when it has none. */
export function quotedLine(evidence: string): string | undefined {
  const at = evidence.lastIndexOf(QUOTE_MARKER);
  return at === -1 ? undefined : evidence.slice(at + QUOTE_MARKER.length).trim() || undefined;
}
