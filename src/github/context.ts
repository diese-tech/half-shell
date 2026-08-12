import { isExcluded, type ReviewConfig } from '../config.js';
import type { ChangeContext, ChangedFile, RepoRef } from '../types.js';
import type { GitHubClient } from './client.js';

const ISSUE_REFERENCE = /(?:closes|fixes|resolves|refs?|see)\s+#(\d+)/gi;
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md'];

/**
 * Builds the bounded context set the protocol asks for: the change itself,
 * stated intent, and the repository's own engineering instructions. It does
 * not dump the repository into every reviewer.
 */
export async function buildChangeContext(
  client: GitHubClient,
  installationId: number,
  repo: RepoRef,
  pullNumber: number,
  config: ReviewConfig,
): Promise<ChangeContext> {
  const pr = await client.getPullRequest(installationId, repo, pullNumber);
  const allFiles = await client.listFiles(installationId, repo, pullNumber, config.maxFiles * 4);

  const omittedFiles: { path: string; reason: string }[] = [];
  const files: ChangedFile[] = [];

  for (const file of allFiles) {
    if (isExcluded(file.path, config.excludePatterns)) {
      omittedFiles.push({ path: file.path, reason: 'generated or binary path excluded' });
      continue;
    }
    if (!file.patch) {
      omittedFiles.push({
        path: file.path,
        reason: file.truncated ? 'diff too large for the API response' : 'no textual diff',
      });
      continue;
    }
    if (files.length >= config.maxFiles) {
      omittedFiles.push({ path: file.path, reason: 'file budget exhausted' });
      continue;
    }
    files.push(file);
  }

  const description = pr.body ?? '';
  const linkedIssues = await resolveLinkedIssues(client, installationId, repo, description);
  const repoInstructions = await loadRepoInstructions(client, installationId, repo, pr.base.ref);

  return {
    repo,
    pullNumber,
    title: pr.title,
    description,
    author: pr.user?.login ?? 'unknown',
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    files,
    omittedFiles,
    linkedIssues,
    repoInstructions,
  };
}

async function resolveLinkedIssues(
  client: GitHubClient,
  installationId: number,
  repo: RepoRef,
  description: string,
): Promise<ChangeContext['linkedIssues']> {
  const numbers = new Set<number>();
  for (const match of description.matchAll(ISSUE_REFERENCE)) {
    const value = Number(match[1]);
    if (Number.isInteger(value)) numbers.add(value);
  }

  const issues: ChangeContext['linkedIssues'] = [];
  for (const number of [...numbers].slice(0, 3)) {
    const issue = await client.getIssue(installationId, repo, number);
    if (issue) issues.push({ ...issue, body: issue.body.slice(0, 4000) });
  }
  return issues;
}

async function loadRepoInstructions(
  client: GitHubClient,
  installationId: number,
  repo: RepoRef,
  ref: string,
): Promise<string | undefined> {
  for (const path of INSTRUCTION_FILES) {
    const content = await client.getFileContent(installationId, repo, path, ref);
    if (content) return `${path}:\n${content.slice(0, 6000)}`;
  }
  return undefined;
}

/** Human-readable coverage statement recorded in the verdict. */
export function describeCoverage(context: ChangeContext): string {
  const reviewed = `${context.files.length} changed file${context.files.length === 1 ? '' : 's'} reviewed`;
  if (context.omittedFiles.length === 0) return `${reviewed}; no files omitted.`;
  const omitted = context.omittedFiles
    .slice(0, 5)
    .map((file) => `${file.path} (${file.reason})`)
    .join(', ');
  const extra =
    context.omittedFiles.length > 5 ? ` and ${context.omittedFiles.length - 5} more` : '';
  return `${reviewed}; omitted: ${omitted}${extra}.`;
}
