import { describe, expect, it } from 'vitest';

import { loadPersonas } from '../../personas/loader.js';
import { ProviderRouter } from '../../providers/router.js';
import { parseChangedFiles, withQuote } from '../grounding.js';
import { fromProviderRouter } from '../provider.js';
import { toCandidate } from '../synthesis.js';
import { GENERATION_3_FIXTURES } from '../testing/generation3.js';
import { verificationSubject, verifyFinding } from './verification.js';

/**
 * The generation-3 regressions against a real local model. Opt-in, because
 * it needs Ollama running with the model pulled:
 *
 *   HALF_SHELL_LIVE_OLLAMA_MODEL=qwen2.5-coder:7b npx vitest run src/orchestration/phases/verification.live.test.ts
 */
const model = process.env['HALF_SHELL_LIVE_OLLAMA_MODEL'];

describe.skipIf(!model)(`verifier on real Ollama (${model ?? 'skipped'})`, () => {
  const provider = fromProviderRouter(
    ProviderRouter.fromConfig(
      [{ id: 'ollama', tier: 'local', baseUrl: process.env['HALF_SHELL_LIVE_OLLAMA_URL'] ?? 'http://127.0.0.1:11434/v1', model: model!, timeoutMs: 5 * 60_000 }],
      { allowPaid: false },
    ),
  );

  it.each(GENERATION_3_FIXTURES)('$expected: $name', async (fixture) => {
    const shredder = (await loadPersonas('config/personas')).get('shredder')!;
    const finding = toCandidate('rev_live', {
      sourcePersona: 'raph',
      category: 'security',
      claim: fixture.claim,
      evidence: withQuote('model evidence', fixture.quote),
      affectedCode: { file: fixture.file, line: fixture.line, startLine: null },
      consequence: 'c',
      confidence: 1,
    });
    const subject = verificationSubject(finding, parseChangedFiles(fixture.changeContext))!;
    const result = await verifyFinding(provider, shredder, subject);
    console.log(`[live] ${fixture.expected} expected -> ${result?.verdict ?? 'no verdict'}: ${result?.reason ?? ''}`);
    expect(result?.verdict).toBe(fixture.expected);
  }, 5 * 60_000);
});
