/**
 * src/github/types.ts — shared public type declarations of the GitHub integration.
 *
 * Concern: the data shapes exchanged across the github family — the repo and
 * label configuration (`GithubConfig`), the issue and comment records read back
 * from `gh` (`GithubIssueRecord`, `GithubIssueComment`), the issue-assignment
 * outcome (`AssignGithubIssueResult`), the sub-issue hierarchy
 * (`IssueHierarchy`) and a single label event (`LabelEvent`). Declarations
 * only: no runtime code, so this module is a leaf every other github module can
 * depend on instead of the barrel.
 *
 * Moved verbatim from `src/github.ts` (WL-0MVVLXXGC0026427, child 3 of 8 of the
 * WL-0MVGKGR2H006MNVG `src/github.ts` decomposition). Move-only: no member
 * added, removed or re-typed; optionality and doc comments preserved.
 */

export interface GithubConfig {
  repo: string;
  labelPrefix: string;
}

export interface GithubIssueRecord {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  updatedAt: string;
  subIssuesSummary?: { total: number; completed: number };
}

export interface GithubIssueComment {
  id: number;
  body: string | null;
  updatedAt: string;
  author?: string;
}

export interface IssueHierarchy {
  parentIssueNumber: number | null;
  childIssueNumbers: number[];
}

export interface AssignGithubIssueResult {
  ok: boolean;
  error?: string;
}

/**
 * Represents a single label add/remove event from the GitHub issue events API.
 */
export interface LabelEvent {
  /** The full label name, e.g. "wl:stage:done" */
  label: string;
  /** Whether the label was added or removed */
  action: 'labeled' | 'unlabeled';
  /** ISO-8601 timestamp of the event */
  createdAt: string;
}
