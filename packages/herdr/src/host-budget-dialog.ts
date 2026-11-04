/**
 * packages/herdr/src/host-budget-dialog.ts — Interactive over-quota
 * confirmation dialog (WL-0MVXY0Z93002HKCZ F4, parent WL-0MVXWQFGV000D2AB).
 *
 * When an operator fires `/skill:implement` or `/skill:audit` BY HAND and the
 * tier is already at (or over) the machine-wide cap, the dispatch must ask
 * first — naming the tier, the live count, the cap and the overshoot — and
 * offer cancel (the safe default) or "proceed anyway". Dispatcher-fired work
 * never prompts (its admission refuses the tick); this dialog is the
 * interactive path's counterpart.
 *
 * Design follows `ship-it-dialog.ts` deliberately: a bottom-anchored overlay
 * composed over the already-rendered selection list (the list stays visible),
 * inside the pane height budget, keyboard-driven with no typed confirmation
 * (a routine, reversible decision — unlike a release).
 *
 * Provides:
 *   - {@link formatHostBudgetHeadline} — the one-line copy (AC3)
 *   - {@link HostBudgetDialogState} — key handling, cancel-first (AC5)
 *   - {@link formatHostBudgetDialog} — the bordered dialog box
 *   - {@link overlayHostBudgetDialog} — bottom-anchored composition (AC1)
 *   - {@link createHostBudgetPromptHost} — the renderer↔awaiter bridge: the
 *     TUI (worklist) registers a renderer, the dispatch path (`index.ts`)
 *     awaits {@link HostBudgetPromptHost.ask}. No renderer ⇒ cancel, so the
 *     safe default also holds when no TUI is attached.
 *
 * Width/wrap math reuses `visibleWidth`/`truncateToWidth` from
 * `form-dialog.ts` (no new dependencies).
 */

import { visibleWidth, truncateToWidth } from './form-dialog.js';
import { splitKeypresses } from './key-input.js';
import { computeOverQuota, type HostBudgetKind } from './host-dispatch-budget.js';

// ── ANSI helpers ──────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

// ── Types ─────────────────────────────────────────────────────────────

/** What the dialog asks the human about: one tier, its live count and cap. */
export interface HostBudgetPromptRequest {
  kind: HostBudgetKind;
  /** Live dispatches of this tier observed before this dispatch starts. */
  live: number;
  /** The tier's configured cap (`budget.json` + env, clamped). */
  max: number;
}

/** The two answers. Cancel is the state on open (safe default). */
export type HostBudgetDialogChoice = 'proceed' | 'cancel';

/** The TUI side of the bridge: render the prompt and report the answer. */
export interface HostBudgetPromptRenderer {
  /**
   * Show the prompt. `resolve` must be called exactly once with the human's
   * choice; the renderer owns the modal state until then.
   */
  open(
    request: HostBudgetPromptRequest,
    resolve: (choice: HostBudgetDialogChoice) => void,
  ): void;
}

/** The dispatch side of the bridge (see {@link createHostBudgetPromptHost}). */
export interface HostBudgetPromptHost {
  /**
   * Register the TUI renderer (the worklist registers exactly one at start).
   * The returned function unregisters it and settles any pending prompt as
   * `cancel`, so a TUI teardown can never leave the dispatch path awaiting
   * forever.
   */
  register(renderer: HostBudgetPromptRenderer): () => void;
  /**
   * Ask the human about `request`. Resolves `cancel` when no renderer is
   * registered (no TUI ⇒ safe default) and cancels an already-pending prompt
   * before opening a new one (one prompt at a time).
   */
  ask(request: HostBudgetPromptRequest): Promise<HostBudgetDialogChoice>;
}

// ── Copy ──────────────────────────────────────────────────────────────

/** Human-facing tier label used in the dialog and the notice copy. */
export function hostBudgetTierLabel(kind: HostBudgetKind): string {
  return kind === 'implement' ? 'Implement' : 'Audit';
}

/**
 * The overshoot this dispatch would add: `1` at cap, `n + 1` when the tier is
 * already `n` over, `1` for a disabled tier (`max 0`). Delegates to the shared
 * `computeOverQuota` so the dialog and the dispatcher's log cannot drift
 * (AC4).
 */
export function hostBudgetOvershoot(request: HostBudgetPromptRequest): number {
  return computeOverQuota(request.live, request.max);
}

/** The dialog's headline copy — names tier, live count, cap and overshoot. */
export function formatHostBudgetHeadline(request: HostBudgetPromptRequest): string {
  return (
    `${hostBudgetTierLabel(request.kind)} dispatch would exceed the host quota ` +
    `(${request.live} running, max ${request.max}) — over by ${hostBudgetOvershoot(request)}.`
  );
}

// ── HostBudgetDialogState ─────────────────────────────────────────────

/**
 * Mutable state for the over-quota confirmation dialog.
 *
 * Keys: `Enter`/`y` = proceed anyway, `Esc`/`n` = cancel. Cancel is the state
 * on open and stays the state for every other key, so a stray keypress can
 * never dispatch over quota (AC5).
 */
export class HostBudgetDialogState {
  /** The question being asked (drives the render). */
  readonly request: HostBudgetPromptRequest;

  /** The current answer — `cancel` until a proceed key arrives (safe default). */
  choice: HostBudgetDialogChoice;

  private onProceed: () => void;

  private onCancel: () => void;

  constructor(
    request: HostBudgetPromptRequest,
    onProceed: () => void,
    onCancel: () => void,
  ) {
    this.request = request;
    this.choice = 'cancel';
    this.onProceed = onProceed;
    this.onCancel = onCancel;
  }

