import type { ChangedFile } from '../types.js';
import type { StubPullRequest } from './stub-github.js';
import type { Script } from './stub-inference.js';

/**
 * A small but realistic change: a function grows a required argument and one
 * call site is left behind. Exactly the shape the protocol is meant to catch.
 */
export const SAMPLE_FILES: ChangedFile[] = [
  {
    path: 'src/loader.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    truncated: false,
    patch: [
      '@@ -1,6 +1,8 @@',
      ' import { query } from "./db.js";',
      ' ',
      '-export function load(id: string) {',
      '-  return query(id);',
      '+export function load(id: string, tenantId: string) {',
      '+  if (!tenantId) throw new Error("tenantId is required");',
      '+  return query(id, tenantId);',
      ' }',
    ].join('\n'),
  },
  {
    path: 'src/import.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    truncated: false,
    patch: [
      '@@ -10,7 +10,7 @@ export async function importRecords(ids: string[]) {',
      '   const results = [];',
      '   for (const id of ids) {',
      '-    results.push(load(id));',
      '+    results.push(load(id));',
      '   }',
      '   return results;',
      ' }',
    ].join('\n'),
  },
];

export const SAMPLE_PULL_REQUEST: StubPullRequest = {
  number: 42,
  title: 'Require a tenant id when loading records',
  body: 'Scopes record loading to a tenant. Fixes #7.',
  author: 'dev',
  headSha: 'def5678abcdef',
  baseSha: 'abc1234567890',
  files: SAMPLE_FILES,
};

const FINDING = {
  severity: 'high',
  confidence: 0.92,
  category: 'contract',
  file: 'src/import.ts',
  line: 13,
  claim: 'importRecords still calls load() without the now-required tenant id.',
  evidence: 'load() gained a required tenantId parameter, but this call site passes only id.',
  failure_mode: 'Every import throws "tenantId is required" at runtime.',
  suggested_fix: 'Thread tenantId through importRecords to the load() call.',
};

/**
 * Read the offending line out of the annotated diff, the way a real reviewer
 * would, so the fixture stays correct when the patch moves.
 */
function offendingLine(prompt: string): number {
  const match = /^\s*(\d+) \+.*results\.push\(load\(id\)\)/m.exec(prompt);
  return match ? Number(match[1]) : FINDING.line;
}

/** The default script: two lanes independently find the stale call site. */
export function defaultScript(): Script {
  return {
    brief: JSON.stringify({
      claimed_change: 'Scope record loading to a tenant.',
      actual_change: 'load() gained a required tenantId; one call site was updated, one was not.',
      constraints: [],
      prior_behavior: 'load(id) queried across all tenants.',
      uncertainty: [],
    }),
    lane: JSON.stringify({ findings: [] }),
    lanes: {
      Raphael: (request) =>
        JSON.stringify({ findings: [{ ...FINDING, line: offendingLine(request.user) }] }),
      Donatello: (request) =>
        JSON.stringify({
          findings: [
            {
              ...FINDING,
              line: offendingLine(request.user),
              severity: 'medium',
              evidence: 'The exported signature changed but src/import.ts was not updated.',
            },
          ],
        }),
    },
    sparring: JSON.stringify({
      critiques: [
        {
          finding_id: 'HS-001',
          action: 'SUPPORT',
          reasoning: 'Both the signature change and the stale call site are inside this diff.',
        },
      ],
    }),
    shredder: JSON.stringify({
      change_challenge: 'Tenant scoping is justified; the guard clause is the smallest safe form.',
      critiques: [
        {
          finding_id: 'HS-001',
          action: 'CHALLENGE',
          reasoning: 'Confirm the call site is reachable rather than dead code.',
        },
      ],
    }),
    verdict: JSON.stringify({
      decisions: [
        {
          finding_id: 'HS-001',
          decision: 'PUBLISH',
          reasoning: 'The stale call site is in the diff and fails on every import.',
        },
      ],
      unresolved_uncertainty: [],
    }),
    followup_verify: JSON.stringify({
      assessment: 'The call site now passes tenantId.',
      still_reachable: false,
      evidence: 'src/import.ts line 13 forwards tenantId.',
    }),
    followup_challenge: JSON.stringify({ objection: '' }),
    followup_resolve: JSON.stringify({
      status: 'RESOLVED',
      reasoning: 'The call site was corrected in the latest push.',
      evidence: 'src/import.ts line 13',
    }),
  };
}
