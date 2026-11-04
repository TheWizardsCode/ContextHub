/**
 * src/github/comments.ts — issue-comment CRUD of the GitHub integration.
 *
 * Concern: reading and writing issue comments — response normalisation
 * (`normalizeGithubIssueComment`, private to this module) plus the list,
 * create, update and get paths in their synchronous and asynchronous forms
 * (`listGithubIssueComments`, `createGithubIssueComment`,
 * `updateGithubIssueComment`, `getGithubIssueComment` and their `…Async`
 * twins). The sync variants are `@deprecated` but still used by
 * `src/github-sync.ts`, so they are moved unchanged rather than removed.
 *
 * Moved verbatim from `src/github.ts` (WL-0MVVLXZFN00994LW, child 6 of 8 of the
 * WL-0MVGKGR2H006MNVG `src/github.ts` decomposition). Move-only: the REST paths
 * (`repos/<owner>/<name>/issues/<n>/comments` and
 * `repos/<owner>/<name>/issues/comments/<id>`), the `--paginate`/`-X POST`/
 * `-X PATCH` flags, the `-F body=@-` stdin shape and the `--json
 * id,body,updatedAt,user` field list are unchanged, and the normalisation
 * fallbacks (`body ?? null`, `updated_at || updatedAt || now`,
 * `user?.login || author?.login`) are byte-identical.
 *
 * Every external call is scheduled through the central throttler, via the
 * `ghApiJsonScheduled` wrapper from `./transport.js`. This module therefore
 * depends on `./types.js`, `./transport.js` and `./repo-slug.js` only — never on
 * the `src/github.ts` barrel — so the family's import graph stays acyclic.
 */

import type { GithubConfig, GithubIssueComment } from './types.js';
import { parseRepoSlug } from './repo-slug.js';
import { ghApiJsonScheduled, runGhJson, runGhSafeJson } from './transport.js';

function normalizeGithubIssueComment(comment: any): GithubIssueComment {
  return {
    id: comment.id,
    body: comment.body ?? null,
    updatedAt: comment.updated_at || comment.updatedAt || new Date().toISOString(),
    author: comment.user?.login || comment.author?.login,
  };
}

/**
 * @deprecated Use `listGithubIssueCommentsAsync` instead. This function blocks the event loop.
 * Migration: Replace `listGithubIssueComments(config, issueNumber)` with `await listGithubIssueCommentsAsync(config, issueNumber)`.
 */
export function listGithubIssueComments(config: GithubConfig, issueNumber: number): GithubIssueComment[] {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api repos/${owner}/${name}/issues/${issueNumber}/comments --paginate`;
  const data = runGhSafeJson(command);
  if (!data) {
    return [];
  }
  const raw = Array.isArray(data) ? data : [];
  return raw.map(comment => normalizeGithubIssueComment(comment));
}

// Async variants -----------------------------------------------------------
export async function listGithubIssueCommentsAsync(config: GithubConfig, issueNumber: number): Promise<GithubIssueComment[]> {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api repos/${owner}/${name}/issues/${issueNumber}/comments --paginate`;
  try {
    const data = await ghApiJsonScheduled(command);
    if (!data) return [];
    const raw = Array.isArray(data) ? data : [];
    return raw.map(comment => normalizeGithubIssueComment(comment));
  } catch {
    return [];
  }
}

/**
 * @deprecated Use `createGithubIssueCommentAsync` instead. This function blocks the event loop.
 * Migration: Replace `createGithubIssueComment(config, issueNumber, body)` with `await createGithubIssueCommentAsync(config, issueNumber, body)`.
 */
export function createGithubIssueComment(config: GithubConfig, issueNumber: number, body: string): GithubIssueComment {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api -X POST repos/${owner}/${name}/issues/${issueNumber}/comments -F body=@-`;
  const data = runGhJson(command, body);
  return normalizeGithubIssueComment(data);
}

export async function createGithubIssueCommentAsync(config: GithubConfig, issueNumber: number, body: string): Promise<GithubIssueComment> {
  // Ensure comment creation is scheduled through the central throttler.
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api -X POST repos/${owner}/${name}/issues/${issueNumber}/comments -F body=@-`;
  const data = await ghApiJsonScheduled(command, body);
  return normalizeGithubIssueComment(data);
}

/**
 * @deprecated Use `updateGithubIssueCommentAsync` instead. This function blocks the event loop.
 * Migration: Replace `updateGithubIssueComment(config, commentId, body)` with `await updateGithubIssueCommentAsync(config, commentId, body)`.
 */
export function updateGithubIssueComment(config: GithubConfig, commentId: number, body: string): GithubIssueComment {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api -X PATCH repos/${owner}/${name}/issues/comments/${commentId} -F body=@-`;
  const data = runGhJson(command, body);
  return normalizeGithubIssueComment(data);
}

export async function updateGithubIssueCommentAsync(config: GithubConfig, commentId: number, body: string): Promise<GithubIssueComment> {
  // Ensure comment updates are scheduled through the central throttler.
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api -X PATCH repos/${owner}/${name}/issues/comments/${commentId} -F body=@-`;
  const data = await ghApiJsonScheduled(command, body);
  return normalizeGithubIssueComment(data);
}

/**
 * @deprecated Use `getGithubIssueCommentAsync` instead. This function blocks the event loop.
 * Migration: Replace `getGithubIssueComment(config, commentId)` with `await getGithubIssueCommentAsync(config, commentId)`.
 */
export function getGithubIssueComment(config: GithubConfig, commentId: number): GithubIssueComment {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api repos/${owner}/${name}/issues/comments/${commentId} --json id,body,updatedAt,user`;
  const data = runGhJson(command);
  return normalizeGithubIssueComment(data);
}

export async function getGithubIssueCommentAsync(config: GithubConfig, commentId: number): Promise<GithubIssueComment> {
  const { owner, name } = parseRepoSlug(config.repo);
  const command = `gh api repos/${owner}/${name}/issues/comments/${commentId} --json id,body,updatedAt,user`;
  const data = await ghApiJsonScheduled(command);
  return normalizeGithubIssueComment(data);
}
