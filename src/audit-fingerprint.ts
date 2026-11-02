/**
 * Canonical audit content fingerprint — TypeScript port (schema 2).
 *
 * Mirrors the audit skill's `audit_runner._compute_content_fingerprint`
 * (SorraAgents) so a stored audit `fingerprint` can be compared against the
 * item's *current* content at read time by the shared `isAuditFresh`
 * predicate (WL-0MUBVH5S0008NQ9K). Without this, `wl list` emits no
 * `currentFingerprint` and freshness always degrades to the fragile 60 s time
 * gate (WL-0MUN7QWFP0010EQC).
 *
 * The canonical fingerprint is **schema 2** — the work item's OWN data only:
 *
 * ```text
 * sha256( json.dumps({
 *   "schema":           2,
 *   "title_hash":       sha256(title),
 *   "description_hash": sha256(description),
 * }, sort_keys=True) )
 * ```
 *
 * The description carries the acceptance criteria AND the Key Files section,
 * so both are already covered by `description_hash`. No comment-derived input
 * and no repository state are hashed: the computation performs **zero git
 * invocations** (SA-0MVIDI8E00063OOP), so only a change to this work item's
 * own title/description invalidates a stored audit — unrelated commits,
 * working-tree changes, touched-file edits, comments and lifecycle-field
 * changes never do. On a large worklog that also removes a per-item git
 * subprocess cost from the `wl list` / `wl worklist` read path
 * (WL-0MVK5SWZE00254Y7).
 *
 * The payload is serialised with Python's `json.dumps(..., sort_keys=True)`
 * canonical form (`, ` / `: ` separators, recursively sorted keys,
 * `ensure_ascii` escaping) and hashed as UTF-8, so the digest is byte-for-byte
 * identical to the Python implementation. `json.dumps` semantics are covered
 * by tests; the arrangement of the payload mirrors the Python source.
 *
 * **Fail-on-skew contract.** A digest is only meaningful against an installed
 * audit skill built to the same schema. The parity test
 * (`tests/unit/audit-fingerprint-parity.test.ts`) probes the installed helper's
 * `inspect.signature` and `_AUDIT_CONTENT_FINGERPRINT_SCHEMA` through the
 * shared probe in `audit-fingerprint-installed.ts` and **fails** on any
 * declared schema other than 2, on an undeclared schema, and on a signature
 * that cannot accept `work_item=`. A skew must never be a silent skip: a
 * schema-1 digest can never match this one, so the failure is the signal to
 * fix the host. Only missing host tooling (no scripts directory, no
 * `python3`, or an unimportable helper) is skipped, keeping CI images green.
 * `wl doctor` surfaces the same skew as the warning-level
 * `audit-fingerprint.schema-skew` check; remediation is in
 * `docs/dev/audit-fingerprint.md` § "Parity check and host tooling skew".
 *
 * The git/path helpers below (`resolveTouchedFiles`, `computePathFingerprints`,
 * `extractKeyFiles`, `normaliseRepoPath`) are no longer part of the fingerprint;
 * they are retained because they are exported utilities with their own tests
 * (removal is tracked separately rather than widening this contract change).
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

/** Result of a git invocation. A non-zero exit is `ok: false`, never thrown. */
export interface GitResult {
  ok: boolean;
  stdout: string;
}

/**
 * Injectable git runner. Receives the git arguments (without the leading
 * `git`) and returns their result. Production callers supply a
 * `child_process`-backed runner rooted at the repository; tests supply a
 * fixture so no real repository is needed.
 */
export type GitRunner = (args: string[]) => GitResult;

/** Marker used to delimit commit headers in `git log --format`. */
const TOUCHED_FILES_COMMIT_MARKER = '__WL_COMMIT__';

/**
 * Build the production git runner for a repository working directory.
 *
 * Non-zero exits are returned as `{ ok: false, stdout }` rather than thrown,
 * mirroring the audit skill's `subprocess.run(check=False)` contract: several
 * probes (`git rev-parse HEAD:<path>`) legitimately fail for untracked paths
 * and must fall back rather than abort the whole computation.
 */
export function createGitRunner(cwd: string): GitRunner {
  return (args: string[]): GitResult => {
    try {
      const stdout = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { ok: true, stdout };
    } catch (error) {
      const stdout = (error as { stdout?: string | Buffer }).stdout;
      return { ok: false, stdout: stdout ? stdout.toString() : '' };
    }
  };
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Normalise a git-reported or Key-Files path for comparison.
 *
 * Mirrors `audit_runner._normalise_repo_path`: strips surrounding
 * whitespace/backticks/quotes and a leading `./`, so the same file resolved
 * from `git log --name-only` (which may quote paths with special characters)
 * and from the description's Key Files section compares equal.
 */
export function normaliseRepoPath(path: string | null | undefined): string {
  let p = (path ?? '').trim();
  // Python str.strip("`") removes leading/trailing backticks only.
  p = p.replace(/^`+/, '').replace(/`+$/, '').trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1);
  }
  p = p.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  while (p.startsWith('./')) p = p.slice(2);
  return p.trim();
}

