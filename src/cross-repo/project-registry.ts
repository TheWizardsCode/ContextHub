/**
 * Cross-repo project discovery (F2 — WL-0MVWEELAW005SDLU).
 *
 * The single prefix → project scan for the whole framework (parent item
 * WL-0MVWABT2Z001XMSD, design constraints D1 and D6). Every consumer —
 * `wl project list`, the foreign-dependency resolver, the TUI title resolver
 * and the framework skills — is meant to call this module instead of
 * re-implementing its own sibling-folder scan.
 *
 * ## Discovery rule (D1)
 *
 * The *projects root* is scanned exactly once (`readdirSync`) for **immediate
 * subdirectories**. A candidate becomes a discovered project when it is:
 *
 *   - not hidden (its name does not start with `.`);
 *   - a git repository (it has a `.git` entry — directory or worktree
 *     gitfile);
 *   - a **genuine** worklog store, i.e. `<project>/.worklog` passes
 *     {@link isGenuineWorklogStore} (`initialized` or `worklog.db`). A
 *     worktree-shaped stub that only holds the tracked `.worklog/config.yaml`
 *     is therefore excluded — a managed worktree never looks like a project.
 *
 * The prefix comes from the candidate's own `.worklog/config.yaml`. No
 * repository-wide walk happens: one `readdir` of the root plus the two
 * `existsSync` probes inside `isGenuineWorklogStore` per candidate (the `.git`
 * probe uses `statSync`, which is not part of the bounded probe budget). A
 * missing or unreadable projects root yields an empty list plus a warning —
 * never a throw.
 *
 * ## Ambiguity
 *
 * Two projects may declare the same prefix. The result reports one entry for
 * that prefix with `ambiguous: true`, `path: null` and every declaring project
 * in sorted `candidates`; the scan never guesses an owner.
 *
 * ## Root resolution
 *
 * Precedence (first match wins):
 *
 *   1. the explicit `projectsRoot` option;
 *   2. the `projectsRoot` key in `<cwd>/.worklog/config.yaml`;
 *   3. the parent directory of the checkout (its git root when `cwd` is inside
 *      a repository, otherwise `cwd` itself).
 *
 * Results are memoised per resolved root for the lifetime of the process
 * (discovery is called on every gating path). `clearDiscoveryCache()` drops
 * the memo when a caller knows the sibling layout changed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getGitRepoRoot } from '@worklog/shared/worklog-paths';
import { isGenuineWorklogStore } from '../worklog-paths.js';

/** One prefix the scan resolved (or the set of projects claiming it). */
export interface DiscoveredProject {
  /** Prefix declared by the project's `.worklog/config.yaml` (upper-cased). */
  prefix: string;
  /**
   * Project root — the directory holding `.worklog/`. `null` when several
   * projects declare this prefix and no owner can be chosen.
   */
  path: string | null;
  /** `true` when more than one project declares this prefix. */
  ambiguous: boolean;
  /** Every declaring project root, sorted; present only when ambiguous. */
  candidates?: string[];
}

/** Result of one discovery scan. */
export interface DiscoveryResult {
  /** The directory that was scanned. */
  projectsRoot: string;
  /** Discovered projects, sorted by prefix. */
  projects: DiscoveredProject[];
  /**
   * Fail-open diagnostics (missing root, unreadable config, …). A warning is
   * never an error: the scan always returns a result.
   */
  warnings: string[];
}

/** Options accepted by {@link discoverProjects}. */
export interface DiscoverProjectsOptions {
  /** Explicit projects root; wins over the config value and the default. */
  projectsRoot?: string;
  /** Checkout directory used for config/default resolution (default: cwd). */
  cwd?: string;
}

/** Resolved projects root plus any fail-open diagnostics. */
export interface ProjectsRootResolution {
  /** Absolute directory scanned for sibling projects. */
  root: string;
  /** Fail-open diagnostics (unreadable config, …). Never an error. */
  warnings: string[];
}

