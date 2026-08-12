import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { PROTOCOL_VERSION } from './types.js';

/**
 * The runtime never restates review policy. It loads the canonical protocol
 * text from the versioned skill directory and hands it to every reviewer, so
 * `skills/half-shell-review/v<n>/SKILL.md` stays the single source of truth.
 */
const DEFAULT_PROTOCOL_DIR = fileURLToPath(
  new URL(`../../skills/half-shell-review/v${PROTOCOL_VERSION.split('.')[0]}/`, import.meta.url),
);

export function protocolDir(): string {
  return process.env.HALF_SHELL_PROTOCOL_DIR ?? DEFAULT_PROTOCOL_DIR;
}

let cachedSkill: string | undefined;

/** Full text of the canonical protocol, cached for the process lifetime. */
export function loadProtocolText(): string {
  if (cachedSkill === undefined) {
    cachedSkill = readFileSync(join(protocolDir(), 'SKILL.md'), 'utf8');
  }
  return cachedSkill;
}

export function loadSchemaFile(name: string): unknown {
  return JSON.parse(readFileSync(join(protocolDir(), 'schemas', name), 'utf8'));
}

export { PROTOCOL_VERSION };
