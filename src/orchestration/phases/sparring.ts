/**
 * SPARRING (Issue #12 section 9). Shredder challenges each surviving
 * finding within a code-enforced budget (see ../sparring.ts) — the model
 * is asked to behave, but the loop itself cannot run longer than the
 * tracker allows regardless of what any persona's response says.
 */
import { log, errorFields } from '../../logger.js';
import type { PersonaConfig } from '../../personas/types.js';
import { parseJsonObject } from '../../providers/json.js';
import type { ModelProvider } from '../provider.js';
import { personaSystemPrompt } from '../prompt.js';
import { anonymize } from '../synthesis.js';
import { DEFAULT_CHALLENGE_BUDGET, SparringChallengeTracker, type ChallengeBudgetConfig } from '../sparring.js';
import type { CouncilFinding, PersonaCodename } from '../types.js';

const SHREDDER_INSTRUCTION = [
  'Phase: SPARRING. You are looking at one anonymous finding. Decide: does',
  'it survive as stated, or do you have a specific objection?',
  '',
  'Respond with a single JSON object:',
  '{',
  '  "action": "challenge" | "accept" | "recommend_withdrawal",',
  '  "target_claim": "the exact part of the claim you are challenging — required if action is challenge",',
  '  "weakness": "the specific weakness — required if action is challenge",',
  '  "evidence_required": "what would answer this objection — required if action is challenge",',
  '  "reasoning": "one or two sentences"',
  '}',
  '',
  'Every challenge must name a genuinely new weakness. Restating an objection',
  'that already got answered in this transcript is not a new challenge.',
].join('\n');

const DEFENSE_INSTRUCTION = [
  'Phase: SPARRING. Shredder has challenged your finding. Answer with',
  'evidence, or concede the point.',
  '',
  'Respond with a single JSON object:',
  '{',
  '  "action": "defend" | "narrow" | "withdraw",',
  '  "additional_evidence": "new evidence answering the challenge, or null",',
  '  "narrowed_claim": "a smaller, fully-supported version of the claim, or null"',
  '}',
].join('\n');

interface ShredderTurn {
  action: 'challenge' | 'accept' | 'recommend_withdrawal';
  targetClaim: string;
  weakness: string;
  evidenceRequired: string;
  /** True when the model's response didn't parse and this is a fail-safe default, not a genuine decision. */
  malformed: boolean;
}

interface DefenseTurn {
  action: 'defend' | 'narrow' | 'withdraw';
  additionalEvidence: string | null;
  narrowedClaim: string | null;
  malformed: boolean;
}

export interface SparringOutcome {
  finding: CouncilFinding;
  challengesRaised: number;
  transcriptEvents: { actor: PersonaCodename | 'orchestrator'; eventType: string; content: string }[];
}

async function askShredder(provider: ModelProvider, persona: PersonaConfig, finding: CouncilFinding, transcript: string): Promise<ShredderTurn> {
  const response = await provider.generate({
    persona: 'shredder',
    phase: 'SPARRING',
    systemPrompt: personaSystemPrompt(persona, SHREDDER_INSTRUCTION),
    userPrompt: [`Finding: ${JSON.stringify(anonymize(finding))}`, '', `Transcript so far:\n${transcript || '(none yet)'}`].join('\n'),
    json: true,
    temperature: 0.2,
  });
  const parsed = parseJsonObject<Record<string, unknown>>(response.text);
  const action = parsed?.['action'];
  if (action !== 'challenge' && action !== 'accept' && action !== 'recommend_withdrawal') {
    // A response that doesn't parse defaults to "accept" as a fail-safe —
    // never let malformed output either fabricate a challenge or spin the
    // loop — but it is flagged malformed so the caller can log/record it
    // rather than this looking like a genuine concession.
    return { action: 'accept', targetClaim: '', weakness: '', evidenceRequired: '', malformed: true };
  }
  return {
    action,
    targetClaim: typeof parsed?.['target_claim'] === 'string' ? (parsed['target_claim'] as string) : '',
    weakness: typeof parsed?.['weakness'] === 'string' ? (parsed['weakness'] as string) : '',
    evidenceRequired: typeof parsed?.['evidence_required'] === 'string' ? (parsed['evidence_required'] as string) : '',
    malformed: false,
  };
}

async function askDefender(provider: ModelProvider, persona: PersonaConfig, finding: CouncilFinding, challenge: ShredderTurn): Promise<DefenseTurn> {
  const response = await provider.generate({
    persona: persona.codename as PersonaCodename,
    phase: 'SPARRING',
    systemPrompt: personaSystemPrompt(persona, DEFENSE_INSTRUCTION),
    userPrompt: [
      `Your finding: ${JSON.stringify(anonymize(finding))}`,
      `Shredder's challenge: targets "${challenge.targetClaim}" — ${challenge.weakness}`,
      `Evidence that would answer it: ${challenge.evidenceRequired}`,
    ].join('\n'),
    json: true,
    temperature: 0.15,
  });
  const parsed = parseJsonObject<Record<string, unknown>>(response.text);
  const action = parsed?.['action'];
  return {
    action: action === 'narrow' || action === 'withdraw' ? action : 'defend',
    additionalEvidence: typeof parsed?.['additional_evidence'] === 'string' ? (parsed['additional_evidence'] as string) : null,
    narrowedClaim: typeof parsed?.['narrowed_claim'] === 'string' ? (parsed['narrowed_claim'] as string) : null,
    malformed: parsed === undefined,
  };
}

