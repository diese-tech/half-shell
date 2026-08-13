import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPersonaFile, loadPersonas, PersonaValidationError, validatePersona } from './loader.js';

const REPO_PERSONAS_DIR = join(import.meta.dirname, '..', '..', 'config', 'personas');
const CODENAMES = ['leo', 'raph', 'donnie', 'mikey', 'splinter', 'april', 'casey', 'shredder'];

function validPersona(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test Persona',
    codename: 'test',
    role: 'runtime_hunter',
    temperament: { calm: 'low' },
    allowed_outcomes: { submit_finding: 'send it to sparring' },
    hard_rules: ['never_directly_mutate_github_state'],
    persona_anchor: 'A test persona.',
    authority_boundary: {
      can_mutate_github: false,
      can_submit_pr_review_state: false,
      can_resolve_review_threads: false,
      can_call_arbitrary_tools: false,
      can_execute_repository_code: false,
      can_override_orchestrator: false,
    },
    ...overrides,
  };
}

describe('validatePersona', () => {
  it('accepts a well-formed persona', () => {
    expect(validatePersona(validPersona())).toEqual({ valid: true, errors: [] });
  });

  it('rejects a non-object document', () => {
    expect(validatePersona('just a string').valid).toBe(false);
    expect(validatePersona(['a', 'list']).valid).toBe(false);
    expect(validatePersona(null).valid).toBe(false);
  });

  it('rejects a missing identity field', () => {
    const { valid, errors } = validatePersona(validPersona({ codename: undefined }));
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('codename'))).toBe(true);
  });

  it('rejects an unrecognized role', () => {
    const { valid, errors } = validatePersona(validPersona({ role: 'chaos_gremlin' }));
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('role'))).toBe(true);
  });

  it('rejects a non-machine-readable temperament', () => {
    const { valid, errors } = validatePersona(
      validPersona({ temperament: { calm: { nested: 'object' } } }),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('temperament'))).toBe(true);
  });

  it('rejects an empty allowed_outcomes map', () => {
    const { valid, errors } = validatePersona(validPersona({ allowed_outcomes: {} }));
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('allowed_outcomes'))).toBe(true);
  });

  it('rejects a persona that claims GitHub mutation authority', () => {
    const { valid, errors } = validatePersona(
      validPersona({
        authority_boundary: {
          can_mutate_github: true,
          can_submit_pr_review_state: false,
          can_resolve_review_threads: false,
          can_call_arbitrary_tools: false,
          can_execute_repository_code: false,
          can_override_orchestrator: false,
        },
      }),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('can_mutate_github'))).toBe(true);
  });

  it('rejects a persona that claims veto power', () => {
    const { valid, errors } = validatePersona(
      validPersona({
        authority_boundary: {
          ...((validPersona().authority_boundary) as object),
          has_veto: true,
        },
      }),
    );
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('has_veto'))).toBe(true);
  });

  it('rejects a persona missing hard_rules', () => {
    const { valid, errors } = validatePersona(validPersona({ hard_rules: [] }));
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('hard_rules'))).toBe(true);
  });
});

describe('loadPersonaFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'half-shell-personas-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws PersonaValidationError on malformed YAML', async () => {
    const path = join(dir, 'broken.yaml');
    await writeFile(path, 'name: [unterminated\n  - broken', 'utf8');
    await expect(loadPersonaFile(path)).rejects.toThrow(PersonaValidationError);
  });

  it('throws PersonaValidationError on a well-formed YAML document that fails the contract', async () => {
    const path = join(dir, 'incomplete.yaml');
    await writeFile(path, 'name: Nobody\n', 'utf8');
    await expect(loadPersonaFile(path)).rejects.toThrow(PersonaValidationError);
  });

  it('loads a valid persona file and preserves unmodeled fields for prompting', async () => {
    const path = join(dir, 'test.yaml');
    await writeFile(
      path,
      [
        'name: Test Persona',
        'codename: test',
        'role: runtime_hunter',
        'persona_anchor: "A test persona."',
        'temperament:',
        '  calm: low',
        'allowed_outcomes:',
        '  submit_finding: send it to sparring',
        'hard_rules:',
        '  - never_directly_mutate_github_state',
        'authority_boundary:',
        '  can_mutate_github: false',
        '  can_submit_pr_review_state: false',
        '  can_resolve_review_threads: false',
        '  can_call_arbitrary_tools: false',
        '  can_execute_repository_code: false',
        '  can_override_orchestrator: false',
        'dialogue_anchor_not_in_the_type: "still comes through"',
      ].join('\n'),
      'utf8',
    );
    const persona = await loadPersonaFile(path);
    expect(persona.codename).toBe('test');
    expect(persona['dialogue_anchor_not_in_the_type']).toBe('still comes through');
  });
});

describe('loadPersonas', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'half-shell-personas-dir-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects duplicate codenames across files', async () => {
    const body = [
      'name: A',
      'codename: dup',
      'role: runtime_hunter',
      'persona_anchor: "anchor"',
      'temperament:\n  calm: low',
      'allowed_outcomes:\n  submit_finding: go',
      'hard_rules:\n  - never_directly_mutate_github_state',
      'authority_boundary:',
      '  can_mutate_github: false',
      '  can_submit_pr_review_state: false',
      '  can_resolve_review_threads: false',
      '  can_call_arbitrary_tools: false',
      '  can_execute_repository_code: false',
      '  can_override_orchestrator: false',
    ].join('\n');
    await writeFile(join(dir, 'a.yaml'), body, 'utf8');
    await writeFile(join(dir, 'b.yaml'), body.replace('name: A', 'name: B'), 'utf8');

    await expect(loadPersonas(dir)).rejects.toThrow(/duplicate codename/);
  });

  it('loads every canonical persona file in the repository and finds all eight with unique codenames', async () => {
    const personas = await loadPersonas(REPO_PERSONAS_DIR);
    expect(personas.size).toBe(8);
    for (const codename of CODENAMES) {
      expect(personas.has(codename)).toBe(true);
    }
  });

  it('gives every canonical persona a distinct role', async () => {
    const personas = await loadPersonas(REPO_PERSONAS_DIR);
    const roles = [...personas.values()].map((p) => p.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('gives Shredder a challenge_budget the runtime can enforce', async () => {
    const personas = await loadPersonas(REPO_PERSONAS_DIR);
    const shredder = personas.get('shredder');
    expect(shredder?.['challenge_budget']).toMatchObject({
      initial_challenges_per_finding: 3,
      follow_up_rounds: 1,
      extend_only_if_new_evidence: true,
    });
  });
});