/**
 * Extract file paths from a work item's Key Files section.
 *
 * Mirrors `audit_runner._extract_key_files`: finds a markdown heading like
 * `## Key Files` (or `## Key Files (predicted)`) and returns the
 * backtick-quoted paths listed beneath it (one per bullet/numbered line),
 * falling back to the first whitespace-delimited token on a bullet line.
 * Returns an empty list when no Key Files section is present.
 */
export function extractKeyFiles(description: string | null | undefined): string[] {
  if (!description) return [];
  const heading = /^#{0,4}\s*Key Files.*?$/im.exec(description);
  if (!heading) return [];

  const files: string[] = [];
  const rest = description.slice(heading.index + heading[0].length);
  for (const rawLine of rest.split('\n')) {
    const stripped = rawLine.trim();
    if (!stripped) continue;
    if (/^#{1,6}\s/.test(stripped)) break; // next heading ends the section
    const backtick = /`([^`]+)`/.exec(stripped);
    let candidate = '';
    if (backtick) {
      candidate = backtick[1].trim();
    } else {
      const bullet = /^[-*]\s+(\S+)/.exec(stripped);
      candidate = bullet ? bullet[1] : '';
    }
    if (candidate) files.push(candidate);
  }
  return files;
}

/**
 * Serialise a value exactly as Python's `json.dumps(value, sort_keys=True)`
 * does: recursively sorted object keys, `, ` / `: ` separators, and
 * `ensure_ascii=True` string escaping (non-ASCII as `\uXXXX`, surrogate
 * pairs for supplementary-plane characters).
 *
 * The fingerprint payload contains only strings, string arrays and nested
 * string objects, so number/bool/null handling is present for completeness
 * but is not exercised by the payload.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return pythonJsonString(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return (
      '{' +
      keys.map(k => pythonJsonString(k) + ': ' + canonicalJson(record[k])).join(', ') +
      '}'
    );
  }
  throw new TypeError(`canonicalJson: unsupported value type ${typeof value}`);
}

/**
 * Python `json.dumps(ensure_ascii=True)` string encoding, quoted.
 *
 * Control characters use the short escapes Python emits (`\b \f \n \r \t`),
 * other control characters and non-ASCII code points use `\uXXXX` (with a
 * surrogate pair above U+FFFF). DEL (U+007F) is ASCII in Python's encoder and
 * is therefore left literal, as are `/` and every other printable ASCII
 * character.
 */
function pythonJsonString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        if (cp < 0x20) {
          out += '\\u' + cp.toString(16).padStart(4, '0');
        } else if (cp > 0x7f) {
          if (cp > 0xffff) {
            const offset = cp - 0x10000;
            const high = 0xd800 + (offset >> 10);
            const low = 0xdc00 + (offset & 0x3ff);
            out += '\\u' + high.toString(16).padStart(4, '0');
            out += '\\u' + low.toString(16).padStart(4, '0');
          } else {
            out += '\\u' + cp.toString(16).padStart(4, '0');
          }
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

/**
 * Resolve the set of repository paths a work item touched.
 *
 * Mirrors `audit_runner._resolve_touched_files` (without the optional
 * comment-hash source, matching the canonical read path): the union of
 * files in commits whose message references the work item id and the
 * `Key Files` entries from the description. Normalised, de-duplicated and
 * sorted. Returns `null` (fail-open) when the set cannot be determined — git
 * unavailable, or no paths recorded.
 */
export function resolveTouchedFiles(
  id: string,
  description: string,
  runGit: GitRunner
): string[] | null {
  const issueId = (id || '').trim();
  const paths = new Set<string>();

  if (issueId) {
    const proc = runGit([
      'log',
      '--all',
      '--fixed-strings',
      `--grep=${issueId}`,
      '--name-only',
      `--format=${TOUCHED_FILES_COMMIT_MARKER}%H`,
    ]);
    if (!proc.ok) return null;
    for (const line of proc.stdout.split('\n')) {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith(TOUCHED_FILES_COMMIT_MARKER)) continue;
      const normalised = normaliseRepoPath(stripped);
      if (normalised) paths.add(normalised);
    }
  }

  for (const keyFile of extractKeyFiles(description)) {
    const normalised = normaliseRepoPath(keyFile);
    if (normalised) paths.add(normalised);
  }

  if (paths.size === 0) return null;
  return [...paths].sort();
}

/**
 * Parse the path from a `git status --porcelain` entry.
 *
 * Mirrors `audit_runner._parse_porcelain_path`. Handles the rename/copy form
 * (`R  old -> new` → `new`). The leading status column is significant, so
 * only trailing whitespace is stripped before slicing.
 */
export function parsePorcelainPath(line: string): string {
  let entry = line.replace(/\s+$/, '');
  if (!entry) return '';
  if (entry.includes(' -> ')) {
    entry = entry.split(' -> ')[1];
  } else if (entry.length > 3) {
    entry = entry.slice(3);
  } else {
    return '';
  }
  return normaliseRepoPath(entry);
}

/**
 * Capture the current state of each touched path.
 *
 * Mirrors `audit_runner._compute_path_fingerprints`: for each path records
 * `head` (its blob hash at HEAD, else the latest commit touching it, else
 * empty for a never-committed path) and `worktree` (the narrowed
 * working-tree state from `git status --porcelain --` and
 * `git diff --name-only HEAD --`). Returns `null` when a required git call
 * fails, so callers fail open.
 */
export function computePathFingerprints(
  paths: string[],
  runGit: GitRunner
): Record<string, { head: string; worktree: string }> | null {
  if (paths.length === 0) return null;

  const worktree: Record<string, string[]> = {};
  for (const path of paths) worktree[path] = [];

  const commands: string[][] = [
    ['status', '--porcelain', '--', ...paths],
    ['diff', '--name-only', 'HEAD', '--', ...paths],
  ];
  for (const cmd of commands) {
    const proc = runGit(cmd);
    if (!proc.ok) return null;
    const diffOnly = cmd[0] === 'diff';
    for (const line of proc.stdout.split('\n')) {
      const stripped = line.trim();
      if (!stripped) continue;
      const path = diffOnly ? normaliseRepoPath(stripped) : parsePorcelainPath(line);
      if (path && path in worktree) worktree[path].push(stripped);
    }
  }

  const states: Record<string, { head: string; worktree: string }> = {};
  for (const path of paths) {
    let head = '';
    const revParse = runGit(['rev-parse', `HEAD:${path}`]);
    if (revParse.ok && revParse.stdout.trim()) {
      head = revParse.stdout.trim();
    } else {
      // Not present at HEAD (deleted / untracked): fall back to the latest
      // commit that touched the path (empty when never committed).
      const logProc = runGit(['log', '-1', '--format=%H', '--', path]);
      if (!logProc.ok) return null;
      head = logProc.stdout.trim();
    }
    const unique = [...new Set(worktree[path])].sort();
    states[path] = { head, worktree: unique.join('\n') };
  }
  return states;
}

/** Schema version of the canonical content fingerprint (mirrors
 * `audit_runner._AUDIT_CONTENT_FINGERPRINT_SCHEMA`). */
export const AUDIT_CONTENT_FINGERPRINT_SCHEMA = 2;

/**
 * Coerce a work-item field to the deterministic string the Python side hashes.
 *
 * Mirrors `audit_runner._fingerprint_text`: strings pass through, `null` /
 * `undefined` become the empty string, and anything else (a garbage value from
 * a hand-edited store) is canonicalised as JSON — the same canonical form the
 * Python `json.dumps(..., sort_keys=True)` fallback produces — so both sides
 * still agree.
 */
function fingerprintText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return canonicalJson(value);
  if (typeof value === 'object') {
    try {
      return canonicalJson(value);
    } catch {
      return typeof value;
    }
  }
  return typeof value;
}

/**
 * Compute the canonical (schema 2) content fingerprint for a work item.
 *
 * Hashes only the item's own `title` and `description` — never git state,
 * comments or lifecycle fields — and performs no I/O, so it is safe to call
 * for every item in a list read.
 *
 * Returns the SHA-256 hex digest, or `null` only when the payload cannot be
 * built (non-JSON-able field value); callers treat `null` as "cannot prove
 * freshness" and fall back to the time gate (fail-safe).
 */
export function computeContentFingerprint(input: {
  title?: string | null;
  description?: string | null;
}): string | null {
  try {
    const payload = canonicalJson({
      schema: AUDIT_CONTENT_FINGERPRINT_SCHEMA,
      title_hash: sha256Hex(fingerprintText(input.title)),
      description_hash: sha256Hex(fingerprintText(input.description)),
    });
    return sha256Hex(payload);
  } catch {
    return null;
  }
}
