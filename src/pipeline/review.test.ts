import { describe, expect, it } from 'vitest';

import { ProviderRouter } from '../providers/router.js';
import type { CompletionRequest, CompletionResult, Provider } from '../providers/types.js';
import type { ChangeContext, ChangedFile } from '../types.js';
import { runReview } from './review.js';

/**
 * A provider that answers each protocol phase from a script, so the pipeline
 * can be exercised end to end without inference.
 */
class ScriptedProvider implements Provider {
  readonly id = 'scripted';
  readonly tier = 'local' as const;
  readonly model = 'scripted';
  readonly seen: string[] = [];

  constructor(private readonly script: Record<string, string>) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const phase = detectPhase(request.system);
    this.seen.push(phase);
    return { text: this.script[phase] ?? '{}', provider: this.id, model: this.model };
  }
}

function detectPhase(system: string): string {
  // The protocol text itself names every phase, so only the instruction
  // appended after the role block identifies which phase is running.
  const instruction = system.split('</your_role>').at(-1) ?? '';
  if (instruction.includes('Phase 1 — Briefing')) return 'brief';
  if (instruction.includes('Phase 2 — Independent lane review')) {
    // Lane responses are keyed by persona so lanes can differ.
    const persona = /^You are (.+?) of The Dojo/.exec(system)?.[1] ?? 'unknown';
    return `lane:${persona}`;
  }
  if (instruction.includes('Phase 4 — Sparring')) return 'sparring';
  if (instruction.includes('Phase 5 — Shredder Challenge')) return 'shredder';
  if (instruction.includes('Phase 6 — The Verdict')) return 'verdict';
  return 'unknown';
}

const context: ChangeContext = {
  repo: { owner: 'diese-tech', repo: 'half-shell' },
  pullNumber: 12,
  title: 'Require a tenant id when loading records',
  description: 'Adds tenant scoping to the loader.',
  author: 'dev',
  baseSha: 'abc1234000',
  headSha: 'def5678000',
  baseRef: 'main',
  headRef: 'feature',
  files: [
    {
      path: 'src/loader.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      truncated: false,
      patch: [
        '@@ -1,4 +1,5 @@',
        ' export function load(id: string) {',
        '-  return query(id);',
        '+  return query(id, tenantId);',
        '+  // TODO: propagate tenantId from callers',
        ' }',
      ].join('\n'),
    },
  ],
  omittedFiles: [],
  linkedIssues: [],
};

const FINDING = {
  severity: 'high',
  confidence: 0.9,
  category: 'contract',
  file: 'src/loader.ts',
  line: 2,
  claim: 'Callers still invoke load() without a tenant id.',
  evidence: 'query() now takes tenantId but the call site does not receive it.',
  failure_mode: 'load() throws at runtime because tenantId is undefined.',
  suggested_fix: 'Thread tenantId through load().',
};

function script(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    brief: JSON.stringify({
      claimed_change: 'tenant scoping',
      actual_change: 'loader now requires tenantId',
      constraints: [],
      prior_behavior: 'load took only an id',
      uncertainty: [],
    }),
    'lane:Raphael': JSON.stringify({ findings: [FINDING] }),
    'lane:Donatello': JSON.stringify({ findings: [{ ...FINDING, severity: 'medium' }] }),
    'lane:April': JSON.stringify({ findings: [] }),
    'lane:Michelangelo': JSON.stringify({ findings: [] }),
    'lane:Splinter': JSON.stringify({ findings: [] }),
    'lane:Casey Jones': JSON.stringify({ findings: [] }),
    sparring: JSON.stringify({
      critiques: [{ finding_id: 'HS-001', action: 'SUPPORT', reasoning: 'the call site is in the diff' }],
    }),
    shredder: JSON.stringify({
      change_challenge: 'Is tenant scoping needed here at all?',
      critiques: [{ finding_id: 'HS-001', action: 'CHALLENGE', reasoning: 'callers may already pass it' }],
    }),
    verdict: JSON.stringify({
      decisions: [{ finding_id: 'HS-001', decision: 'PUBLISH', reasoning: 'the stale call site is in this diff' }],
      unresolved_uncertainty: [],
    }),
    ...overrides,
  };
}

function router(provider: Provider): ProviderRouter {
  return new ProviderRouter([provider], { allowPaid: false });
}

