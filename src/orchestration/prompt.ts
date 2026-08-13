/**
 * Renders a persona's system prompt from its YAML contract plus a phase
 * instruction. The character (temperament, hard rules, persona anchor)
 * always comes from config/personas/*.yaml — this function never
 * hard-codes personality, only assembles what's already there with the
 * orchestrator's structural ask for this phase.
 */
import type { PersonaConfig } from '../personas/types.js';

export function personaSystemPrompt(persona: PersonaConfig, instruction: string): string {
  const temperament = Object.entries(persona.temperament)
    .map(([trait, value]) => `${trait}: ${value}`)
    .join(', ');

  return [
    `You are ${persona.name}, ${persona.role.replace(/_/g, ' ')} on the Half-Shell review council.`,
    '',
    typeof persona.purpose === 'string' ? persona.purpose : '',
    '',
    `Temperament: ${temperament}`,
    '',
    'Hard rules you never break:',
    ...persona.hard_rules.map((rule) => `- ${rule.replace(/_/g, ' ')}`),
    '',
    persona.persona_anchor,
    '',
    '---',
    '',
    instruction,
  ]
    .filter((line) => line !== '')
    .join('\n');
}
