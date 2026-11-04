/**
 * src/github/hierarchy.ts — issue-hierarchy plumbing of the GitHub integration.
 *
 * Concern: the parent/sub-issue relationships between GitHub issues — resolving
 * an issue's GraphQL node id (`getIssueNodeId`, private to this module, and its
 * async twin `getIssueNodeIdAsync`), reading an issue's hierarchy
 * (`getIssueHierarchy`, `getIssueHierarchyAsync`), linking a child issue under
 * a parent (`addSubIssueLink`, its non-throwing `…Result` wrapper and their
 * async twins) and recovering a parent issue number from an issue's timeline
 * (`listParentIssueNumbersFromTimeline`).
 *
 * Moved verbatim from `src/github.ts` (WL-0MVVLXYRO006WP2I, child 5 of 8 of the
 * WL-0MVGKGR2H006MNVG `src/github.ts` decomposition). Move-only: the GraphQL
 * documents, the `first: 100` sub-issue tuning, the `-f`/`-F` argument flags
 * and the error messages are byte-identical, and the sync/async response
 * unwrapping differences are preserved deliberately.
 *
 * This module depends on `./types.js`, `./transport.js` and `./repo-slug.js`
 * only — never on the `src/github.ts` barrel — so the family's import graph
 * stays acyclic.
 */

import type { GithubConfig, IssueHierarchy } from './types.js';
import { parseRepoSlug } from './repo-slug.js';
import {
  ghApiJsonDetailedScheduled,
  ghApiJsonScheduled,
  quoteShellValue,
  runGhJsonDetailed,
  runGhSafeJson,
} from './transport.js';

function getIssueNodeId(config: GithubConfig, issueNumber: number): string {
  const { owner, name } = parseRepoSlug(config.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) { id }
    }
  }`;
  const output = runGhJsonDetailed(
    `gh api graphql -f query=${quoteShellValue(query)} -f owner=${quoteShellValue(owner)} -f name=${quoteShellValue(name)} -F number=${issueNumber}`
  );
  if (!output.ok) {
    throw new Error(output.error || 'Unable to query GitHub issue node ID');
  }
  const id = output.data?.data?.repository?.issue?.id;
  if (!id) {
    throw new Error(`Unable to resolve GitHub issue node ID for #${issueNumber}`);
  }
  return id;
}

export function getIssueHierarchy(config: GithubConfig, issueNumber: number): IssueHierarchy {
  const { owner, name } = parseRepoSlug(config.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        parent { number }
        subIssues(first: 100) { nodes { number } }
      }
    }
  }`;
  const output = runGhJsonDetailed(
    `gh api graphql -f query=${quoteShellValue(query)} -f owner=${quoteShellValue(owner)} -f name=${quoteShellValue(name)} -F number=${issueNumber}`
  );
  if (!output.ok) {
    throw new Error(output.error || 'Unable to query issue hierarchy');
  }
  const issue = output.data?.data?.repository?.issue;
  const parentIssueNumber = issue?.parent?.number ?? null;
  const childIssueNumbers = Array.isArray(issue?.subIssues?.nodes)
    ? issue.subIssues.nodes.map((node: any) => node?.number).filter((value: any) => typeof value === 'number')
    : [];
  return { parentIssueNumber, childIssueNumbers };
}

// Async wrappers -----------------------------------------------------------
export async function getIssueNodeIdAsync(config: GithubConfig, issueNumber: number): Promise<string> {
  const { owner, name } = parseRepoSlug(config.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }`;
  const data = await ghApiJsonScheduled(
    `gh api graphql -f query=${quoteShellValue(query)} -f owner=${quoteShellValue(owner)} -f name=${quoteShellValue(name)} -F number=${issueNumber}`
  );
  const id = data?.data?.repository?.issue?.id;
  if (!id) {
    throw new Error(`Unable to resolve GitHub issue node ID for #${issueNumber}`);
  }
  return id;
}