/**
 * Machine-readable result for a dependency id whose prefix no discovered
 * project declares (parent D4 — missing-project remediation).
 *
 * The payload carries the exact command form an agent can run verbatim; it
 * replaces the bare `Work item not found` that gave the producer nothing to
 * act on.
 */
export interface UnknownProjectPayload {
  success: false;
  error_code: 'unknown_project';
  /** Upper-cased prefix segment of the unknown id. */
  prefix: string;
  /** The projects root that was scanned. */
  projects_root: string;
  /** The exact `wl project add <PREFIX> --git-url <url>` remediation. */
  remediation: string;
}

/** Memoised scans keyed by resolved projects root. */
const discoveryCache = new Map<string, DiscoveryResult>();

/** Drop the per-process discovery memo (sibling layout changed in-process). */
export function clearDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Resolve the projects root plus any fail-open warning produced while doing
 * so. `explicitRoot` and `cwd` are already resolved to absolute paths.
 */
function resolveProjectsRoot(
  cwd: string,
  explicitRoot: string | undefined,
): { root: string; warnings: string[] } {
  if (explicitRoot !== undefined) {
    return { root: explicitRoot, warnings: [] };
  }

  const configured = readConfiguredProjectsRoot(cwd);
  if (configured.root !== undefined) {
    return { root: configured.root, warnings: configured.warnings };
  }

  // Default: the parent of the checkout. The checkout is the git root when
  // `cwd` is inside a repository, so a command run from a subdirectory still
  // resolves the same projects root.
  const checkoutRoot = getGitRepoRoot(cwd) ?? cwd;
  return { root: path.dirname(path.resolve(checkoutRoot)), warnings: configured.warnings };
}

