// Machine contracts for the council orchestration engine, kept as separate
// JSON Schema files under /schemas (not folded into orchestration.yaml — see
// Issue #12 section 15) so they can be validated, versioned, and consumed by
// tooling other than this codebase.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Ajv ships CJS: the named export survives Node's ESM interop, the default
// export does not, so import it this way rather than as a default. Same
// reasoning as src/protocol/schema.ts.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

const SCHEMA_FILES = [
  'review-run.schema.json',
  'finding.schema.json',
  'evidence-packet.schema.json',
  'council-event.schema.json',
  'verdict.schema.json',
] as const;

export type SchemaName = (typeof SCHEMA_FILES)[number];

function schemasDir(): string {
  // Compiled output sits at dist/orchestration/schema.js; the schemas
  // directory lives at the repo root, two levels up from there. From source
  // (ts-node/vitest) it's the same two levels up from src/orchestration.
  return join(import.meta.dirname, '..', '..', 'schemas');
}

export function loadSchemaFile(name: string): unknown {
  return JSON.parse(readFileSync(join(schemasDir(), name), 'utf8'));
}

let validators: Map<SchemaName, ValidateFunction> | undefined;

function compile(): Map<SchemaName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
  for (const file of SCHEMA_FILES) {
    ajv.addSchema(loadSchemaFile(file) as object, file);
  }
  const compiled = new Map<SchemaName, ValidateFunction>();
  for (const file of SCHEMA_FILES) {
    compiled.set(file, ajv.getSchema(file) as ValidateFunction);
  }
  return compiled;
}

function validatorFor(name: SchemaName): ValidateFunction {
  validators ??= compile();
  return validators.get(name) as ValidateFunction;
}

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  errors: string[];
}

/**
 * Validates any structured model or orchestrator output against its phase
 * contract. This is the boundary Issue #12 section 19 requires: critical
 * orchestration state is never parsed out of free-form persona prose —
 * every machine-relevant response comes through here first.
 */
export function validateAgainst<T>(name: SchemaName, value: unknown): ValidationResult<T> {
  const validate = validatorFor(name);
  const candidate = structuredClone(value);
  if (validate(candidate)) {
    return { valid: true, value: candidate as T, errors: [] };
  }
  const errors = (validate.errors ?? []).map(
    (err) => `${err.instancePath || '/'} ${err.message ?? 'is invalid'}`,
  );
  return { valid: false, errors };
}
