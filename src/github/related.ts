import { log } from '../logger.js';
import type { ChangedFile, RelatedFile, RepoRef } from '../types.js';
import type { GitHubClient } from './client.js';

/**
 * Context beyond the diff: the tests that cover a changed file, and the code
 * that calls it. The protocol still forbids reviewing this code — anchoring
 * drops any finding that lands outside the diff — but the council needs it to
 * judge whether the change is complete and consistent.
 */
export interface RelatedOptions {
  maxFiles: number;
  maxCharsPerFile: number;
  /**
   * Ceiling on GitHub requests this gather may issue. The file budget bounds
   * results, not work: a repository whose tests do not match the conventions
   * below never fills it, so without a request ceiling the cost is highest
   * exactly where the return is zero.
   */
  maxLookups: number;
  /** Code search is rate-limited and index-lagged; it degrades silently. */
  searchCallers: boolean;
}

const TEST_SUFFIXES = ['.test', '.spec', '_test'];
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|rs|php|cs|swift)$/;

/** Conventional test paths for a source file, most likely first. */
export function testCandidates(path: string): string[] {
  const match = SOURCE_EXTENSIONS.exec(path);
  if (!match) return [];
  const extension = match[0];
  const withoutExtension = path.slice(0, -extension.length);
  const parts = withoutExtension.split('/');
  const base = parts.pop() as string;
  const directory = parts.join('/');
  const prefix = directory ? `${directory}/` : '';

  const candidates = TEST_SUFFIXES.map((suffix) => `${prefix}${base}${suffix}${extension}`);
  candidates.push(`${prefix}__tests__/${base}${extension}`);
  candidates.push(`${prefix}tests/${base}${extension}`);
  if (extension === '.py') candidates.push(`${prefix}test_${base}${extension}`);
  // Mirrored test trees: src/a/b.ts -> test/a/b.test.ts
  if (directory.startsWith('src/') || directory === 'src') {
    const mirrored = directory.replace(/^src/, 'test');
    candidates.push(`${mirrored}/${base}.test${extension}`);
  }
  return candidates;
}

/** A file already in the change never counts as related context. */
function changedPaths(files: ChangedFile[]): Set<string> {
  return new Set(files.flatMap((file) => [file.path, file.previousPath ?? file.path]));
}

export async function gatherRelatedFiles(
  client: GitHubClient,
  installationId: number,
  repo: RepoRef,
  files: ChangedFile[],
  ref: string,
  options: RelatedOptions,
): Promise<RelatedFile[]> {
  if (options.maxFiles <= 0 || options.maxLookups <= 0) return [];

  const excluded = changedPaths(files);
  const related: RelatedFile[] = [];
  const seen = new Set<string>();

  // Every GitHub request this gather issues is counted, not just the ones
  // that returned something.
  let lookups = 0;
  const spent = (): boolean => lookups >= options.maxLookups;
  const fetchContent = async (path: string): Promise<string | undefined> => {
    lookups += 1;
    return client.getFileContent(installationId, repo, path, ref);
  };

  const add = (path: string, reason: RelatedFile['reason'], content: string): void => {
    if (related.length >= options.maxFiles || seen.has(path) || excluded.has(path)) return;
    seen.add(path);
    const truncated = content.length > options.maxCharsPerFile;
    related.push({
      path,
      reason,
      content: truncated
        ? `${content.slice(0, options.maxCharsPerFile)}\n… truncated …`
        : content,
      truncated,
    });
  };

  // Tests first: they are precise, cheap, and the most useful missing context.
  for (const file of files) {
    if (related.length >= options.maxFiles || spent()) break;
    if (isTestPath(file.path)) continue;
    for (const candidate of testCandidates(file.path)) {
      if (excluded.has(candidate) || spent()) break;
      const content = await fetchContent(candidate);
      if (content) {
        add(candidate, 'covering test', content);
        break;
      }
    }
  }

  if (options.searchCallers) {
    for (const file of files) {
      if (related.length >= options.maxFiles || spent()) break;
      lookups += 1;
      const search = await findCallers(client, installationId, repo, file.path, excluded);
      // One rejection means the quota is gone or the endpoint is closed to us.
      // Retrying it per file buys nothing and can block the review.
      if (!search.ok) {
        log.info('caller search unavailable; skipping it for this run', { file: file.path });
        break;
      }
      for (const caller of search.paths) {
        if (related.length >= options.maxFiles || spent()) break;
        const content = await fetchContent(caller);
        if (content) add(caller, 'mentions the changed file', content);
      }
    }
  }

  if (spent()) {
    log.info('related-context lookup budget exhausted', {
      lookups,
      budget: options.maxLookups,
      collected: related.length,
    });
  }

  return related;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.|_test\./.test(path);
}

/**
 * Files that mention the changed file, found by code search. This is a
 * full-text match on the module's basename — it does not establish an import,
 * a reference or a call, which is why the label says "mentions" and not
 * "calls". Any failure — rate limit, missing permission, cold index — yields
 * nothing rather than failing the review, and `ok: false` tells the caller to
 * stop searching for the rest of the run.
 */
async function findCallers(
  client: GitHubClient,
  installationId: number,
  repo: RepoRef,
  path: string,
  excluded: Set<string>,
): Promise<{ ok: boolean; paths: string[] }> {
  const base = (path.split('/').pop() ?? '').replace(SOURCE_EXTENSIONS, '');
  if (base.length < 3) return { ok: true, paths: [] };

  try {
    const query = `repo:${repo.owner}/${repo.repo} "${base}" in:file`;
    const results = await client.searchCode(installationId, query);
    return {
      ok: true,
      paths: results
        .map((item) => item.path)
        .filter((candidate) => !excluded.has(candidate) && !isTestPath(candidate))
        .slice(0, 3),
    };
  } catch (error) {
    log.debug('caller search failed', { path, error: String(error) });
    return { ok: false, paths: [] };
  }
}

/** Rendered into the prompt under an explicit not-part-of-the-change banner. */
export function renderRelatedFiles(related: RelatedFile[]): string {
  if (related.length === 0) return '';
  return [
    '',
    'Related context — these files are NOT part of this change. Use them only',
    'to judge the change. Never report a finding against them.',
    ...related.map((file) => `\n--- ${file.path} (${file.reason})\n${file.content}`),
  ].join('\n');
}

/** Paths the council saw as background, which no finding may be anchored to. */
export function relatedPaths(related: RelatedFile[]): Set<string> {
  return new Set(related.map((file) => file.path));
}
