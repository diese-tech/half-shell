/**
 * The council orchestration state machine (Issue #12 section 2). Drives a
 * review through RECEIVED -> ... -> ARCHIVED, persisting every transition
 * before doing the work it implies, so re-invoking ingest()/advance() on a
 * review that already has a current_phase resumes from there rather than
 * repeating work or replaying from RECEIVED. Nothing here depends on
 * process memory surviving between calls.
 */
import type { RepoRef } from '../types.js';
import type { PersonaConfig } from '../personas/types.js';
import { canEarlyExit } from './earlyExit.js';
import { recordEvent } from './events.js';
import { isDuplicateDelivery, nextGeneration, runsToSupersede, sameGenerationRun } from './identity.js';
import { newReviewId } from './ids.js';
import { runCaseFile } from './phases/caseFile.js';
import { runIndependentReview } from './phases/independentReview.js';
import { runLeoReview } from './phases/leoReview.js';
import { applyLessons, runMentorship } from './phases/mentorship.js';
import { publish, type PublicationGitHubClient } from './phases/publication.js';
import { completeWithoutSurvivors, confirmCleanReview, spar } from './phases/sparring.js';
import { verificationSubject, verifyFinding } from './phases/verification.js';
import { parseChangedFiles } from './grounding.js';
import type { ModelProvider } from './provider.js';
import { DEFAULT_CHALLENGE_BUDGET, SparringChallengeTracker, type ChallengeBudgetConfig } from './sparring.js';
import type { OrchestrationStore } from './store.js';
import { synthesize, toCandidate } from './synthesis.js';
import type { CouncilFinding, PersonaCodename, ReviewRun } from './types.js';

export interface EngineDependencies {
  store: OrchestrationStore;
  personas: Map<string, PersonaConfig>;
  providerFor: (persona: PersonaCodename) => ModelProvider;
  githubClient: PublicationGitHubClient;
  challengeBudget?: ChallengeBudgetConfig;
}

export interface WebhookIngestInput {
  repositoryId: string;
  repositoryFullName: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  installationId: number;
  repo: RepoRef;
  githubDeliveryId: string | null;
  trigger: ReviewRun['trigger'];
  /** The change context handed to CASE_FILE and INDEPENDENT_REVIEW as the user prompt. Building this from a real diff is the caller's job. */
  changeContext: string;
  historicalContext?: string;
}

export type IngestOutcome = 'started' | 'duplicate_delivery' | 'already_handled_generation';

function persona(deps: EngineDependencies, codename: PersonaCodename): PersonaConfig {
  const config = deps.personas.get(codename);
  if (!config) throw new Error(`no persona config loaded for "${codename}"`);
  return config;
}

async function transitionTo(store: OrchestrationStore, run: ReviewRun, phase: ReviewRun['currentPhase']): Promise<ReviewRun> {
  const updated: ReviewRun = { ...run, currentPhase: phase, updatedAt: new Date().toISOString() };
  await store.saveReviewRun(updated);
  await recordEvent(store, { reviewId: run.id, phase, actor: 'orchestrator', eventType: 'phase_started' });
  return updated;
}

async function completePhase(store: OrchestrationStore, run: ReviewRun): Promise<void> {
  await recordEvent(store, { reviewId: run.id, phase: run.currentPhase, actor: 'orchestrator', eventType: 'phase_completed' });
}

async function fail(store: OrchestrationStore, run: ReviewRun, status: 'failed_retryable' | 'failed_final', error: string): Promise<ReviewRun> {
  const updated: ReviewRun = { ...run, status, error, updatedAt: new Date().toISOString() };
  await store.saveReviewRun(updated);
  await recordEvent(store, { reviewId: run.id, phase: run.currentPhase, actor: 'orchestrator', eventType: 'run_failed', content: error });
  return updated;
}

const REJECTION_REASON = { CONTRADICTS: 'semantic_contradiction', INSUFFICIENT: 'insufficient_evidence' } as const;

/**
 * Only findings the verifier says their own cited code SUPPORTS go on to
 * Sparring (phases/verification.ts). Every outcome is recorded, with the
 * reason, so drops can be told apart. A finding with no valid verdict
 * (verifier unavailable) is quarantined: never published, and LEO_REVIEW's
 * fail-safe forces the whole review incomplete.
 */
