/**
 * INDEPENDENT_REVIEW (Issue #12 section 5). Raph, Donnie, Mikey, and Casey
 * run in parallel and never see each other's output during this phase —
 * each gets the same change context and nothing else, so a shared
 * conclusion later in Synthesis is genuine independent corroboration, not
 * anchoring. A lane that fails is reported as missing, never silently
 * folded into "reviewed, found nothing."
 */
import { log, errorFields } from '../../logger.js';
import type { PersonaConfig } from '../../personas/types.js';
import { parseJsonObject } from '../../providers/json.js';
import type { ModelProvider } from '../provider.js';
import { personaSystemPrompt } from '../prompt.js';
import type { RawFinding } from '../synthesis.js';
import type { FindingCategory, PersonaCodename } from '../types.js';

export const INDEPENDENT_REVIEWERS: PersonaCodename[] = ['raph', 'donnie', 'mikey', 'casey'];

const INSTRUCTION = [
  'Phase: INDEPENDENT_REVIEW. You cannot see any other reviewer\'s findings —',
  'this is your own independent pass. Report only what your lane actually',
  'covers. An empty array is the correct answer when you found nothing.',
  '',
  'Respond with a single JSON object: {"findings": [...]} where each finding is:',
  '{',
  '  "category": "bug|regression|security|contract|incomplete_change|missing_test|undocumented_behavior|operational|human_experience|operational_abuse|engineering_discipline",',
  '  "claim": "one sentence stating the defect",',
  '  "evidence": "what in the diff or context proves it",',
  '  "quote": "one line copied exactly from the changed files that the claim is about",',
  '  "file": "path exactly as shown in the diff",',
  '  "line": head-side line number, or null,',
  '  "consequence": "the concrete way this fails at runtime or in practice",',
  '  "confidence": 0.0-1.0,',
  '  "proposed_fix": "the smallest correction that resolves it, or null",',
  '  "root_cause": "why it happens, or null if only the symptom is known"',
  '}',
].join('\n');

export interface LaneOutcome {
  persona: PersonaCodename;
  ok: boolean;
  findings: RawFinding[];
  error?: string;
}

export async function runIndependentReview(
  providerFor: (persona: PersonaCodename) => ModelProvider,
  personaFor: (persona: PersonaCodename) => PersonaConfig,
  changeContext: string,
): Promise<LaneOutcome[]> {
  return Promise.all(INDEPENDENT_REVIEWERS.map((persona) => runLane(providerFor(persona), personaFor(persona), changeContext)));
}

async function runLane(
  provider: ModelProvider,
  persona: PersonaConfig,
  changeContext: string,
  attempts = 2,
): Promise<LaneOutcome> {
  const codename = persona.codename as PersonaCodename;
  let lastError = 'no attempts made';
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const response = await provider.generate({
        persona: codename,
        phase: 'INDEPENDENT_REVIEW',
        systemPrompt: personaSystemPrompt(persona, INSTRUCTION),
        userPrompt: changeContext,
        json: true,
        temperature: 0.15,
      });
      // parseJsonObject returning undefined means the response genuinely
      // did not parse — distinct from a well-formed {"findings": []},
      // which is a legitimate clean result and must not be retried or
      // treated as a failure.
      const parsed = parseJsonObject<Record<string, unknown>>(response.text);
      if (!parsed) {
        lastError = 'response was not valid JSON';
        continue;
      }
      const raw = Array.isArray(parsed['findings']) ? (parsed['findings'] as Record<string, unknown>[]) : [];
      const grounding = groundingText(changeContext);
      const findings = raw
        .map((item) => normalize(item, codename, grounding))
        .filter((finding): finding is RawFinding => finding !== undefined);
      if (findings.length < raw.length) {
        log.info('dropped unusable or ungrounded findings', { persona: codename, kept: findings.length, dropped: raw.length - findings.length });
      }
      return { persona: codename, ok: true, findings };
    }
    log.warn('independent review lane failed validation after retries', { persona: codename, error: lastError });
    return { persona: codename, ok: false, findings: [], error: lastError };
  } catch (error) {
    log.warn('independent review lane failed', { persona: codename, ...errorFields(error) });
    return {
      persona: codename,
      ok: false,
      findings: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const CATEGORIES = new Set<FindingCategory>([
  'bug',
  'regression',
  'security',
  'contract',
  'incomplete_change',
  'missing_test',
  'undocumented_behavior',
  'operational',
  'human_experience',
  'operational_abuse',
  'engineering_discipline',
]);

const CODE_HEADING = 'Changed files (line numbers are the head-side truth):';
/** Shorter quotes ("}", "return x;") match almost any diff and prove nothing. */
const MIN_QUOTE_CHARS = 12;
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * The code a quote must come from: the rendered diffs and related files,
 * not the PR description above them, which is free text the author wrote.
 */
export function groundingText(changeContext: string): string {
  const at = changeContext.indexOf(CODE_HEADING);
  return squash(at === -1 ? changeContext : changeContext.slice(at + CODE_HEADING.length));
}

/**
 * A claim is grounded when it quotes, verbatim, a line that actually exists
 * in the change. Small models invent defects in code they never looked at;
 * a quote that isn't there is the cheapest deterministic tell
 * (review-policy.md section 8).
 */
export function isGrounded(quote: string, grounding: string): boolean {
  const needle = squash(quote);
  return needle.length >= MIN_QUOTE_CHARS && grounding.includes(needle);
}

// Severity is not modeled here — only Leo assigns it, in LEO_REVIEW.
function normalize(item: Record<string, unknown>, persona: PersonaCodename, grounding: string): RawFinding | undefined {
  const category = String(item['category'] ?? '').toLowerCase() as FindingCategory;
  const file = typeof item['file'] === 'string' ? item['file'].trim() : '';
  const text = (key: string): string => (typeof item[key] === 'string' ? (item[key] as string).trim() : '');

  if (!CATEGORIES.has(category) || !file) return undefined;
  const claim = text('claim');
  const evidence = text('evidence');
  const consequence = text('consequence');
  if (!claim || !evidence || !consequence) return undefined;
  const quote = text('quote');
  if (!isGrounded(quote, grounding)) return undefined;

  const confidence = Number(item['confidence']);
  const line = Number(item['line']);

  return {
    sourcePersona: persona,
    category,
    claim,
    // Carried into Sparring and Leo's view, so the line can also refute the claim.
    evidence: `${evidence}\nQuoted: ${quote}`,
    affectedCode: {
      file,
      line: Number.isInteger(line) && line >= 1 ? line : null,
      startLine: null,
    },
    consequence,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.5,
    proposedFix: typeof item['proposed_fix'] === 'string' ? item['proposed_fix'] : null,
    rootCause: typeof item['root_cause'] === 'string' ? item['root_cause'] : null,
  };
}
