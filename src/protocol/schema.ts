// The bundled schemas declare draft 2020-12, so use Ajv's 2020 entrypoint.
// Ajv ships CJS: the named export survives Node's ESM interop, the default
// export does not, so import it this way rather than as a default.
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

import { loadSchemaFile } from './protocol.js';
import type { Critique, Finding, Resolution, Verdict } from './types.js';

const SCHEMA_FILES = [
  'finding.schema.json',
  'critique.schema.json',
  'verdict.schema.json',
  'resolution.schema.json',
] as const;

type SchemaName = (typeof SCHEMA_FILES)[number];

let validators: Map<SchemaName, ValidateFunction> | undefined;

function compile(): Map<SchemaName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
  // Register every schema first so `$ref: "finding.schema.json"` resolves.
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

function run<T>(name: SchemaName, value: unknown): ValidationResult<T> {
  const validate = validatorFor(name);
  // Ajv mutates on `useDefaults`; validate a copy so callers keep their input.
  const candidate = structuredClone(value);
  if (validate(candidate)) {
    return { valid: true, value: candidate as T, errors: [] };
  }
  const errors = (validate.errors ?? []).map(
    (err) => `${err.instancePath || '/'} ${err.message ?? 'is invalid'}`,
  );
  return { valid: false, errors };
}

export const validateFinding = (value: unknown) => run<Finding>('finding.schema.json', value);
export const validateCritique = (value: unknown) => run<Critique>('critique.schema.json', value);
export const validateVerdict = (value: unknown) => run<Verdict>('verdict.schema.json', value);
export const validateResolution = (value: unknown) =>
  run<Resolution>('resolution.schema.json', value);

/** Validate a batch, discarding anything that does not satisfy the contract. */
export function keepValid<T>(
  items: unknown[],
  validator: (value: unknown) => ValidationResult<T>,
): { kept: T[]; rejected: string[] } {
  const kept: T[] = [];
  const rejected: string[] = [];
  for (const item of items) {
    const result = validator(item);
    if (result.valid && result.value) kept.push(result.value);
    else rejected.push(result.errors.join('; '));
  }
  return { kept, rejected };
}
