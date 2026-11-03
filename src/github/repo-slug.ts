/**
 * src/github/repo-slug.ts — repo-slug parsing and git-remote repo resolution.
 *
 * Concern: turning an `owner/name` repo slug into its two parts
 * (`parseRepoSlug`, which throws `Invalid GitHub repo: <repo>` on malformed
 * input) and asking `gh` which repository the current checkout belongs to
 * (`getRepoFromGitRemote`, which returns `null` when the remote cannot be
 * resolved). It depends on the `gh` transport alone — never on the
 * `src/github.ts` barrel — so the family's import graph stays acyclic.
 *
 * Moved verbatim from `src/github.ts` (WL-0MVVLXXGC0026427, child 3 of 8 of the
 * WL-0MVGKGR2H006MNVG `src/github.ts` decomposition). Move-only: no signature,
 * error message or parsing change.
 */

import { runGh } from './transport.js';

export function parseRepoSlug(repo: string): { owner: string; name: string } {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid GitHub repo: ${repo}`);
  }
  return { owner: parts[0], name: parts[1] };
}

export function getRepoFromGitRemote(): string | null {
  try {
    const output = runGh('gh repo view --json nameWithOwner');
    const parsed = JSON.parse(output) as { nameWithOwner?: string };
    return parsed.nameWithOwner || null;
  } catch {
    return null;
  }
}
