# Branch Protection Rules

> **Operational/GitHub admin task.** These rules must be configured in GitHub repository settings.

## Background

On 2026-07-09, an incident (WL-0MRCTZZ82000X7TM) corrupted the `dev` branch of this repository when a pre-push hook executed a destructive `wl sync` that deleted all source files. The commit `b639581` rendered `origin/dev` unusable until a force-push from a feature branch restored it.

While the hooks have been fixed to use safe patterns, branch protection rules provide an additional safety layer that prevents any single commit (even from a trusted hook) from irreversibly damaging the repository state.

## Required Rules

### `main`

- **Require pull request reviews before merging**: ON
- **Dismiss stale pull request approvals when new commits are pushed**: ON
- **Require status checks to pass before merging**: ON
  - All CI checks must pass
- **Require branches to be up to date before merging**: ON
- **Require linear history**: ON
- **Do not allow force pushes to the `main` branch**: ON
- **Do not allow deletions of the `main` branch**: ON

### `dev`

- **Require pull request reviews before merging**: ON
- **Dismiss stale pull request approvals when new commits are pushed**: ON
- **Require status checks to pass before merging**: ON
  - All CI checks must pass
- **Require branches to be up to date before merging**: ON
- **Require linear history**: ON (if possible)
- **Do not allow force pushes to the `dev` branch**: ON (strongly recommended)
- **Do not allow deletions of the `dev` branch**: ON

## Rationale

- **No force pushes**: Prevents accidental or malicious overwriting of branch history. The `dev` branch corruption incident was only recoverable because a clean feature branch existed. Without force-push protection, similar incidents could permanently lose work.
- **PR reviews**: Ensures at least one human (or automated system) approves changes before they reach protected branches. This is especially important for hooks, automation scripts, and configuration changes.
- **Status checks**: Ensures CI passes before merging. This prevents broken code from reaching protected branches.
- **Linear history**: Makes it easier to reason about the commit history and reduces the risk of accidental merges introducing conflicts or regressions.

## Configuration

These rules are configured via GitHub's UI:

1. Go to **Settings > Branches > Branch protection rules**
2. Click **Add rule** or **Edit** for each branch
3. Configure the rules as described above

## Related

- Incident: WL-0MRCTZZ82000X7TM (RCA: wl sync pre-push hook destroyed repository)
- Hook fixes: Same work item — `.githooks/pre-push`, `.githooks/post-merge`, `.githooks/post-rewrite`, `.githooks/post-checkout`, `.githooks/worklog-post-pull`, `.git/hooks/pre-push`, `.git/hooks/worklog-post-pull`
- Worktree data-loss incident: WL-0MS99Y6R40028Q9G — the post-checkout/post-pull hooks ran `wl sync` inside git worktrees (git exports `GIT_DIR` to hooks, redirecting `wl sync`'s temp-worktree git commands to the caller's worktree), producing destructive commits that deleted tracked files on worktree branches. Fixed by (a) adding the worktree-skip guard to `post-checkout` and `worklog-post-pull` (matching the pre-push guard), and (b) clearing `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` for git child processes in `withTempWorktree()`/`gitPushDataFileToBranch()` so `wl sync` can never touch the caller's branch.