/** Read the `projectsRoot` key from `<cwd>/.worklog/config.yaml`, if any. */
function readConfiguredProjectsRoot(cwd: string): {
  root?: string;
  warnings: string[];
} {
  const configPath = path.join(cwd, '.worklog', 'config.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    // No config in this checkout — not a warning; the default applies.
    return { warnings: [] };
  }

  let config: unknown;
  try {
    config = yaml.load(raw, { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    return {
      warnings: [
        `Could not parse ${configPath}: ${describeError(error)} — using the default projects root.`,
      ],
    };
  }

  const value = (config as { projectsRoot?: unknown } | null | undefined)?.projectsRoot;
  if (value === undefined || value === null) {
    return { warnings: [] };
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      warnings: [
        `Ignoring invalid projectsRoot in ${configPath} (expected a non-empty path string) — using the default projects root.`,
      ],
    };
  }

  // A relative override is resolved against the checkout that declared it.
  return { root: path.resolve(cwd, value.trim()), warnings: [] };
}

/**
 * Resolve the projects root that discovery would scan, without scanning it.
 *
 * Exposed so `wl project add` clones into exactly the directory discovery
 * consults (same precedence: explicit option → config → parent of the
 * checkout). Never throws for filesystem problems.
 */
export function getProjectsRoot(
  options: DiscoverProjectsOptions = {},
): ProjectsRootResolution {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicitRoot =
    options.projectsRoot !== undefined ? path.resolve(cwd, options.projectsRoot) : undefined;

  return resolveProjectsRoot(cwd, explicitRoot);
}

/**
 * The actionable remediation text for an unknown project prefix.
 *
 * Kept in one place so every surface (`wl dep add`, `wl dep list`, the
 * foreign-dependency view in `wl next`) quotes the identical command form.
 */
export function unknownProjectRemediation(prefix: string, projectsRoot: string): string {
  return (
    `Run \`wl project add ${prefix} --git-url <url>\` to clone the project into ` +
    `${projectsRoot}, then retry.`
  );
}

/**
 * Build the `unknown_project` payload for a dependency id whose prefix no
 * discovered project declares (parent D4).
 */
export function unknownProjectResult(
  prefix: string,
  options: DiscoverProjectsOptions = {},
): UnknownProjectPayload {
  const normalised = prefix.trim().toUpperCase();
  const { root } = getProjectsRoot(options);
  return {
    success: false,
    error_code: 'unknown_project',
    prefix: normalised,
    projects_root: root,
    remediation: unknownProjectRemediation(normalised, root),
  };
}

/**
 * Discover local worklog projects under the projects root.
 *
 * See the module doc comment for the discovery rule, ambiguity handling and
 * root precedence. Never throws for filesystem problems: a missing or
 * unreadable root is reported through `warnings`.
 */
export function discoverProjects(options: DiscoverProjectsOptions = {}): DiscoveryResult {
  const { root, warnings: rootWarnings } = getProjectsRoot(options);

  let scanned = discoveryCache.get(root);
  if (scanned === undefined) {
    scanned = scanProjects(root);
    discoveryCache.set(root, scanned);
  }

  return {
    projectsRoot: scanned.projectsRoot,
    projects: scanned.projects,
    warnings: [...rootWarnings, ...scanned.warnings],
  };
}

/** One bounded pass over the immediate subdirectories of `root`. */
function scanProjects(root: string): DiscoveryResult {
  const warnings: string[] = [];
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return {
      projectsRoot: root,
      projects: [],
      warnings: [
        `Could not scan projects root ${root}: ${describeError(error)} — no projects discovered.`,
      ],
    };
  }

  const pathsByPrefix = new Map<string, string[]>();

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const projectDir = path.join(root, entry.name);
    if (!hasGitEntry(projectDir)) continue;

    const worklogDir = path.join(projectDir, '.worklog');
    // Exactly the two genuine-store probes per candidate (initialized,
    // worklog.db) — no repository-wide walk.
    if (!isGenuineWorklogStore(worklogDir)) continue;

    const prefix = readProjectPrefix(worklogDir);
    if (prefix === undefined) {
      warnings.push(
        `Skipping ${projectDir}: its .worklog/config.yaml is missing or declares no prefix.`,
      );
      continue;
    }

    const declaring = pathsByPrefix.get(prefix) ?? [];
    declaring.push(projectDir);
    pathsByPrefix.set(prefix, declaring);
  }

  const projects: DiscoveredProject[] = [...pathsByPrefix.keys()]
    .sort()
    .map((prefix) => {
      const declaring = [...(pathsByPrefix.get(prefix) ?? [])].sort();
      if (declaring.length === 1) {
        return { prefix, path: declaring[0], ambiguous: false };
      }
      return { prefix, path: null, ambiguous: true, candidates: declaring };
    });

  return { projectsRoot: root, projects, warnings };
}

/**
 * True when `projectDir` holds a git marker (a `.git` directory or a worktree
 * gitfile). Uses `statSync` so the bounded discovery scan spends no
 * `existsSync` probe on it.
 */
function hasGitEntry(projectDir: string): boolean {
  try {
    return fs.statSync(path.join(projectDir, '.git'), { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Read the (upper-cased) prefix a project directory declares, if readable.
 *
 * Used by `wl project add` to validate a clone before recording its mapping;
 * shares {@link readProjectPrefix} so the config shape is parsed once.
 */
export function readDeclaredPrefix(projectDir: string): string | undefined {
  return readProjectPrefix(path.join(projectDir, '.worklog'));
}

/** Read the (upper-cased) prefix a project declares, if readable. */
function readProjectPrefix(worklogDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(worklogDir, 'config.yaml'), 'utf-8');
    const config = yaml.load(raw, { schema: yaml.CORE_SCHEMA }) as { prefix?: unknown } | null;
    const prefix = config?.prefix;
    if (typeof prefix !== 'string') return undefined;
    const trimmed = prefix.trim();
    return trimmed === '' ? undefined : trimmed.toUpperCase();
  } catch {
    return undefined;
  }
}

/** Compact one-line description of a caught filesystem/YAML error. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
