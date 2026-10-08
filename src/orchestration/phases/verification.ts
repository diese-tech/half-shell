/**
 * Semantic verification, run at the end of SYNTHESIS, before Sparring and
 * Leo (review-policy.md section 8, Quote grounding). Provenance proves a
 * quote is a real line of the claimed file; it doesn't prove the line
 * supports the claim. Small models routinely cite a line that refutes
 * their own claim ("missing database unhandled", quoting the existsSync
 * guard).
 *
 * Shredder gets one bounded question per surviving candidate. The input is
 * only the claim, the claimed file, the grounded quote, and a few lines of
 * that file around it: never the whole PR, and never an open-ended review.
 * The answer is SUPPORTS, CONTRADICTS, or INSUFFICIENT, and only SUPPORTS
 * survives.
 *
 * If no answer is available (the call errors, or the reply isn't a valid
 * verdict), the caller keeps the finding unverified rather than dropping it.
 * Otherwise a provider failure could turn a real defect into a "clean"
 * review, which a failed review must never become.
 */
import { log, errorFields } from '../../logger.js';
import type { PersonaConfig } from '../../personas/types.js';
import { parseJsonObject } from '../../providers/json.js';
import { excerptAround, groundQuote, quotedLine, type ChangedFiles } from '../grounding.js';
import type { ModelProvider } from '../provider.js';
import { personaSystemPrompt, untrustedInput } from '../prompt.js';
import type { CouncilFinding } from '../types.js';

export const VERDICTS = ['SUPPORTS', 'CONTRADICTS', 'INSUFFICIENT'] as const;
export type VerificationVerdict = (typeof VERDICTS)[number];

export interface VerificationSubject {
  claim: string;
  file: string;
  quote: string;
  excerpt: string;
}

export interface VerificationResult {
  verdict: VerificationVerdict;
  reason: string;
}

const INSTRUCTION = [
  'Phase: SYNTHESIS — evidence check. This is not a review. You get one claim',
  'that a code change has a DEFECT (something that goes wrong or causes harm),',
  'the file it names, the exact line it quotes, and a few lines of that file',
  'around it. Decide whether THIS code shows that the defect really happens.',
  '',
  'First say what harm the claim asserts. Then say what the code shown',
  'actually does about it. Only then choose the verdict:',
  '',
  '- SUPPORTS: the code shown makes the claimed harm happen.',
  '- CONTRADICTS: the code shown prevents or handles the claimed harm, or the',
  '  text states the behaviour is intentional and bounds the risk. A claim',
  '  whose literal wording is true is still CONTRADICTED when the code shows',
  '  the harm cannot occur.',
  '- INSUFFICIENT: the code shown neither makes the harm happen nor prevents',
  '  it, or the claim depends on code that is not shown.',
  '',
  'Do not look for other problems. Do not guess about code you cannot see.',
  '',
  'Respond with a single JSON object, fields in this order:',
  '{"claimed_harm": "one sentence", "code_shows": "one sentence", "verdict": "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT"}',
].join('\n');

/** What the verifier may see for a finding, or undefined when its quote no longer grounds in the claimed file. */
export function verificationSubject(finding: CouncilFinding, files: ChangedFiles): VerificationSubject | undefined {
  const quote = quotedLine(finding.evidence);
  if (!quote) return undefined;
  const grounded = groundQuote(files, { file: finding.affectedCode.file, line: finding.affectedCode.line, quote });
  if (!grounded.ok) return undefined;
  return { claim: finding.claim, file: grounded.file, quote, excerpt: excerptAround(files, grounded) };
}

export async function verifyFinding(
  provider: ModelProvider,
  shredder: PersonaConfig,
  subject: VerificationSubject,
): Promise<VerificationResult | undefined> {
  try {
    const response = await provider.generate({
      persona: 'shredder',
      phase: 'SYNTHESIS',
      systemPrompt: personaSystemPrompt(shredder, INSTRUCTION),
      userPrompt: [
        `Claim: ${subject.claim}`,
        `File: ${subject.file}`,
        `Quoted line: ${subject.quote}`,
        '',
        'Code around it (head-side line numbers):',
        untrustedInput('github_pull_request', subject.excerpt),
      ].join('\n'),
      json: true,
      temperature: 0,
    });
    const parsed = parseJsonObject<Record<string, unknown>>(response.text);
    const verdict = String(parsed?.['verdict'] ?? '').trim().toUpperCase();
    if (!(VERDICTS as readonly string[]).includes(verdict)) return undefined;
    return { verdict: verdict as VerificationVerdict, reason: String(parsed?.['code_shows'] ?? parsed?.['reason'] ?? '').trim() };
  } catch (error) {
    log.warn('semantic verification unavailable; keeping the finding unverified', errorFields(error));
    return undefined;
  }
}
