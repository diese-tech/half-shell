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
import { isDuplicateDelivery, isSameGenerationAlreadyHandled, nextGeneration, runsToSupersede } from './identity.js';
import { newReviewId } from './ids.js';
import { runCaseFile } from './phases/caseFile.js';
import { runIndependentReview } from './phases/independentReview.js';
import { runLeoReview } from './phases/leoReview.js';
import { applyLessons, runMentorship } from './phases/mentorship.js';
import { DEFAULT_PUBLICATION_POLICY, publish, type PublicationGitHubClient, type PublicationPolicy } from './phases/publication.js';
import { spar } from './phases/sparring.js';
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
  publicationPolicy?: PublicationPolicy;
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

  if (isSameGenerationAlreadyHandled(existing, input.headSha)) {
    const run = existing.find((r) => r.headSha === input.headSha) as ReviewRun;
    // Still worth resuming in case it stalled mid-phase.
    await advance(deps, run, input);
    return { reviewId: run.id, outcome: 'already_handled_generation' };
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
 */
export async function advance(deps: EngineDependencies, run: ReviewRun, input: WebhookIngestInput): Promise<ReviewRun> {
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

      if (!early) {
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
    const result = await publish(store, deps.githubClient, current, verdict, input.installationId, input.repo, deps.publicationPolicy ?? DEFAULT_PUBLICATION_POLICY);
    if (result.outcome === 'superseded_stale_sha') {
      return (await store.getReviewRun(current.id)) as ReviewRun;
    }
    current = (await store.getReviewRun(current.id)) as ReviewRun;
  }

  return current;
}