async function verifyCandidates(deps: EngineDependencies, run: ReviewRun, candidates: CouncilFinding[], changeContext: string): Promise<void> {
  const files = parseChangedFiles(changeContext);
  for (const finding of candidates) {
    const base = { reviewId: run.id, phase: 'SYNTHESIS' as const, actor: 'shredder' as const, findingId: finding.id };
    const subject = verificationSubject(finding, files);
    if (!subject) {
      await deps.store.saveFinding({ ...finding, status: 'rejected' });
      await recordEvent(deps.store, { ...base, eventType: 'finding_withdrawn', content: 'rejected (ungrounded_quote): no quote that grounds in its claimed file', metadata: { reason: 'ungrounded_quote' } });
      continue;
    }
    const result = await verifyFinding(deps.providerFor('shredder'), persona(deps, 'shredder'), subject);
    if (!result) {
      // No valid verdict: neither dropped as if refuted nor kept as if verified.
      // Quarantined findings never publish, and the review becomes incomplete.
      await deps.store.saveFinding({ ...finding, status: 'quarantined' });
      await recordEvent(deps.store, { ...base, eventType: 'finding_updated', content: 'quarantined: verifier gave no valid verdict', metadata: { verification: 'unavailable', reason: 'verifier_unavailable' } });
    } else if (result.verdict === 'SUPPORTS') {
      await recordEvent(deps.store, { ...base, eventType: 'finding_updated', content: `verified: SUPPORTS — ${result.reason}`, metadata: { verification: 'SUPPORTS', verifierReason: result.reason } });
    } else {
      const reason = REJECTION_REASON[result.verdict];
      await deps.store.saveFinding({ ...finding, status: 'rejected' });
      await recordEvent(deps.store, {
        ...base,
        eventType: 'finding_withdrawn',
        content: `rejected (${reason}): ${result.verdict} — ${result.reason}`,
        metadata: { reason, verification: result.verdict, verifierReason: result.reason },
      });
    }
  }
}

async function phaseAlreadyCompleted(store: OrchestrationStore, reviewId: string, phase: ReviewRun['currentPhase']): Promise<boolean> {
  const events = await store.listEvents(reviewId);
  return events.some((e) => e.phase === phase && e.eventType === 'phase_completed');
}

/**
 * Handles one webhook-shaped arrival: deduplicates by delivery id,
 * recognizes an already-handled generation, supersedes any older active
 * run for the same PR, and starts (or resumes) the review.
 */
