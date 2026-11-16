/**
 * packages/herdr/src/cli-spawn.ts — shared CLI-resolution + spawn plumbing
 * for every herdr/wl subprocess boundary (WL-0MWHWHB3X004H9VG AC1).
 *
 * ## Why this module exists
 *
 * The fetch family (`fetcher.cli.ts`'s `runWl`), the dispatcher-anchor herdr
 * helpers (`dispatcher-anchor.herdr-cli.ts`) and the pane-close CLI bridge
 * (`pane-close-cli.ts`) each spawned a CLI with the same plumbing: probe a
 * binary (or probe in order), bound the timeout, normalise the execFile
 * stdout shape and extract a readable error message. Before this module that
 * plumbing existed in three places with duplicated binary-probe and
 * error-normalisation logic — the fourth spawn/CLI seam of the drift
 * catalogue (WL-0MWHUMOHJ006ZMBQ).
 *
 * ## What is shared here (AC1)
 *
 *  - {@link CLI_BINARIES} — the ONE canonical declaration of the wl/worklog
 *    binary probe order (the npm `wl` shim first, then the legacy `worklog`
 *    name). `fetcher.cli.ts` re-exports it unchanged so its existing
 *    consumers keep resolving the same value through the same name.
 *  - {@link DEFAULT_CLI_TIMEOUT_MS} — the ONE canonical bounded-spawn
 *    timeout (60 s). `fetcher.cli.ts::DEFAULT_WL_TIMEOUT_MS` and
 *    `pane-close-cli.ts::CLI_COMMAND_TIMEOUT_MS` both bind this constant
 *    instead of re-declaring 60_000.
 *  - {@link spawnCliStdout} — the ONE spawn primitive: probe order, bounded
 *    timeout, stdout-shape normalisation and error normalisation.
 *  - {@link isCliTimeoutError} / {@link wrapCliSpawnError} — the ONE
 *    classification of a hung child (killed / SIGTERM / SIGKILL /
 *    ETIMEDOUT / "timed out" message) and the ONE stderr > stdout > message
 *    error-message convention.
 *
 * The `herdr` binary probe keeps its own canonical home: `herdr-bin.ts`
 * (`resolveHerdrBin`). It is used unchanged by every herdr call site — this
 * module never re-declares the herdr probe.
 *
 * ## Deliberately NOT converged (AC4)
 *
 *  - wl/CLI **data reads** (`execFile`, the single in-process spawn seam)
 *    and dispatched **pane spawns** (`send-to-pi.sh`, a detached terminal
 *    launcher) are different seams by design. This module unifies the former's
 *    plumbing — probe/exec/error convention — never the latter's purpose: a
 *    pane-argv change still lives in the pane spawn builders, not here.
 *  - Per-purpose spawn choices stay at the call sites: which `maxBuffer` a
 *    data read needs, whether a call fails closed or open, and whether a
 *    caller wants the raw stdout, the parsed payload or a boolean liveness
 *    verdict. Converging those would merge unrelated seams.
 *  - `pane-close-cli.ts` keeps its injectable `io.execFileAsync` — the
 *    cross-language bridge contract (AC3) that the Python pane-triage skill
 *    pins; it passes that seam INTO {@link spawnCliStdout} rather than owning
 *    its own spawn loop.
 */

// ── Canonical declarations (AC1) ────────────────────────────────────

/**
 * CLI binaries probed in order: the npm-installed `wl` shim first, then the
 * legacy `worklog` binary name. The single canonical declaration of the
 * wl/worklog probe — every site that needs the probe imports this constant
 * (fetcher.cli.ts re-exports it; nothing re-declares `['wl', 'worklog']`).
 */
export const CLI_BINARIES = ['wl', 'worklog'] as const;

/**
 * Canonical bounded per-command timeout for herdr/wl CLI spawns: 60 s.
 * Matches the auto-sync safety timeout and the Pi TUI extension convention
 * (auto-sync.ts:227) so a hung child (e.g. waiting on a lock during a long
 * `wl sync`) rejects instead of blocking a guard forever (WL-0MSJNJXX2001NMHS).
 */
export const DEFAULT_CLI_TIMEOUT_MS = 60_000;

// ── Exec seam type ───────────────────────────────────────────────────

/**
 * The injectable exec seam `spawnCliStdout` runs through — a
 * `promisify(execFile)`-compatible function. The shared fetcher seam
 * (`fetcher.args.ts::getExecFileAsync`) and the pane-close CLI's injectable
 * `io.execFileAsync` both satisfy it.
 */
export type CliExecFile = (
  file: string,
  args: readonly string[],
  options?: unknown,
) => Promise<unknown>;

// ── Spawn options ────────────────────────────────────────────────────

/** Options for {@link spawnCliStdout}. Field names mirror execFile's. */
export interface CliSpawnOptions {
  /** Bounded timeout in ms — passed through as the execFile `timeout` option. */
  timeoutMs?: number;
  /** Maximum stdout buffer (bytes) for the child. */
  maxBuffer?: number;
  /** Working directory for the child. */
  cwd?: string;
  /** Output encoding for the child's stdout (defaults to execFile's). */
  encoding?: BufferEncoding;
}