/** A finding that survived without ever being narrowed keeps its plain "surviving" status; one already narrowed stays narrowed. */
function settleStatus(status: CouncilFinding['status']): CouncilFinding['status'] {
  return status === 'narrowed' ? 'narrowed' : 'surviving_sparring';
}

/**
 * Runs one finding through Sparring. The hard round cap below is a second,
 * independent backstop on top of the budget tracker — even a bug in the
 * tracker's accounting cannot make this loop unbounded.
 */
export async function spar(
  shredderProvider: ModelProvider,
  shredderPersona: PersonaConfig,
  defenderProvider: ModelProvider,
  defenderPersona: PersonaConfig,
  finding: CouncilFinding,
  tracker: SparringChallengeTracker = new SparringChallengeTracker(DEFAULT_CHALLENGE_BUDGET),
  budget: ChallengeBudgetConfig = DEFAULT_CHALLENGE_BUDGET,
): Promise<SparringOutcome> {
  const events: SparringOutcome['transcriptEvents'] = [];
  const transcriptLines: string[] = [];
  let current = finding;
  const hardRoundCap = budget.initialChallengesPerFinding + budget.followUpRounds + 1;
  let respondsToNewEvidence = false;

  for (let round = 0; round < hardRoundCap; round += 1) {
    let shredderTurn: ShredderTurn;
    try {
      shredderTurn = await askShredder(shredderProvider, shredderPersona, current, transcriptLines.join('\n'));
    } catch (error) {
      log.warn('shredder call failed during sparring', errorFields(error));
      break;
    }

    if (shredderTurn.malformed) {
      log.warn('shredder response did not parse; treating as accept', { findingId: current.id });
      events.push({ actor: 'orchestrator', eventType: 'challenge', content: 'validation_failed: shredder response did not parse, defaulted to accept' });
    }

    if (shredderTurn.action !== 'challenge') {
      events.push({ actor: 'shredder', eventType: shredderTurn.action === 'accept' ? 'challenge_accepted' : 'challenge', content: 'no further objection' });
      // A finding an earlier round already narrowed stays narrowed — this
      // is Shredder declining to raise anything further, not a reason to
      // erase what the finding already survived as.
      current = { ...current, status: shredderTurn.action === 'recommend_withdrawal' ? 'withdrawn' : settleStatus(current.status) };
      break;
    }

    const decision = tracker.evaluate({
      findingId: current.id,
      targetClaim: shredderTurn.targetClaim,
      weakness: shredderTurn.weakness,
      evidenceRequired: shredderTurn.evidenceRequired,
      respondsToNewEvidence,
    });

    if (!decision.accepted) {
      events.push({ actor: 'orchestrator', eventType: 'challenge', content: `rejected: ${decision.reason}` });
      // Same reasoning: a rejected (budget-exhausted or goalpost-violating)
      // challenge attempt doesn't undo a narrowing or evidence addition an
      // earlier, validly-accepted challenge already produced.
      current = { ...current, status: settleStatus(current.status) };
      break;
    }

    tracker.recordChallenge({
      findingId: current.id,
      targetClaim: shredderTurn.targetClaim,
      weakness: shredderTurn.weakness,
      evidenceRequired: shredderTurn.evidenceRequired,
      respondsToNewEvidence,
    });
    events.push({ actor: 'shredder', eventType: 'challenge', content: `${shredderTurn.targetClaim} — ${shredderTurn.weakness}` });
    transcriptLines.push(`Shredder challenged: ${shredderTurn.targetClaim} — ${shredderTurn.weakness}`);

    let defense: DefenseTurn;
    try {
      defense = await askDefender(defenderProvider, defenderPersona, current, shredderTurn);
    } catch (error) {
      log.warn('defender call failed during sparring', errorFields(error));
      break;
    }

    if (defense.malformed) {
      log.warn('defender response did not parse; treating as a bare defend with no new evidence', { findingId: current.id });
      events.push({ actor: 'orchestrator', eventType: 'challenge_answered', content: 'validation_failed: defender response did not parse, defaulted to defend' });
    }

    if (defense.action === 'withdraw') {
      events.push({ actor: current.sourcePersona, eventType: 'challenge_answered', content: 'withdrawn' });
      current = { ...current, status: 'withdrawn' };
      break;
    }

    respondsToNewEvidence = Boolean(defense.additionalEvidence);
    transcriptLines.push(`Response: ${defense.additionalEvidence ?? defense.narrowedClaim ?? '(no new evidence)'}`);
    events.push({ actor: current.sourcePersona, eventType: 'challenge_answered', content: defense.additionalEvidence ?? defense.narrowedClaim ?? '' });

    if (defense.action === 'narrow' && defense.narrowedClaim) {
      current = { ...current, claim: defense.narrowedClaim, status: 'narrowed' };
    } else if (defense.additionalEvidence) {
      current = { ...current, evidence: `${current.evidence}\n${defense.additionalEvidence}` };
    }
  }

  if (current.status === 'candidate') {
    // Ran out of rounds without an explicit accept — treat as survived
    // rather than silently dropping it; Leo makes the actual call.
    current = { ...current, status: 'surviving_sparring' };
  }

  return { finding: current, challengesRaised: tracker.challengesRaised(finding.id), transcriptEvents: events };
}
