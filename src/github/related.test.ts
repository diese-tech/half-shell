import { describe, expect, it } from 'vitest';

import type { ChangedFile } from '../types.js';
import type { GitHubClient } from './client.js';
import { gatherRelatedFiles, renderRelatedFiles, testCandidates } from './related.js';

const files: ChangedFile[] = [
  { path: 'src/loader.ts', status: 'modified', additions: 2, deletions: 1, truncated: false, patch: '@@ -1 +1 @@' },
];

/** Serves a fixed set of paths and records what was asked for. */
function fakeClient(
  contents: Record<string, string>,
  searchResults: string[] = [],
  onSearch?: () => void,
): GitHubClient {
  return {
    async getFileContent(_installation: number, _repo: unknown, path: string) {
      return contents[path];
    },
    async searchCode() {
      onSearch?.();
      return searchResults.map((path) => ({ path }));
    },
  } as unknown as GitHubClient;
}

const OPTIONS = { maxFiles: 5, maxCharsPerFile: 100, maxLookups: 30, searchCallers: false };

describe('testCandidates', () => {
  it('offers conventional test paths for a source file', () => {
    const candidates = testCandidates('src/loader.ts');
    expect(candidates).toContain('src/loader.test.ts');
    expect(candidates).toContain('src/loader.spec.ts');
    expect(candidates).toContain('src/__tests__/loader.ts');
    expect(candidates).toContain('test/loader.test.ts');
  });

  it('knows the Python convention', () => {
    expect(testCandidates('app/loader.py')).toContain('app/test_loader.py');
  });

  it('offers nothing for a file with no known source extension', () => {
    expect(testCandidates('README.md')).toEqual([]);
  });
});

describe('gatherRelatedFiles', () => {
  it('pulls in the covering test for a changed file', async () => {
    const client = fakeClient({ 'src/loader.test.ts': 'describe("load", () => {});' });

    const related = await gatherRelatedFiles(client, 1, { owner: 'o', repo: 'r' }, files, 'head', OPTIONS);

    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({ path: 'src/loader.test.ts', reason: 'covering test' });
  });

  it('never includes a file that is already part of the change', async () => {
    const changed = [...files, { ...files[0]!, path: 'src/loader.test.ts' }];
    const client = fakeClient({ 'src/loader.test.ts': 'already in the diff' });

    const related = await gatherRelatedFiles(client, 1, { owner: 'o', repo: 'r' }, changed, 'head', OPTIONS);

    expect(related).toHaveLength(0);
  });

  it('truncates a long file to the configured budget', async () => {
    const client = fakeClient({ 'src/loader.test.ts': 'x'.repeat(500) });

    const related = await gatherRelatedFiles(client, 1, { owner: 'o', repo: 'r' }, files, 'head', OPTIONS);

    expect(related[0]?.truncated).toBe(true);
    expect(related[0]?.content).toContain('truncated');
  });

  it('adds callers when search is enabled', async () => {
    const client = fakeClient(
      { 'src/import.ts': 'import { load } from "./loader.js";' },
      ['src/import.ts'],
    );

    const related = await gatherRelatedFiles(client, 1, { owner: 'o', repo: 'r' }, files, 'head', {
      ...OPTIONS,
      searchCallers: true,
    });

    expect(related.map((file) => file.path)).toContain('src/import.ts');
    expect(related.find((file) => file.path === 'src/import.ts')?.reason).toBe('mentions the changed file');
  });

  it('does not search at all when callers are disabled', async () => {
    let searched = false;
    const client = fakeClient({}, [], () => {
      searched = true;
    });

    await gatherRelatedFiles(client, 1, { owner: 'o', repo: 'r' }, files, 'head', OPTIONS);

    expect(searched).toBe(false);
  });

  it('degrades silently when code search fails', async () => {
    const client = {
      async getFileContent() {
        return undefined;
      },
      async searchCode(): Promise<{ path: string }[]> {
        throw new Error('rate limited');
      },
    } as unknown as GitHubClient;

    await expect(
      gatherRelatedFiles(client, 1, { owner: 'o', repo: 'r' }, files, 'head', {
        ...OPTIONS,
        searchCallers: true,
      }),
    ).resolves.toEqual([]);
  });

  it('stops probing once the request budget is spent', async () => {
    // A repo whose tests match no convention: every lookup misses, so the
    // file budget never fills and only the request budget can stop it.
    let requests = 0;
    const client = {
      async getFileContent() {
        requests += 1;
        return undefined;
      },
      async searchCode(): Promise<{ path: string }[]> {
        requests += 1;
        return [];
      },
    } as unknown as GitHubClient;

    const many = Array.from({ length: 40 }, (_, i) => ({ ...files[0]!, path: `lib/mod${i}.ts` }));
    const related = await gatherRelatedFiles(client, 1, { owner: 'o', repo: 'r' }, many, 'head', {
      ...OPTIONS,
      maxLookups: 10,
      searchCallers: true,
    });

    expect(related).toEqual([]);
    expect(requests).toBeLessThanOrEqual(10);
  });

  it('stops searching for the rest of the run after the first rejection', async () => {
    let searches = 0;
    const client = {
      async getFileContent() {
        return undefined;
      },
      async searchCode(): Promise<{ path: string }[]> {
        searches += 1;
        throw new Error('rate limited');
      },
    } as unknown as GitHubClient;

    const many = Array.from({ length: 12 }, (_, i) => ({ ...files[0]!, path: `lib/mod${i}.ts` }));
    await gatherRelatedFiles(client, 1, { owner: 'o', repo: 'r' }, many, 'head', {
      ...OPTIONS,
      maxLookups: 500,
      searchCallers: true,
    });

    // Not once per changed file.
    expect(searches).toBe(1);
  });

  it('collects nothing when the budget is zero', async () => {
    const client = fakeClient({ 'src/loader.test.ts': 'test' });

    const related = await gatherRelatedFiles(client, 1, { owner: 'o', repo: 'r' }, files, 'head', {
      ...OPTIONS,
      maxFiles: 0,
    });

    expect(related).toEqual([]);
  });
});

describe('renderRelatedFiles', () => {
  it('warns that related files are not under review', () => {
    const rendered = renderRelatedFiles([
      { path: 'src/loader.test.ts', reason: 'covering test', content: 'test body', truncated: false },
    ]);

    expect(rendered).toContain('NOT part of this change');
    expect(rendered).toContain('Never report a finding against them');
    expect(rendered).toContain('src/loader.test.ts');
  });

  it('renders nothing when there is no related context', () => {
    expect(renderRelatedFiles([])).toBe('');
  });
});
