export interface Persona {
  /** Stable id used in run records. */
  id: string;
  /** Name as it appears in the protocol's Dojo section headings. */
  name: string;
  /** Short lane label used for logging only — the protocol defines the lane. */
  lane: string;
}

/** Investigators run independently in Phase 2 and all critique in Phase 4. */
export const INVESTIGATORS: Persona[] = [
  { id: 'april', name: 'April', lane: 'Context & Intent' },
  { id: 'donatello', name: 'Donatello', lane: 'Architecture & Contracts' },
  { id: 'raphael', name: 'Raphael', lane: 'Runtime & Regression' },
  { id: 'michelangelo', name: 'Michelangelo', lane: 'Completeness & Experience' },
  { id: 'splinter', name: 'Splinter', lane: 'Security & Discipline' },
  { id: 'casey', name: 'Casey Jones', lane: 'Break Testing' },
];

export const SHREDDER: Persona = {
  id: 'shredder',
  name: 'Shredder',
  lane: 'Adversarial Challenger',
};

export const LEONARDO: Persona = {
  id: 'leonardo',
  name: 'Leonardo',
  lane: 'Final Arbiter',
};

/** April owns the Phase 1 factual brief. */
export const BRIEFING_PERSONA = INVESTIGATORS[0] as Persona;

export function personaByName(name: string): Persona | undefined {
  const all = [...INVESTIGATORS, SHREDDER, LEONARDO];
  return all.find((persona) => persona.name.toLowerCase() === name.toLowerCase());
}