describe('runReview', () => {
  it('runs every protocol phase and publishes what Leonardo approved', async () => {
    const provider = new ScriptedProvider(script());
    const { run, pool } = await runReview(router(provider), context, {
      depth: 'standard',
      maxPatchChars: 5000,
    });

    expect(provider.seen).toContain('brief');
    expect(provider.seen).toContain('lane:Raphael');
    expect(provider.seen).toContain('sparring');
    expect(provider.seen).toContain('shredder');
    expect(provider.seen).toContain('verdict');

    // Two lanes found the same defect: one pooled finding, corroborated twice.
    expect(pool).toHaveLength(1);
    expect(pool[0]?.finding.corroboration_count).toBe(2);
    expect(pool[0]?.finding.severity).toBe('high');

    expect(run.verdict.published_findings).toHaveLength(1);
    expect(run.verdict.published_findings[0]?.file).toBe('src/loader.ts');
    expect(run.verdict.candidate_count).toBe(1);
    expect(run.verdict.complete).toBe(true);
    expect(run.protocolVersion).toBe('1.0.0');
  });

  it('discards findings that point outside the diff before deliberation', async () => {
    const provider = new ScriptedProvider(
      script({
        'lane:Raphael': JSON.stringify({
          findings: [{ ...FINDING, file: 'src/never-touched.ts' }],
        }),
        'lane:Donatello': JSON.stringify({ findings: [] }),
        verdict: JSON.stringify({ decisions: [], unresolved_uncertainty: [] }),
      }),
    );

    const { run, pool } = await runReview(router(provider), context, {
      depth: 'standard',
      maxPatchChars: 5000,
    });

    expect(pool).toHaveLength(0);
    expect(run.verdict.published_findings).toHaveLength(0);
    expect(run.verdict.coverage_limitations?.join(' ')).toContain('outside the diff');
  });

  it('stays silent when Leonardo rejects everything', async () => {
    const provider = new ScriptedProvider(
      script({
        verdict: JSON.stringify({
          decisions: [{ finding_id: 'HS-001', decision: 'REJECT', reasoning: 'speculative' }],
          unresolved_uncertainty: [],
        }),
      }),
    );

    const { run } = await runReview(router(provider), context, {
      depth: 'standard',
      maxPatchChars: 5000,
    });

    expect(run.verdict.published_findings).toHaveLength(0);
    expect(run.verdict.rejected_count).toBe(1);
    expect(run.verdict.complete).toBe(true);
  });

  it('marks the review incomplete when the verdict phase fails', async () => {
    const failing = new (class extends ScriptedProvider {
      override async complete(request: CompletionRequest): Promise<CompletionResult> {
        if (request.system.includes('Phase 6')) throw new Error('provider exploded');
        return super.complete(request);
      }
    })(script());

    const { run } = await runReview(router(failing), context, {
      depth: 'standard',
      maxPatchChars: 5000,
    });

    expect(run.verdict.complete).toBe(false);
    expect(run.verdict.published_findings).toHaveLength(0);
  });

  it('marks the review incomplete when the Shredder Challenge cannot run', async () => {
    const provider = new (class extends ScriptedProvider {
      override async complete(request: CompletionRequest): Promise<CompletionResult> {
        if (detectPhase(request.system) === 'shredder') throw new Error('provider exploded');
        return super.complete(request);
      }
    })(script());

    const { run } = await runReview(router(provider), context, {
      depth: 'standard',
      maxPatchChars: 5000,
    });

    // A finding that never faced the adversarial pass has not survived review.
    expect(run.verdict.complete).toBe(false);
    expect(run.verdict.coverage_limitations?.join(' ')).toContain('Shredder Challenge');
  });

  it('marks the review incomplete when a Sparring pass cannot run', async () => {
    let failed = false;
    const provider = new (class extends ScriptedProvider {
      override async complete(request: CompletionRequest): Promise<CompletionResult> {
        if (detectPhase(request.system) === 'sparring' && !failed) {
          failed = true;
          throw new Error('provider exploded');
        }
        return super.complete(request);
      }
    })(script());

    const { run } = await runReview(router(provider), context, {
      depth: 'standard',
      maxPatchChars: 5000,
    });

    expect(run.verdict.complete).toBe(false);
    expect(run.verdict.coverage_limitations?.join(' ')).toContain('Sparring pass did not complete');
  });

  it('publishes nothing when Leonardo adjudicates only part of the pool', async () => {
    const second = { ...FINDING, file: 'src/loader.ts', line: 3, claim: 'The TODO admits the change is unfinished.', category: 'incomplete_change' };
    const provider = new ScriptedProvider(
      script({
        'lane:Raphael': JSON.stringify({ findings: [FINDING] }),
        'lane:Donatello': JSON.stringify({ findings: [second] }),
        verdict: JSON.stringify({
          // Only one of the two pooled findings is adjudicated.
          decisions: [{ finding_id: 'HS-001', decision: 'PUBLISH', reasoning: 'holds' }],
          unresolved_uncertainty: [],
        }),
      }),
    );

    const { run, pool } = await runReview(router(provider), context, {
      depth: 'standard',
      maxPatchChars: 5000,
    });

    expect(pool.length).toBe(2);
    expect(run.verdict.published_findings).toHaveLength(0);
    expect(run.verdict.complete).toBe(false);
  });

  it('reports files the prompt budget pushed out as unreviewed', async () => {
    const provider = new ScriptedProvider(script());
    const crowded: ChangeContext = {
      ...context,
      files: [
        context.files[0] as ChangedFile,
        {
          path: 'src/second.ts',
          status: 'modified',
          additions: 60,
          deletions: 0,
          truncated: false,
          // Far too large to fit alongside the first file in the budget below.
          patch: [
            '@@ -1,2 +1,62 @@',
            ' const x = 1;',
            ...Array.from({ length: 60 }, (_, i) => `+const value${i} = ${'y'.repeat(40)};`),
            ' const z = 3;',
          ].join('\n'),
        },
      ],
      omittedFiles: [],
    };

    const { run } = await runReview(router(provider), crowded, {
      depth: 'standard',
      maxPatchChars: 5000,
      // Enough for the header and the first file, not the second.
      maxPromptChars: 1200,
    });

    expect(run.verdict.coverage).toContain('src/second.ts');
    expect(run.verdict.coverage_limitations?.join(' ')).toContain('not reviewed');
  });

  it('does not leak investigator identity into the deliberation prompts', async () => {
    const prompts: string[] = [];
    const spy: Provider = {
      id: 'spy',
      tier: 'local',
      model: 'spy',
      async complete(request) {
        const phase = detectPhase(request.system);
        if (phase === 'sparring' || phase === 'verdict') prompts.push(request.user);
        return { text: script()[phase] ?? '{}', provider: 'spy', model: 'spy' };
      },
    };

    await runReview(router(spy), context, { depth: 'standard', maxPatchChars: 5000 });

    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      for (const name of ['Raphael', 'Donatello', 'Michelangelo', 'Splinter', 'Casey Jones']) {
        expect(prompt).not.toContain(name);
      }
    }
  });
});