// ── Timeout classification ───────────────────────────────────────────

/**
 * True when a spawn error came from the bounded execFile timeout (the child
 * was killed because it hung) rather than from the CLI rejecting the
 * invocation. A hung CLI must not trigger a caller's fail-open retry path —
 * retrying would double the hang instead of surfacing it (WL-0MSJNJXX2001NMHS).
 */
export function isCliTimeoutError(error: unknown): boolean {
  const e = (error ?? null) as {
    killed?: boolean;
    signal?: string;
    code?: string;
    message?: string;
  } | null;
  if (!e) return false;
  if (e.killed === true) return true;
  if (e.signal === 'SIGTERM' || e.signal === 'SIGKILL') return true;
  if (e.code === 'ETIMEDOUT') return true;
  return /timed? ?out/i.test(e.message ?? '');
}

// ── Error normalisation ──────────────────────────────────────────────

/** The wrapped error thrown by {@link spawnCliStdout} on a CLI failure. */
export interface CliSpawnError extends Error {
  /** True when the child was killed by the bounded timeout (hung CLI). */
  cliTimedOut?: boolean;
}

/**
 * Wrap an execFile error into a clean message, preserving the timeout
 * classification (as {@link CliSpawnError.cliTimedOut}) so callers can
 * distinguish "hung CLI" from "CLI rejected the invocation".
 *
 * Message precedence follows the fetcher's settled convention:
 * stderr (trimmed) → stdout (trimmed) → `error.message` → `String(error)`.
 */
export function wrapCliSpawnError(error: unknown): CliSpawnError {
  const e = (error ?? null) as { stderr?: unknown; stdout?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  const stdout = typeof e?.stdout === 'string' ? e.stdout.trim() : '';
  const rawMessage = e?.message;
  const message: string =
    stderr || stdout || (typeof rawMessage === 'string' ? rawMessage : '') || String(error);
  const wrapped = new Error(message) as CliSpawnError;
  if (isCliTimeoutError(error)) wrapped.cliTimedOut = true;
  return wrapped;
}

/**
 * Extract the stdout string from a `promisify(execFile)` result.
 *
 * Node's `util.promisify(execFile)` resolves `{ stdout, stderr }` in
 * production, but test harnesses and mocked child_process wrappers sometimes
 * lose the `promisify.custom` symbol so the generic callback shape resolves to
 * the raw stdout value (string or Buffer) instead. Normalise both shapes so
 * behaviour is identical across callers — this mirrors the former
 * `dispatcher-anchor.herdr-cli.ts::execFileStdout` contract.
 */
function stdoutFromExecResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Buffer.isBuffer(result)) return result.toString('utf8');
  const stdout = (result as { stdout?: unknown } | null | undefined)?.stdout;
  if (stdout === undefined || stdout === null) return '';
  if (typeof stdout === 'string') return stdout;
  if (Buffer.isBuffer(stdout)) return stdout.toString('utf8');
  return String(stdout);
}

// ── The shared spawn primitive ───────────────────────────────────────

/**
 * Spawn one CLI command, resolving its stdout as a string.
 *
 * Probes `binaries` in order: an ENOENT error (binary absent from PATH) moves
 * to the next candidate; any OTHER error is wrapped via
 * {@link wrapCliSpawnError} and re-thrown immediately (a rejecting or hung CLI
 * is never re-run against a later candidate — retrying would double the hang,
 * fetcher F5 lineage). When every candidate is ENOENT a
 * `<first-binary> CLI not found: <error>` error is thrown.
 *
 * The exec seam is injected (`exec`), so every caller routes through the same
 * primitive while owning its own seam (fetcher's injectable
 * `getExecFileAsync`, the pane-close CLI's `io.execFileAsync`).
 */
export async function spawnCliStdout(
  exec: CliExecFile,
  binaries: readonly string[],
  args: string[],
  opts?: CliSpawnOptions,
): Promise<string> {
  let lastError: unknown;
  const execOptions: Record<string, unknown> = {};
  if (opts?.timeoutMs !== undefined) execOptions.timeout = opts.timeoutMs;
  if (opts?.maxBuffer !== undefined) execOptions.maxBuffer = opts.maxBuffer;
  if (opts?.cwd !== undefined) execOptions.cwd = opts.cwd;
  if (opts?.encoding !== undefined) execOptions.encoding = opts.encoding;

  for (const binary of binaries) {
    try {
      const result = await exec(binary, args, execOptions);
      return stdoutFromExecResult(result);
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'ENOENT') {
        lastError = error;
        continue;
      }
      throw wrapCliSpawnError(error);
    }
  }
  throw new Error(`${binaries[0] ?? 'CLI'} CLI not found: ${String(lastError)}`);
}