export async function getIssueHierarchyAsync(config: GithubConfig, issueNumber: number): Promise<IssueHierarchy> {
  const { owner, name } = parseRepoSlug(config.repo);
  const query = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { parent { number } subIssues(first: 100) { nodes { number } } } } }`;
  const result = await ghApiJsonScheduled(
    `gh api graphql -f query=${quoteShellValue(query)} -f owner=${quoteShellValue(owner)} -f name=${quoteShellValue(name)} -F number=${issueNumber}`
  );
  if (!result) throw new Error('Unable to query issue hierarchy');
  const issue = result.data?.repository?.issue ?? result.data?.data?.repository?.issue;
  const parentIssueNumber = issue?.parent?.number ?? null;
  const childIssueNumbers = Array.isArray(issue?.subIssues?.nodes)
    ? issue.subIssues.nodes.map((node: any) => node?.number).filter((value: any) => typeof value === 'number')
    : [];
  return { parentIssueNumber, childIssueNumbers };
}

export function addSubIssueLink(
  config: GithubConfig,
  parentIssueNumber: number,
  childIssueNumber: number,
  cache?: Map<number, string>
): void {
  const nodeCache = cache ?? new Map<number, string>();
  const resolveNodeId = (issueNumber: number) => {
    const cached = nodeCache.get(issueNumber);
    if (cached) {
      return cached;
    }
    const nodeId = getIssueNodeId(config, issueNumber);
    nodeCache.set(issueNumber, nodeId);
    return nodeId;
  };
  const parentNodeId = resolveNodeId(parentIssueNumber);
  const childNodeId = resolveNodeId(childIssueNumber);
  const mutation = `mutation($parent: ID!, $child: ID!) {
    addSubIssue(input: { issueId: $parent, subIssueId: $child }) { issue { id } subIssue { id } }
  }`;
  const result = runGhJsonDetailed(
    `gh api graphql -f query=${quoteShellValue(mutation)} -f parent=${quoteShellValue(parentNodeId)} -f child=${quoteShellValue(childNodeId)}`
  );
  if (!result.ok) {
    throw new Error(result.error || `Failed to link #${childIssueNumber} as sub-issue of #${parentIssueNumber}`);
  }
  const mutationResult = result.data?.data?.addSubIssue;
  if (!mutationResult?.subIssue?.id || !mutationResult?.issue?.id) {
    throw new Error('addSubIssue returned no data (sub-issues may be disabled for this repo/org)');
  }
}

export function addSubIssueLinkResult(
  config: GithubConfig,
  parentIssueNumber: number,
  childIssueNumber: number,
  cache?: Map<number, string>
): { ok: boolean; error?: string } {
  try {
    addSubIssueLink(config, parentIssueNumber, childIssueNumber, cache);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function addSubIssueLinkAsync(
  config: GithubConfig,
  parentIssueNumber: number,
  childIssueNumber: number,
  cache?: Map<number, string>
): Promise<void> {
  const nodeCache = cache ?? new Map<number, string>();
  const resolveNodeId = async (issueNumber: number) => {
    const cached = nodeCache.get(issueNumber);
    if (cached) return cached;
    const nodeId = await getIssueNodeIdAsync(config, issueNumber);
    nodeCache.set(issueNumber, nodeId);
    return nodeId;
  };
  const parentNodeId = await resolveNodeId(parentIssueNumber);
  const childNodeId = await resolveNodeId(childIssueNumber);
  const mutation = `mutation($parent: ID!, $child: ID!) { addSubIssue(input: { issueId: $parent, subIssueId: $child }) { issue { id } subIssue { id } } }`;
  // The mutation is scheduled through the central throttler to honour
  // concurrency and rate limits. The scheduled wrapper lives in `./transport.js`
  // so this module depends only on the transport, the shared types and
  // repo-slug — never on the throttler directly.
  const result = await ghApiJsonDetailedScheduled(
    `gh api graphql -f query=${quoteShellValue(mutation)} -f parent=${quoteShellValue(parentNodeId)} -f child=${quoteShellValue(childNodeId)}`
  );
  if (!result.ok) {
    throw new Error(result.error || `Failed to link #${childIssueNumber} as sub-issue of #${parentIssueNumber}`);
  }
  const mutationResult = result.data?.data?.addSubIssue;
  if (!mutationResult?.subIssue?.id || !mutationResult?.issue?.id) {
    throw new Error('addSubIssue returned no data (sub-issues may be disabled for this repo/org)');
  }
}

export async function addSubIssueLinkResultAsync(
  config: GithubConfig,
  parentIssueNumber: number,
  childIssueNumber: number,
  cache?: Map<number, string>
): Promise<{ ok: boolean; error?: string }> {
  try {
    await addSubIssueLinkAsync(config, parentIssueNumber, childIssueNumber, cache);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export function listParentIssueNumbersFromTimeline(config: GithubConfig, issueNumber: number): number[] {
  const command = `gh api repos/${config.repo}/issues/${issueNumber}/timeline --paginate`;
  const output = runGhSafeJson(command);
  if (!Array.isArray(output)) {
    return [];
  }
  const parents: number[] = [];
  for (const event of output) {
    if (event?.event === 'added_to_parent' && typeof event?.parent_issue?.number === 'number') {
      parents.push(event.parent_issue.number);
    }
  }
  return parents;
}
