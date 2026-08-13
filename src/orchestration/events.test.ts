import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPublicEvent, publicEvents, recordEvent } from './events.js';
import { OrchestrationStore } from './store.js';
import type { CouncilEvent } from './types.js';

function event(overrides: Partial<CouncilEvent> = {}): CouncilEvent {
  return {
    id: 'evt_1',
    reviewId: 'rev_1',
    sequence: 1,
    phase: 'SPARRING',
    actor: 'shredder',
    eventType: 'challenge',
    findingId: null,
    content: null,
    metadata: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('isPublicEvent / publicEvents', () => {
  it('excludes internal Sparring chatter from the public view', () => {
    expect(isPublicEvent(event({ eventType: 'challenge' }))).toBe(false);
    expect(isPublicEvent(event({ eventType: 'persona_message' }))).toBe(false);
    expect(isPublicEvent(event({ eventType: 'finding_withdrawn' }))).toBe(false);
  });

  it('keeps verdict, findings, and phase markers public', () => {
    expect(isPublicEvent(event({ eventType: 'verdict_recorded' }))).toBe(true);
    expect(isPublicEvent(event({ eventType: 'finding_created' }))).toBe(true);
    expect(isPublicEvent(event({ eventType: 'phase_completed' }))).toBe(true);
  });

  it('filters a mixed stream down to only the public events', () => {
    const events = [
      event({ eventType: 'phase_started' }),
      event({ eventType: 'challenge' }),
      event({ eventType: 'challenge_answered' }),
      event({ eventType: 'verdict_recorded' }),
      event({ eventType: 'github_publication_completed' }),
    ];
    expect(publicEvents(events).map((e) => e.eventType)).toEqual([
      'phase_started',
      'verdict_recorded',
      'github_publication_completed',
    ]);
  });
});

describe('event stream persistence — sequence is monotonic per review', () => {
  let store: OrchestrationStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'half-shell-orch-events-'));
    store = new OrchestrationStore(join(dir, 'orch.db'));
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('assigns sequence numbers 1, 2, 3, ... in append order for one review', async () => {
    const first = await recordEvent(store, { reviewId: 'rev_1', phase: 'RECEIVED', actor: 'orchestrator', eventType: 'phase_started' });
    const second = await recordEvent(store, { reviewId: 'rev_1', phase: 'CASE_FILE', actor: 'april', eventType: 'evidence_added' });
    const third = await recordEvent(store, { reviewId: 'rev_1', phase: 'CASE_FILE', actor: 'orchestrator', eventType: 'phase_completed' });
    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
  });

  it('keeps sequences independent per review', async () => {
    await recordEvent(store, { reviewId: 'rev_a', phase: 'RECEIVED', actor: 'orchestrator', eventType: 'phase_started' });
    const firstForB = await recordEvent(store, { reviewId: 'rev_b', phase: 'RECEIVED', actor: 'orchestrator', eventType: 'phase_started' });
    expect(firstForB.sequence).toBe(1);
  });

  it('preserves enough fields to reconstruct the Dojo timeline: actor, phase, finding linkage, and content', async () => {
    const recorded = await recordEvent(store, {
      reviewId: 'rev_1',
      phase: 'SPARRING',
      actor: 'shredder',
      eventType: 'challenge',
      findingId: 'finding_1',
      content: 'You have shown possibility. Not impact.',
      metadata: { challenge_category: 'impact' },
    });
    const [stored] = await store.listEvents('rev_1');
    expect(stored).toEqual(recorded);
    expect(stored?.findingId).toBe('finding_1');
    expect(stored?.content).toContain('possibility');
    expect(stored?.metadata).toEqual({ challenge_category: 'impact' });
  });

  it('returns events in sequence order regardless of any other ordering', async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordEvent(store, { reviewId: 'rev_1', phase: 'SPARRING', actor: 'orchestrator', eventType: 'phase_started', content: `${i}` });
    }
    const events = await store.listEvents('rev_1');
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.map((e) => e.content)).toEqual(['0', '1', '2', '3', '4']);
  });
});
