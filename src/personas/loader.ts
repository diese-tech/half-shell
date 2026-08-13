import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { load as parseYaml } from 'js-yaml';

import { KNOWN_ROLES, type PersonaConfig } from './types.js';

export class PersonaValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: string[],
  ) {
    super(`${file}: ${issues.join('; ')}`);
    this.name = 'PersonaValidationError';
  }
}

/**
 * Validates one already-parsed YAML document against the minimum contract
 * every persona must satisfy. Returns the specific problems found rather
 * than throwing, so a loader can report every bad file in one pass instead
 * of stopping at the first.
 */
export function validatePersona(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: ['document is not a YAML mapping'] };
  }
  const record = value as Record<string, unknown>;

  const requireString = (key: string): void => {
    if (typeof record[key] !== 'string' || (record[key] as string).trim() === '') {
      errors.push(`missing or empty required field "${key}"`);
    }
  };
  requireString('name');
  requireString('codename');
  requireString('role');
  requireString('persona_anchor');

  if (typeof record['role'] === 'string' && !(KNOWN_ROLES as readonly string[]).includes(record['role'])) {
    errors.push(`role "${record['role']}" is not one of: ${KNOWN_ROLES.join(', ')}`);
  }

  // PersonaConfig types temperament as Record<string, string>: every value
  // must actually be a string, not merely scalar, or a caller that trusts
  // the type (e.g. rendering it straight into a prompt) gets an unsound
  // object out of a "valid" persona.
  const temperament = record['temperament'];
  if (typeof temperament !== 'object' || temperament === null || Array.isArray(temperament)) {
    errors.push('missing "temperament" mapping');
  } else {
    const entries = Object.entries(temperament as Record<string, unknown>);
    const bad = entries.filter(([, v]) => typeof v !== 'string' || v.trim() === '');
    if (entries.length === 0) {
      errors.push('"temperament" must not be empty');
    }
    if (bad.length > 0) {
      errors.push(`"temperament" values must be non-empty strings (machine-readable): ${bad.map(([k]) => k).join(', ')}`);
    }
  }

  const allowedOutcomes = record['allowed_outcomes'];
  if (typeof allowedOutcomes !== 'object' || allowedOutcomes === null || Array.isArray(allowedOutcomes)) {
    errors.push('missing "allowed_outcomes" mapping');
  } else {
    const entries = Object.entries(allowedOutcomes as Record<string, unknown>);
    const bad = entries.filter(([, v]) => typeof v !== 'string' || v.trim() === '');
    if (entries.length === 0) {
      errors.push('"allowed_outcomes" must not be empty');
    }
    if (bad.length > 0) {
      errors.push(`"allowed_outcomes" values must be non-empty strings: ${bad.map(([k]) => k).join(', ')}`);
    }
  }

  const hardRules = record['hard_rules'];
  if (!Array.isArray(hardRules) || hardRules.length === 0) {
    errors.push('missing or empty "hard_rules" list');
  } else if (hardRules.some((rule) => typeof rule !== 'string' || rule.trim() === '')) {
    errors.push('"hard_rules" must be a list of non-empty strings');
  }

  const boundary = record['authority_boundary'];
  if (typeof boundary !== 'object' || boundary === null || Array.isArray(boundary)) {
    errors.push('missing "authority_boundary" mapping');
  } else {
    const b = boundary as Record<string, unknown>;
    // The critical authority rule, enforced structurally: a persona file
    // that claims any of these is malformed, full stop. The orchestrator
    // does not consult this block at runtime — it is enforced in code
    // regardless — but a persona file should never even claim otherwise.
    const mustBeFalse = [
      'can_mutate_github',
      'can_submit_pr_review_state',
      'can_resolve_review_threads',
      'can_call_arbitrary_tools',
      'can_execute_repository_code',
      'can_override_orchestrator',
    ];
    for (const key of mustBeFalse) {
      if (!(key in b)) {
        errors.push(`"authority_boundary.${key}" is required`);
      } else if (b[key] !== false) {
        errors.push(`"authority_boundary.${key}" must be false`);
      }
    }
    if ('has_veto' in b && b['has_veto'] !== false) {
      errors.push('"authority_boundary.has_veto" must be false when present');
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Parses one persona YAML file. Throws PersonaValidationError on malformed YAML or a failed contract check. */
export async function loadPersonaFile(path: string): Promise<PersonaConfig> {
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new PersonaValidationError(path, [
      `malformed YAML: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const { valid, errors } = validatePersona(parsed);
  if (!valid) {
    throw new PersonaValidationError(path, errors);
  }
  return parsed as PersonaConfig;
}

/**
 * Loads every *.yaml file in a directory (config/personas by default),
 * validates each one, and rejects duplicate codenames across the set —
 * a persona's codename is its identity throughout the orchestration engine
 * (event actor, finding source_persona, provider routing key), so a
 * collision there is not a cosmetic problem.
 */
export async function loadPersonas(directory: string): Promise<Map<string, PersonaConfig>> {
  const entries = await readdir(directory);
  const files = entries.filter((entry) => extname(entry) === '.yaml' || extname(entry) === '.yml').sort();

  const personas = new Map<string, PersonaConfig>();
  const failures: string[] = [];

  for (const file of files) {
    const path = join(directory, file);
    try {
      const persona = await loadPersonaFile(path);
      if (personas.has(persona.codename)) {
        failures.push(`${path}: duplicate codename "${persona.codename}" (also used by another persona file)`);
        continue;
      }
      personas.set(persona.codename, persona);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length > 0) {
    throw new PersonaValidationError(directory, failures);
  }
  return personas;
}
