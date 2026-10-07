/**
 * Dependency-free console progress feedback for multi-second LLM requests.
 *
 * The `wl interview` command consults a chat provider for two operations:
 * the producer-review explanation and the LLM-assisted clarifying-question
 * extraction. Both are bounded by a 15 s timeout and, without feedback, leave
 * the operator staring at a frozen terminal. This module provides a tiny
 * helper that:
 *
 *   1. prints a static status message ({@link LLM_THINKING_MESSAGE}) before a
 *      request starts, so the operator always sees that work is in progress;
 *   2. animates a spinner on the same line **only** when stdout is a TTY;
 *   3. clears the spinner deterministically before any later output or prompt;
 *   4. optionally prints a short fallback notice ({@link LLM_FALLBACK_NOTICE})
 *      when the request did not succeed and structured evidence is used.
 *
 * It deliberately uses only `setInterval` and `stream.write` — no new runtime
 * dependencies — and never emits control characters when stdout is not a TTY,
 * so piped or captured output stays clean. `--json` callers disable it
 * entirely via `enabled: false`, keeping stdout valid JSON.
 *
 * WL-0MUX2W8IN005RW66
 */

/** Static status message printed before an LLM request is issued. */
export const LLM_THINKING_MESSAGE = 'Thinking…';

/**
 * Brief notice printed when the LLM is unavailable, times out or errors and
 * the command falls back to structured evidence. Deliberately never mentions
 * "local" (producer direction), so it stays neutral about the provider.
 */
export const LLM_FALLBACK_NOTICE = 'LLM unavailable — using structured evidence.';

/**
 * Minimal write sink accepted by {@link startLlmProgress}. Defaults to
 * `process.stdout`; tests inject a capturing stream (with a controllable
 * `isTTY`) so both the TTY and non-TTY paths can be exercised.
 */
export interface ProgressWriteStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** Options for {@link startLlmProgress}. */
export interface LlmProgressOptions {
  /** Sink for status/spinner output (default `process.stdout`). */
  outStream?: ProgressWriteStream;
  /** Disable all output, e.g. in `--json` mode (default `true`). */
  enabled?: boolean;
  /** Override TTY detection (primarily for tests). */
  isTty?: boolean;
  /** Spinner frame interval in milliseconds (default 100). */
  intervalMs?: number;
  /** Static status message (default {@link LLM_THINKING_MESSAGE}). */
  message?: string;
}

/** Options accepted by {@link LlmProgressHandle.stop}. */
export interface LlmProgressStopOptions {
  /** When true, print the fallback notice after clearing the spinner. */
  fallback?: boolean;
  /** Notice text override (default {@link LLM_FALLBACK_NOTICE}). */
  notice?: string;
}

/** Handle returned by {@link startLlmProgress}. */
export interface LlmProgressHandle {
  /** The stream feedback was written to (for test assertions). */
  readonly stream: ProgressWriteStream;
  /** Whether the animated spinner is currently active. */
  readonly spinning: boolean;
  /** Stop and clear the spinner, optionally printing the fallback notice. */
  stop(options?: LlmProgressStopOptions): void;
}

/** Braille spinner frames — plain Unicode, no ANSI/control sequences. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Default spinner frame interval in milliseconds. */
const DEFAULT_FRAME_INTERVAL_MS = 100;

/**
 * Start progress feedback for an in-flight LLM request.
 *
 * Always prints the static status message. On a TTY the message is followed by
 * an animated spinner on the same line; on a non-TTY only the static message
 * (terminated by a newline) is written, with no carriage returns or other
 * control characters. Disabled mode is a complete no-op.
 *
 * {@link LlmProgressHandle.stop} is idempotent and must be called before any
 * subsequent output or interactive prompt so the spinner never interleaves
 * with the readline prompt.
 */
export function startLlmProgress(
  options: LlmProgressOptions = {},
): LlmProgressHandle {
  const stream = options.outStream ?? process.stdout;
  const message = options.message ?? LLM_THINKING_MESSAGE;
  const enabled = options.enabled ?? true;

  const write = (chunk: string): void => {
    try {
      stream.write(chunk);
    } catch {
      // Console feedback must never break the command.
    }
  };

  if (!enabled) {
    return { stream, spinning: false, stop: () => {} };
  }

  const isTty = options.isTty ?? stream.isTTY === true;

  // The static status message is always emitted; only the TTY path animates.
  // Non-TTY output is newline-terminated so piped/captured output stays clean.
  write(isTty ? `${message} ` : `${message}\n`);

  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let spinning = false;

  const renderFrame = (): void => {
    const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
    frame += 1;
    write(`\r${message} ${glyph}`);
  };

  if (isTty) {
    spinning = true;
    renderFrame();
    timer = setInterval(renderFrame, options.intervalMs ?? DEFAULT_FRAME_INTERVAL_MS);
    const handle = timer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  }

  let stopped = false;
  const stop = (stopOptions: LlmProgressStopOptions = {}): void => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    spinning = false;
    if (isTty) {
      // Overwrite the animated line so no spinner/status remains on screen.
      write(`\r${' '.repeat(message.length + 2)}\r`);
    }
    if (stopOptions.fallback) {
      write(`${stopOptions.notice ?? LLM_FALLBACK_NOTICE}\n`);
    }
  };

  return {
    get stream() {
      return stream;
    },
    get spinning() {
      return spinning;
    },
    stop,
  };
}
