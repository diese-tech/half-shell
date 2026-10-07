/**
 * The generation-3 false positives from the first real local run (PR #25,
 * 2f5c4fb, qwen2.5-coder:7b), as verifier regression fixtures. The code is
 * the real head-side text of those files, rendered the way renderChange
 * does, and each claim and quote is what the model actually produced.
 */
import type { VerificationVerdict } from '../phases/verification.js';

export interface VerifierFixture {
  name: string;
  claim: string;
  file: string;
  line: number;
  quote: string;
  changeContext: string;
  expected: VerificationVerdict;
}

function rendered(file: string, firstLine: number, lines: string[]): string {
  const body = lines.map((code, i) => `${String(firstLine + i).padStart(5, ' ')} + ${code}`);
  return ['Changed files (line numbers are the head-side truth):', '', `--- ${file} (added, +${lines.length}/-0)`, ...body].join('\n');
}

export const GENERATION_3_FIXTURES: VerifierFixture[] = [
  {
    name: 'Dojo does not authenticate, against text saying it is deliberately loopback-only and unauthenticated',
    claim: 'The Dojo viewer does not authenticate, allowing access to private repository content.',
    file: 'docs/architecture/review-policy.md',
    line: 297,
    quote: 'Dojo v0 (`npm run dojo`, Issue #20) is a local, loopback-only, unauthenticated operator viewer over the Council store.',
    changeContext: rendered('docs/architecture/review-policy.md', 291, [
      'transcriptAvailable',
      'transcriptUrl?',
      '```',
      '',
      'If there is no viewer/URL, do not render a fake link.',
      '',
      'Dojo v0 (`npm run dojo`, Issue #20) is a local, loopback-only, unauthenticated operator viewer over the Council store. It does not satisfy the transcript access rules below, so publication must not link to it as `View the Dojo`.',
      '',
      '### Transcript access',
    ]),
    expected: 'CONTRADICTS',
  },
  {
    name: 'missing database is unhandled, against the existsSync guard',
    claim: 'The Dojo viewer does not handle the case where the Council database file does not exist, leading to a crash.',
    file: 'src/dojo/main.ts',
    line: 50,
    quote: 'if (!existsSync(databasePath)) return undefined;',
    changeContext: rendered('src/dojo/main.ts', 45, [
      '// Opened lazily and read-only: the database may not exist until the first',
      '// council review runs, and the viewer must never create or migrate it.',
      'let store: OrchestrationStore | undefined;',
      'function getReader(): DojoReader | undefined {',
      '  if (store) return store;',
      '  if (!existsSync(databasePath)) return undefined;',
      '  try {',
      '    store = new OrchestrationStore(databasePath, { readOnly: true });',
      '    return store;',
      '  } catch (error) {',
      "    log.warn('could not open Council database read-only yet', {",
    ]),
    expected: 'CONTRADICTS',
  },
  {
    name: 'no manual refresh, against an unrelated test line that neither supports nor refutes it',
    claim: 'The viewer lacks a manual refresh option to see new events.',
    file: 'src/dojo/dojo.test.ts',
    line: 230,
    quote: 'const before = await (await fetch(`${base}/dojo/runs/rev_1?fragment=1`)).text();',
    changeContext: rendered('src/dojo/dojo.test.ts', 229, [
      "it('serves a polling fragment that reflects new events without a restart', async () => {",
      '  const before = await (await fetch(`${base}/dojo/runs/rev_1?fragment=1`)).text();',
      "  expect(before.startsWith('<div id=\"dojo-live\"')).toBe(true);",
      "  expect(before).not.toContain('Leonardo has spoken');",
    ]),
    expected: 'INSUFFICIENT',
  },
];
