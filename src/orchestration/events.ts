/**
 * Append-only council event helpers (Issue #12 section 13). The store
 * assigns the monotonic sequence; this module is the one place that
 * decides what's public (safe for the GitHub review) vs. internal-only
 * (kept for the future Dojo web app but never rendered to GitHub) — see
 * conversation_visibility in config/council/orchestration.yaml.
 */
import { newEventId } from './ids.js';
import type { OrchestrationStore } from './store.js';
import type { CouncilEvent, CouncilEventType, EventActor, Phase } from './types.js';

/** Event types the future Dojo web app can show but a GitHub review comment never includes. */
const INTERNAL_ONLY_EVENT_TYPES: ReadonlySet<CouncilEventType> = new Set([
  'persona_message',
  'challenge',
  'challenge_answered',
  'challenge_accepted',
  'experiment_proposed',
  'observation_recorded',
  'lesson_added',
  'finding_withdrawn',
]);

export function isPublicEvent(event: CouncilEvent): boolean {
  return !INTERNAL_ONLY_EVENT_TYPES.has(event.eventType);
}

export function publicEvents(events: CouncilEvent[]): CouncilEvent[] {
  return events.filter(isPublicEvent);
}

export interface RecordEventInput {
  reviewId: string;
  phase: Phase;
  actor: EventActor;
  eventType: CouncilEventType;
  findingId?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordEvent(store: OrchestrationStore, input: RecordEventInput): Promise<CouncilEvent> {
  return store.appendEvent({
    id: newEventId(),
    reviewId: input.reviewId,
    phase: input.phase,
    actor: input.actor,
    eventType: input.eventType,
    findingId: input.findingId ?? null,
    content: input.content ?? null,
    metadata: input.metadata ?? null,
    createdAt: new Date().toISOString(),
  });
}
