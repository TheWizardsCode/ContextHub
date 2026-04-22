import type { BlessedBox, BlessedScreen } from '../types.js';

type FocusableTarget = {
  focus?: () => void;
  show?: () => void;
  hide?: () => void;
  setFront?: () => void;
};

type KeyTarget = {
  key?: (keys: string[] | string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

type MouseTarget = {
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

type KeyBinding = {
  target: KeyTarget;
  wrapped: (...args: any[]) => void;
};

type MouseBinding = {
  target: MouseTarget;
  event: string;
  wrapped: (...args: any[]) => void;
};

export interface ModalDialogBaseOptions {
  screen: BlessedScreen;
  dialog: BlessedBox;
  overlay?: BlessedBox | null;
  focusTarget?: FocusableTarget | null;
  restoreFocusTarget?: FocusableTarget | null;
}

export interface ModalOpenOptions {
  focusTarget?: FocusableTarget | null;
  restoreFocusTarget?: FocusableTarget | null;
}

export interface ModalCloseOptions {
  restoreFocus?: boolean;
}

/**
 * Reusable modal dialog primitive for TUI overlays.
 *
 * Responsibilities:
 * - lifecycle (`open`, `close`, `destroy`, `isOpen`)
 * - modal-only input handler registration for keys/mouse
 * - focus trapping while open
 * - best-effort focus restoration on close
 */
const OPEN_MODAL_SET = new Set<ModalDialogBase>();

export function isAnyDialogOpen(): boolean {
  for (const m of OPEN_MODAL_SET) {
    try { if (m.blocksMainInput()) return true; } catch (_) {}
  }
  return false;
}

export function registerAppKey(screen: any, keys: string[] | string, handler: (...args: any[]) => void): void {
  try {
    // Wrap the handler so centralized predicate logic can prevent app-level
    // shortcuts from firing when a modal/dialog is open or when focus is
    // inside an input/textarea-like widget.
    const wrapped = (...args: any[]) => {
      try {
        const focused = (screen as any).focused;
        if (focused) {
          // Determine whether the focused widget belongs to any modal's
          // focusable targets. Use internal access to avoid exposing
          // additional APIs.
          let focusedInModal = false;
          try {
            for (const m of OPEN_MODAL_SET) {
              try {
                const ft = (m as any).focusableTargets as Set<any> | undefined;
                if (ft && ft.has && ft.has(focused)) { focusedInModal = true; break; }
              } catch (_) {}
            }
          } catch (_) {}

          // If focused widget is inside a modal, suppress global shortcuts
          // when the widget looks like a textarea/input.
          if (focusedInModal) {
            const isInputLike = (
              !!focused._listener
              || !!focused._reading
              || (focused.options && Boolean((focused as any).options?.inputOnFocus))
              || !!(focused as any).__opencode_desc_key
              || !!(focused as any).__opencode_autocomplete
            );
            if (isInputLike) return;
          }
        }
      } catch (_) {}

      try { return handler(...args); } catch (_) {}
    };

    // Register wrapped handler on blessed screen.
    screen.key(keys, wrapped);
  } catch (_) {}
}

export class ModalDialogBase {
  private readonly screen: BlessedScreen;
  private readonly dialog: FocusableTarget;
  private readonly overlay: FocusableTarget | null;
  private readonly defaultFocusTarget: FocusableTarget | null;

  private restoreFocusTarget: FocusableTarget | null;
  private previousFocus: FocusableTarget | null = null;
  private openState = false;

  private readonly focusableTargets = new Set<FocusableTarget>();
  private readonly keyBindings: KeyBinding[] = [];
  private readonly mouseBindings: MouseBinding[] = [];

  private trapHandlersAttached = false;

  constructor(options: ModalDialogBaseOptions) {
    this.screen = options.screen;
    this.dialog = options.dialog;
    this.overlay = options.overlay || null;
    this.defaultFocusTarget = options.focusTarget || null;
    this.restoreFocusTarget = options.restoreFocusTarget || null;

    this.registerFocusable(this.dialog);
    if (this.overlay) this.registerFocusable(this.overlay);
    if (this.defaultFocusTarget) this.registerFocusable(this.defaultFocusTarget);
    if (this.restoreFocusTarget) this.registerFocusable(this.restoreFocusTarget);
  }

  open(options: ModalOpenOptions = {}): void {
    const focusTarget = options.focusTarget || this.defaultFocusTarget || this.dialog;
    if (options.restoreFocusTarget !== undefined) {
      this.restoreFocusTarget = options.restoreFocusTarget;
      if (options.restoreFocusTarget) this.registerFocusable(options.restoreFocusTarget);
    }
    if (focusTarget) this.registerFocusable(focusTarget);

    if (this.openState) {
      this.focusTarget(focusTarget);
      return;
    }

    this.previousFocus = ((this.screen as any).focused as FocusableTarget | null) || null;
    this.openState = true;

    try { OPEN_MODAL_SET.add(this); } catch (_) {}

    try { this.overlay?.show?.(); } catch (_) {}
    try { this.dialog.show?.(); } catch (_) {}
    try { this.overlay?.setFront?.(); } catch (_) {}
    try { this.dialog.setFront?.(); } catch (_) {}

    this.attachFocusTrap();
    this.setScreenGrabKeys(true);
    this.focusTarget(focusTarget);
  }

  close(options: ModalCloseOptions = {}): void {
    if (!this.openState) return;

    this.openState = false;
    try { OPEN_MODAL_SET.delete(this); } catch (_) {}
    this.setScreenGrabKeys(false);
    this.detachFocusTrap();

    try { this.dialog.hide?.(); } catch (_) {}
    try { this.overlay?.hide?.(); } catch (_) {}

    if (options.restoreFocus !== false) {
      const target = this.restoreFocusTarget || this.previousFocus;
      this.focusTarget(target);
    }
    this.previousFocus = null;
  }

  isOpen(): boolean {
    return this.openState;
  }

  blocksMainInput(): boolean {
    return this.openState;
  }

  registerFocusable(target: FocusableTarget | null | undefined): void {
    if (!target) return;
    this.focusableTargets.add(target);
  }

  registerKeyHandler(
    target: KeyTarget | null | undefined,
    keys: string[] | string,
    handler: (...args: any[]) => void,
  ): void {
    if (!target || typeof target.key !== 'function') return;
    const wrapped = (...args: any[]) => {
      try { if (process.env.WL_DEBUG) /* eslint-disable-next-line no-console */ console.log('DEBUG ModalDialogBase.wrapped: invoked, openState=', this.openState, 'handlerName=', (wrapped as any).__opencode_original?.name); } catch (_) {}
      if (!this.openState) return;
      try { return (wrapped as any).__opencode_original?.apply?.(null, args) ?? handler(...args); } catch (err) { try { handler(...args); } catch (_) {} }
    };
    // Log registration for diagnostics when running tests.
    try { if (process.env.WL_DEBUG) /* eslint-disable-next-line no-console */ console.log('DEBUG ModalDialogBase.registerKeyHandler: registering keys=', keys); } catch (_) {}
    target.key(keys, wrapped);
    // Attach metadata to the wrapper so runtime execution and tests can
    // identify the original handler and target. This helps the test
    // harness discover the exact function instance that will run.
    try {
      (wrapped as any).__opencode_original = handler;
      (wrapped as any).__opencode_target = target;
    } catch (_) {}
    // Expose the actual wrapped handler on the target for test-harness
    // discoverability. Tests in this repo sometimes inspect mocked
    // `target.key` calls which can be brittle when callers wrap handlers
    // (we do that to gate handlers by modal open state). Attach the
    // wrapper under a predictable property so tests can call the same
    // function instance that will actually run at runtime.
    try {
      const asAny = target as any;
      asAny.__opencode_registered_wrapped = wrapped;
      // Also expose named shortcut properties for common keys so tests
      // that expect __opencode_key_tab/__opencode_key_stab continue to
      // work regardless of whether registration happened via the
      // modal-level helper or directly on the widget.
      const setNamed = (k: string) => {
        const low = k.toLowerCase();
        if (low === 'tab' || low === 'c-i') asAny.__opencode_key_tab = wrapped;
        if (low === 's-tab' || low === 'c-s-i' || (low.includes('s') && low.includes('tab'))) asAny.__opencode_key_stab = wrapped;
        if (low === 'enter') asAny.__opencode_key_enter = wrapped;
        if (low === 'escape' || low === 'esc') asAny.__opencode_key_escape = wrapped;
      };
      if (typeof keys === 'string') setNamed(keys);
      else if (Array.isArray(keys)) keys.forEach(setNamed);
    } catch (_) {}
    this.keyBindings.push({ target, wrapped });
  }

  registerMouseHandler(
    target: MouseTarget | null | undefined,
    event: string,
    handler: (...args: any[]) => void,
  ): void {
    if (!target || typeof target.on !== 'function') return;
    const wrapped = (...args: any[]) => {
      if (!this.openState) return;
      handler(...args);
    };
    target.on(event, wrapped);
    this.mouseBindings.push({ target, event, wrapped });
  }

  wrapMainShortcut<T extends (...args: any[]) => unknown>(
    handler: T,
  ): (...args: Parameters<T>) => ReturnType<T> | undefined {
    return (...args: Parameters<T>) => {
      if (this.blocksMainInput()) return undefined;
      return handler(...args) as ReturnType<T>;
    };
  }

  destroy(): void {
    this.close({ restoreFocus: false });

    for (const binding of this.keyBindings) {
      try { binding.target.removeListener?.('keypress', binding.wrapped); } catch (_) {}
    }
    for (const binding of this.mouseBindings) {
      try { binding.target.removeListener?.(binding.event, binding.wrapped); } catch (_) {}
    }
    this.keyBindings.length = 0;
    this.mouseBindings.length = 0;
    this.focusableTargets.clear();
  }

  private focusTarget(target: FocusableTarget | null | undefined): void {
    if (!target || typeof target.focus !== 'function') return;
    try { target.focus(); } catch (_) {}
  }

  private attachFocusTrap(): void {
    if (this.trapHandlersAttached) return;
    const screenAny = this.screen as any;
    if (typeof screenAny.on !== 'function') return;

    try { screenAny.on('keypress', this.focusTrapHandler); } catch (_) {}
    try { screenAny.on('mouse', this.focusTrapHandler); } catch (_) {}
    this.trapHandlersAttached = true;
  }

  private detachFocusTrap(): void {
    if (!this.trapHandlersAttached) return;
    const screenAny = this.screen as any;
    if (typeof screenAny.removeListener !== 'function') {
      this.trapHandlersAttached = false;
      return;
    }

    try { screenAny.removeListener('keypress', this.focusTrapHandler); } catch (_) {}
    try { screenAny.removeListener('mouse', this.focusTrapHandler); } catch (_) {}
    this.trapHandlersAttached = false;
  }

  private readonly focusTrapHandler = () => {
    if (!this.openState) return;

    const focused = ((this.screen as any).focused as FocusableTarget | null) || null;
    if (focused && this.focusableTargets.has(focused)) return;

    this.focusTarget(this.defaultFocusTarget || this.dialog);
  };

  private setScreenGrabKeys(value: boolean): void {
    try { (this.screen as any).grabKeys = value; } catch (_) {}
  }
}