export async function ingest(deps: EngineDependencies, input: WebhookIngestInput): Promise<{ reviewId: string; outcome: IngestOutcome }> {
  const existing = await deps.store.listRunsForPullRequest(input.repositoryId, input.pullRequestNumber);

  if (isDuplicateDelivery(existing, input.githubDeliveryId)) {
    const run = existing.find((r) => r.githubDeliveryId === input.githubDeliveryId) as ReviewRun;
    return { reviewId: run.id, outcome: 'duplicate_delivery' };
  }

  const covering = sameGenerationRun(existing, input.headSha, input.trigger);
  if (covering) {
    // Still worth resuming in case it stalled mid-phase.
    await advance(deps, covering, input);
    return { reviewId: covering.id, outcome: 'already_handled_generation' };
  }

  for (const stale of runsToSupersede(existing, input.headSha)) {
    await recordEvent(deps.store, {
      reviewId: stale.id,
      phase: stale.currentPhase,
      actor: 'orchestrator',
      eventType: 'run_superseded',
      content: `superseded by a newer head SHA (${input.headSha})`,
    });
    await deps.store.saveReviewRun({ ...stale, status: 'superseded', updatedAt: new Date().toISOString() });
  }

  const run: ReviewRun = {
    id: newReviewId(),
    repositoryId: input.repositoryId,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
    baseSha: input.baseSha,
    headSha: input.headSha,
    status: 'running',
    currentPhase: 'RECEIVED',
    generation: nextGeneration(existing),
    trigger: input.trigger,
    supersededByReviewId: null,
    githubDeliveryId: input.githubDeliveryId,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await deps.store.saveReviewRun(run);
  await recordEvent(deps.store, { reviewId: run.id, phase: 'RECEIVED', actor: 'orchestrator', eventType: 'phase_started' });
  await completePhase(deps.store, run);

  await advance(deps, run, input);
  return { reviewId: run.id, outcome: 'started' };
}

/**
 * Drives a run forward from its current phase. Safe to call repeatedly —
 * each phase checks whether its own output already exists before doing
 * any model work again.
 *
 * A phase that throws (e.g. every provider timed out) marks the run
 * failed_retryable instead of leaving it "running" forever with no worker.
 */
export async function advance(deps: EngineDependencies, run: ReviewRun, input: WebhookIngestInput): Promise<ReviewRun> {
  try {
    return await advancePhases(deps, run, input);
  } catch (error) {
    const latest = (await deps.store.getReviewRun(run.id)) ?? run;
    if (latest.status !== 'running') return latest;
    return fail(deps.store, latest, 'failed_retryable', error instanceof Error ? error.message : String(error));
  }
}

async function advancePhases(deps: EngineDependencies, run: ReviewRun, input: WebhookIngestInput): Promise<ReviewRun> {
  const { store } = deps;
  let current = run;
  if (current.status !== 'running') return current;

  // --- CASE_FILE ---
  if (current.currentPhase === 'RECEIVED') current = await transitionTo(store, current, 'CASE_FILE');
  if (current.currentPhase === 'CASE_FILE') {
    let packet = await store.getEvidencePacket(current.id);
    if (!packet) {
      const result = await runCaseFile(deps.providerFor('april'), persona(deps, 'april'), current.id, input.changeContext);
      if (!result.ok || !result.packet) {
        await recordEvent(store, { reviewId: current.id, phase: 'CASE_FILE', actor: 'orchestrator', eventType: 'validation_failed', content: result.error });
        return fail(store, current, 'failed_retryable', result.error ?? 'CASE_FILE produced no usable evidence packet');
      }
      packet = result.packet;
      await store.saveEvidencePacket(packet);
      await recordEvent(store, { reviewId: current.id, phase: 'CASE_FILE', actor: 'april', eventType: 'evidence_added' });
    }
    await completePhase(store, current);
    current = await transitionTo(store, current, 'INDEPENDENT_REVIEW');
  }

  // --- INDEPENDENT_REVIEW ---
  if (current.currentPhase === 'INDEPENDENT_REVIEW') {
    if (!(await phaseAlreadyCompleted(store, current.id, 'INDEPENDENT_REVIEW'))) {
      const outcomes = await runIndependentReview(deps.providerFor, (codename) => persona(deps, codename), input.changeContext);
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          await recordEvent(store, {
            reviewId: current.id,
            phase: 'INDEPENDENT_REVIEW',
            actor: outcome.persona,
            eventType: 'validation_failed',
            content: `lane missing: ${outcome.error ?? 'unknown failure'}`,
          });
          continue;
        }
        // Refused by the provenance gate: never candidates, but kept on the record with why.
        for (const dropped of outcome.dropped) {
          await recordEvent(store, {
            reviewId: current.id,
            phase: 'INDEPENDENT_REVIEW',
            actor: 'orchestrator',
            eventType: 'finding_withdrawn',
            content: `dropped before Sparring (${dropped.reason}): ${dropped.claim} — ${dropped.detail}`,
            metadata: { ...dropped },
          });
        }
        const candidates = outcome.findings.map((raw) => toCandidate(current.id, raw));
        await store.saveFindings(candidates);
        for (const candidate of candidates) {
          await recordEvent(store, {
            reviewId: current.id,
            phase: 'INDEPENDENT_REVIEW',
            actor: outcome.persona,
            eventType: 'finding_created',
            findingId: candidate.id,
          });
        }
      }
    }
    await completePhase(store, current);
    current = await transitionTo(store, current, 'MENTORSHIP');
  }

  // --- MENTORSHIP ---
  if (current.currentPhase === 'MENTORSHIP') {
    if (!(await phaseAlreadyCompleted(store, current.id, 'MENTORSHIP'))) {
      const candidates = (await store.listFindings(current.id)).filter((f) => f.status === 'candidate');
      const mentorship = await runMentorship(deps.providerFor('splinter'), persona(deps, 'splinter'), candidates, input.historicalContext ?? '(no prior history available)');
      if (mentorship.lessons.length > 0) {
        const withLessons = applyLessons(candidates, mentorship.lessons);
        await store.saveFindings(withLessons);
        for (const lesson of mentorship.lessons) {
          await recordEvent(store, {
            reviewId: current.id,
            phase: 'MENTORSHIP',
            actor: 'splinter',
            eventType: 'lesson_added',
            content: lesson.lesson,
          });
        }
      }
      for (const guardrail of mentorship.guardrailRecommendations) {
        await recordEvent(store, { reviewId: current.id, phase: 'MENTORSHIP', actor: 'splinter', eventType: 'lesson_added', content: guardrail, metadata: { kind: 'guardrail_recommendation' } });
      }
    }
    await completePhase(store, current);
    current = await transitionTo(store, current, 'SYNTHESIS');
  }

  // --- SYNTHESIS ---
  if (current.currentPhase === 'SYNTHESIS') {
    if (!(await phaseAlreadyCompleted(store, current.id, 'SYNTHESIS'))) {
      const candidates = (await store.listFindings(current.id)).filter((f) => f.status === 'candidate');
      const synthesized = synthesize(candidates);
      await store.saveFindings(synthesized);
      await verifyCandidates(deps, current, synthesized.filter((f) => f.status === 'candidate'), input.changeContext);
    }
    await completePhase(store, current);
    current = await transitionTo(store, current, 'SPARRING');
  }

  // --- SPARRING (with early exit) ---
  if (current.currentPhase === 'SPARRING') {
    if (!(await phaseAlreadyCompleted(store, current.id, 'SPARRING'))) {
      const survivors = (await store.listFindings(current.id)).filter((f) => f.status === 'candidate' || f.status === 'narrowed');
      const missingLanes = (await store.listEvents(current.id)).some(
        (e) => e.phase === 'INDEPENDENT_REVIEW' && e.eventType === 'validation_failed',
      );

      const early = canEarlyExit({
        caseFileComplete: true,
        allRequiredLanesCleanAndComplete: !missingLanes,
        noUnresolvedContext: (await store.getEvidencePacket(current.id))?.unknowns.length === 0,
        noMaterialObservations: survivors.length === 0,
        noGuardrailOrHistoryTrigger: !(await store.listEvents(current.id)).some((e) => e.eventType === 'lesson_added'),
      });

      if (!early && survivors.length === 0) {
        // Every finding was filtered before Sparring, but early exit didn't
        // apply (e.g. open unknowns). Zero survivors is not clean: Shredder
        // still owes a required adversarial step, on the case file and what
        // was dropped (phases/sparring.ts completeWithoutSurvivors).
        const events = await store.listEvents(current.id);
        const dropped: Record<string, number> = {};
        for (const e of events) {
          const reason = e.metadata?.['reason'];
          if ((e.eventType === 'finding_withdrawn' || e.eventType === 'finding_updated') && typeof reason === 'string') {
            dropped[reason] = (dropped[reason] ?? 0) + 1;
          }
        }
        const completion = await completeWithoutSurvivors(
          deps.providerFor('shredder'),
          persona(deps, 'shredder'),
          JSON.stringify({ survivingFindings: 0, droppedBeforeSparring: dropped, caseFile: (await store.getEvidencePacket(current.id)) ?? {} }),
        );
        await recordEvent(store, {
          reviewId: current.id,
          phase: 'SPARRING',
          actor: 'shredder',
          // CONCUR_CLEAN counts as Shredder completing; anything else is recorded
          // so LEO_REVIEW's fail-safe refuses a clean verdict.
          eventType: !completion.ok ? 'validation_failed' : completion.result === 'CONCUR_CLEAN' ? 'challenge_accepted' : 'observation_recorded',
          content: completion.ok ? `${completion.result}: ${completion.note}` : completion.note,
          metadata: { completion: completion.result ?? 'unavailable' },
        });
      } else if (!early) {
        const tracker = new SparringChallengeTracker(deps.challengeBudget ?? DEFAULT_CHALLENGE_BUDGET);
        const settled: CouncilFinding[] = [];
        for (const finding of survivors) {
          const outcome = await spar(
            deps.providerFor('shredder'),
            persona(deps, 'shredder'),
            deps.providerFor(finding.sourcePersona),
            persona(deps, finding.sourcePersona),
            finding,
            tracker,
            deps.challengeBudget ?? DEFAULT_CHALLENGE_BUDGET,
          );
          settled.push(outcome.finding);
          for (const event of outcome.transcriptEvents) {
            await recordEvent(store, {
              reviewId: current.id,
              phase: 'SPARRING',
              actor: event.actor,
              eventType: event.eventType as never,
              findingId: outcome.finding.id,
              content: event.content,
            });
          }
        }
        await store.saveFindings(settled);
      } else {
        // Early exit skips the per-finding challenge loop (there is nothing
        // to challenge), but Shredder's participation is still required by
        // policy — review-policy.md section 17, D050. Without this, a clean
        // review could publish having never actually invited its adversary,
        // which is exactly the manufactured confidence the fail-safe below
        // exists to prevent.
        const packet = await store.getEvidencePacket(current.id);
        const confirmation = await confirmCleanReview(
          deps.providerFor('shredder'),
          persona(deps, 'shredder'),
          JSON.stringify(packet ?? {}),
        );
        if (!confirmation.ok) {
          await recordEvent(store, {
            reviewId: current.id,
            phase: 'SPARRING',
            actor: 'shredder',
            eventType: 'validation_failed',
            content: confirmation.note,
          });
        } else if (!confirmation.concurs) {
          // Shredder objects, but there is no CouncilFinding to attach this
          // to — the independent lanes never produced one. Recorded so the
          // fail-safe below can see it and refuse a clean verdict; this is
          // deliberately not synthesized into a fabricated finding.
          await recordEvent(store, {
            reviewId: current.id,
            phase: 'SPARRING',
            actor: 'shredder',
            eventType: 'observation_recorded',
            content: confirmation.note || 'objects to treating this review as clean',
          });
        } else {
          await recordEvent(store, {
            reviewId: current.id,
            phase: 'SPARRING',
            actor: 'shredder',
            eventType: 'challenge_accepted',
            content: confirmation.note || 'concurs: nothing here warrants a challenge',
          });
        }
      }
    }
    await completePhase(store, current);
    current = await transitionTo(store, current, 'LEO_REVIEW');
  }

  // --- LEO_REVIEW ---
  if (current.currentPhase === 'LEO_REVIEW') {
    let verdict = await store.getVerdict(current.id);
    if (!verdict) {
      const surviving = (await store.listFindings(current.id)).filter(
        (f) => f.status === 'surviving_sparring' || f.status === 'narrowed' || f.status === 'candidate',
      );
      const sparringEvents = (await store.listEvents(current.id)).filter((e) => e.phase === 'SPARRING');
      const result = await runLeoReview(
        deps.providerFor('leo'),
        persona(deps, 'leo'),
        current.id,
        surviving,
        JSON.stringify(sparringEvents.map((e) => ({ actor: e.actor, type: e.eventType, content: e.content }))),
      );
      if (!result.ok || !result.verdict) {
        await recordEvent(store, { reviewId: current.id, phase: 'LEO_REVIEW', actor: 'orchestrator', eventType: 'validation_failed', content: result.error });
        return fail(store, current, 'failed_retryable', result.error ?? 'LEO_REVIEW produced no usable verdict');
      }
      verdict = result.verdict;

      // Fail-safe invariant (review-policy.md section 18, D050): never
      // manufacture confidence. Enforced here in code, not left to Leo's
      // prompt, regardless of what the model itself concluded. Two ways
      // required coverage can be missing:
      const requiredLaneFailed = (await store.listEvents(current.id)).some(
        (e) => e.phase === 'INDEPENDENT_REVIEW' && e.eventType === 'validation_failed',
      );
      // Shredder is a required role in every review, including the
      // early-exit path (confirmCleanReview in phases/sparring.ts) — a
      // review whose SPARRING phase never actually produced a genuine
      // shredder-attributed result (call failed, or simply never invoked)
      // has not met that requirement, whatever Leo concludes.
      const shredderRequiredRoleMissing = !sparringEvents.some(
        (e) => e.actor === 'shredder' && e.eventType !== 'validation_failed',
      );
      // Shredder can also genuinely object during early exit with no
      // finding to attach the objection to (nothing was material enough to
      // become one) — that objection must not be silently overridden by a
      // "clean" claim either.
      const shredderRaisedUnresolvedObjection = sparringEvents.some(
        (e) => e.actor === 'shredder' && e.eventType === 'observation_recorded',
      );
      const insufficientCoverage = sparringEvents.some(
        (e) => e.actor === 'shredder' && e.metadata?.['completion'] === 'INSUFFICIENT_COVERAGE',
      );
      // A quarantined finding was never verified either way, so nothing about
      // this review is trustworthy as clean, and no verdict here may stand in
      // for it — forced incomplete even if other findings published.
      const verifierQuarantined = (await store.listFindings(current.id)).some((f) => f.status === 'quarantined');
      const anyBlockingPublished = verdict.findings.some((f) => f.outcome === 'publish' && f.blocking);
      const requiredCoverageMissing = requiredLaneFailed || shredderRequiredRoleMissing || shredderRaisedUnresolvedObjection;
      if (verdict.overallOutcome !== 'incomplete' && (verifierQuarantined || (requiredCoverageMissing && !anyBlockingPublished))) {
        const reason = verifierQuarantined
          ? 'a finding was quarantined because its verification gave no valid verdict'
          : requiredLaneFailed
            ? 'a required independent-review lane failed'
            : insufficientCoverage
              ? 'Shredder judged the remaining coverage insufficient to call this clean'
              : shredderRaisedUnresolvedObjection
                ? 'Shredder objected to treating this as a clean review'
                : 'Shredder — a required role in every review — never completed';
        verdict = {
          ...verdict,
          overallOutcome: 'incomplete',
          rationale: `${verdict.rationale} Required coverage was incomplete — ${reason} — so this cannot be published as a clean verdict.`,
        };
      }

      // Leo's free-text overall_outcome is a claim; the label must agree with
      // the decisions it summarizes, the same way publication derives the
      // GitHub event from them. `incomplete` is the one label it can't derive.
      if (verdict.overallOutcome !== 'incomplete') {
        const published = verdict.findings.filter((f) => f.outcome === 'publish');
        verdict = {
          ...verdict,
          overallOutcome: published.some((f) => f.blocking)
            ? 'blocking_findings_published'
            : published.length > 0
              ? 'non_blocking_findings_published'
              : 'clean_review',
        };
      }

      await store.saveVerdict(verdict);
      await recordEvent(store, { reviewId: current.id, phase: 'LEO_REVIEW', actor: 'leo', eventType: 'verdict_recorded' });

      for (const decision of verdict.findings) {
        const finding = await store.getFinding(decision.findingId);
        if (!finding) continue;
        await store.saveFinding({
          ...finding,
          status: decision.outcome === 'publish' ? 'published' : decision.outcome === 'reject' ? 'rejected' : finding.status,
          severity: decision.finalSeverity,
        });
      }
    }
    await completePhase(store, current);
    current = await transitionTo(store, current, 'PUBLICATION');
  }

  // --- PUBLICATION ---
  if (current.currentPhase === 'PUBLICATION') {
    const verdict = await store.getVerdict(current.id);
    if (!verdict) return fail(store, current, 'failed_final', 'reached PUBLICATION with no recorded verdict');
    const result = await publish(store, deps.githubClient, current, verdict, input.installationId, input.repo);
    if (result.outcome === 'superseded_stale_sha') {
      return (await store.getReviewRun(current.id)) as ReviewRun;
    }
    current = (await store.getReviewRun(current.id)) as ReviewRun;
  }

  return current;
}