  /**
   * Process a raw stdin chunk while the dialog is open.
   *
   * A single `data` event may carry several coalesced keystrokes; each token is
   * applied in order and the first terminal key wins (same rule as the Ship It
   * dialog). Recognised keys: Enter / `y` / `Y` proceed, Esc / `n` / `N`
   * cancel. Any other key (including arrow-key escape sequences) is ignored
   * and leaves the answer at the safe default.
   *
   * @returns 'proceed' or 'cancel' — the resolved answer — or null while the
   *          dialog stays open.
   */
  handleInput(chunk: string): HostBudgetDialogChoice | null {
    const keys = splitKeypresses(chunk);
    for (const key of keys) {
      if (key === '\r' || key === '\n' || key === 'y' || key === 'Y') {
        this.choice = 'proceed';
        this.onProceed();
        return 'proceed';
      }
      if (key === '\x1b' || key === 'n' || key === 'N') {
        this.choice = 'cancel';
        this.onCancel();
        return 'cancel';
      }
    }
    return null;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────

/**
 * Render the over-quota dialog as a bordered box (bottom-anchored by
 * {@link overlayHostBudgetDialog}).
 *
 * The body is split into two fixed lines (headline / figures) so a narrow
 * pane only ever truncates, never re-flows into an unbounded height.
 *
 * @param maxCols - Terminal width (drives box width and centering)
 * @param request - The question being asked
 */
export function formatHostBudgetDialog(
  maxCols: number,
  request: HostBudgetPromptRequest,
): string {
  const lines: string[] = [];
  const dialogWidth = Math.min(maxCols - 4, 70);
  const dialogMinWidth = 46;
  const effectiveWidth = Math.max(1, Math.min(Math.max(dialogMinWidth, dialogWidth), maxCols));
  const leftPad = Math.max(0, Math.floor((maxCols - effectiveWidth) / 2));

  const padLine = (content: string): string => {
    const innerWidth = Math.max(1, effectiveWidth - 4);
    const truncated = truncateToWidth(content, innerWidth);
    const visibleLen = visibleWidth(truncated);
    const rightPad = Math.max(0, effectiveWidth - visibleLen - 4);
    return ' '.repeat(leftPad) + `│ ${truncated}${' '.repeat(rightPad)} │`;
  };

  const borderLine = (left: string, right: string): string =>
    ' '.repeat(leftPad) + `${left}${'─'.repeat(effectiveWidth - 2)}${right}`;

  const tier = hostBudgetTierLabel(request.kind);

  lines.push(borderLine('┌', '┐'));
  lines.push(padLine(`${ANSI.bold}Host quota exceeded — ${tier} dispatch${ANSI.reset}`));
  lines.push(padLine(`${tier} dispatch would exceed the host quota`));
  lines.push(
    padLine(
      `(${request.live} running, max ${request.max}) — over by ${hostBudgetOvershoot(request)}.`,
    ),
  );
  lines.push(padLine(''));
  lines.push(
    padLine(`${ANSI.dim}[Enter/y] proceed anyway   [Esc/n] cancel (default)${ANSI.reset}`),
  );
  lines.push(borderLine('└', '┘'));
  return lines.join('\n');
}

/**
 * Overlay the over-quota dialog on the bottom rows of the rendered selection
 * list: the list stays visible above it and the total never exceeds the pane
 * height budget (AC1).
 */
export function overlayHostBudgetDialog(
  listOutput: string,
  maxCols: number,
  maxRows: number,
  request: HostBudgetPromptRequest,
): string {
  const dialogLines = formatHostBudgetDialog(maxCols, request).split('\n');
  const listLines = listOutput.split('\n');
  const keep = Math.max(0, listLines.length - dialogLines.length);
  const result = [...listLines.slice(0, keep), ...dialogLines];
  return result.slice(0, Math.max(1, maxRows)).join('\n');
}

// ── Prompt bridge ─────────────────────────────────────────────────────

/**
 * Create the renderer↔awaiter bridge between the TUI and the dispatch path.
 *
 * The dispatch path (`index.ts`'s `route === 'agent'` block) awaits
 * {@link HostBudgetPromptHost.ask}; the TUI (the worklist) registers the
 * renderer that actually paints the dialog and collects the keystrokes. One
 * host per process is enough — there is exactly one worklist TUI and one
 * dispatch path — but the host holds no module-level state, so tests create
 * their own instances.
 *
 * Fail-safe by construction: with no registered renderer — or a renderer whose
 * registration is torn down while a prompt is pending — the answer is
 * `cancel`, never an indefinite await.
 */
export function createHostBudgetPromptHost(): HostBudgetPromptHost {
  let renderer: HostBudgetPromptRenderer | null = null;
  let pending: { resolve: (choice: HostBudgetDialogChoice) => void } | null = null;

  const settlePending = (choice: HostBudgetDialogChoice): void => {
    const entry = pending;
    pending = null;
    entry?.resolve(choice);
  };

  return {
    register(next: HostBudgetPromptRenderer): () => void {
      renderer = next;
      return () => {
        if (renderer === next) renderer = null;
        settlePending('cancel');
      };
    },
    ask(request: HostBudgetPromptRequest): Promise<HostBudgetDialogChoice> {
      // One prompt at a time: an older pending prompt is answered safely
      // (`cancel`) before the new one opens.
      settlePending('cancel');
      return new Promise<HostBudgetDialogChoice>((resolve) => {
        const entry = { resolve };
        pending = entry;
        if (renderer === null) {
          pending = null;
          resolve('cancel');
          return;
        }
        renderer.open(request, (choice) => {
          if (pending === entry) pending = null;
          resolve(choice);
        });
      });
    },
  };
}
