import { spawn } from 'node:child_process';
import * as os from 'os';

export type SpawnLike = (...args: any[]) => any;

/**
 * Result of a clipboard read (paste) operation.
 */
export interface ClipboardReadResult {
  /** Whether the read succeeded */
  success: boolean;
  /** The clipboard text content (only when success is true) */
  data?: string;
  /** Error description (only when success is false) */
  error?: string;
}

/**
 * Copy text to the clipboard.
 *
 * Strategy:
 * 1. If running inside tmux ($TMUX is set), use `tmux set-buffer` so that
 *    tmux paste (prefix + ]) and any shell Ctrl+V bindings that read tmux
 *    buffers work immediately.
 * 2. Try to set the system clipboard as well (OSC 52, then platform tools)
 *    so that GUI applications can also paste the text.
 * 3. On macOS use pbcopy; on Windows use clip; on Linux try wl-copy (if
 *    WAYLAND_DISPLAY is set), then xclip, then xsel.
 *
 * The function reports success if at least one method succeeds.
 */
export async function copyToClipboard(
  text: string,
  opts?: { spawn?: SpawnLike; writeOsc52?: (seq: string) => void; env?: Record<string, string | undefined> },
): Promise<{ success: boolean; error?: string }> {
  const spawnImpl = opts?.spawn ?? spawn;
  const env = opts?.env ?? process.env;
  let anySuccess = false;
  const errors: string[] = [];

  // --- Helper: run a command, pipe `text` to its stdin ----------------------
  const run = (cmd: string, args: string[]) => new Promise<{ code: number | null; error?: Error }>((resolve) => {
    try {
      // Spawn in a detached process group so clipboard daemons (e.g. xclip)
      // survive when the parent TUI process group receives signals or tears
      // down the terminal.
      const cp = spawnImpl(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
      let handled = false;
      cp.on('error', (err: Error) => { if (!handled) { handled = true; resolve({ code: null, error: err }); } });
      cp.on('close', (code: number) => {
        if (!handled) { handled = true; resolve({ code }); }
        // Allow the Node process to exit without waiting for the detached
        // clipboard daemon (e.g. xclip forks a background process to serve
        // the X11 selection). We call unref() only after the close event
        // fires so we don't lose the event.
        try { if (typeof cp.unref === 'function') cp.unref(); } catch (_) {}
      });
      if (!cp.stdin || typeof cp.stdin.write !== 'function') {
        if (!handled) { handled = true; resolve({ code: null, error: new Error('stdin not available') }); }
        return;
      }
      try {
        cp.stdin.write(String(text));
        cp.stdin.end();
      } catch (writeErr: any) {
        try { cp.stdin.end(); } catch (_) {}
        if (!handled) { handled = true; resolve({ code: null, error: writeErr instanceof Error ? writeErr : new Error(String(writeErr)) }); }
      }
    } catch (err: any) {
      resolve({ code: null, error: err });
    }
  });

  // --- Helper: run a command with arguments (no stdin) ----------------------
  const runArgs = (cmd: string, args: string[]) => new Promise<{ code: number | null; error?: Error }>((resolve) => {
    try {
      const cp = spawnImpl(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
      let handled = false;
      cp.on('error', (err: Error) => { if (!handled) { handled = true; resolve({ code: null, error: err }); } });
      cp.on('close', (code: number) => {
        if (!handled) { handled = true; resolve({ code }); }
        try { if (typeof cp.unref === 'function') cp.unref(); } catch (_) {}
      });
    } catch (err: any) {
      resolve({ code: null, error: err });
    }
  });

  try {
    // ----- 1. tmux paste buffer ---------------------------------------------
    // When running inside tmux, set the tmux paste buffer so that the user
    // can paste with `prefix + ]` (or Ctrl+V if their shell/tmux binds it).
    if (env.TMUX) {
      const res = await runArgs('tmux', ['set-buffer', '--', String(text)]);
      if (res.code === 0) {
        anySuccess = true;
      } else {
        errors.push(res.error?.message || 'tmux set-buffer failed');
      }
    }

    // ----- 2. WSL / OSC 52 -------------------------------------------------
    // Special-case: when running inside WSL, try the Windows clipboard helper
    // (`clip.exe`) via interop. This helps common setups where tmux runs in
    // WSL but the user expects the Windows clipboard to be updated.
    // Detection is driven by environment variables set by WSL (WSL_DISTRO_NAME
    // or WSL_INTEROP). Avoid relying on kernel-release text (os.release()) as
    // it can produce false positives in some test/CI environments.
    const isWSL = typeof env.WSL_DISTRO_NAME === 'string' || typeof env.WSL_INTEROP === 'string';
    if (isWSL) {
      try {
        const clipRes = await run('clip.exe', []);
        if (clipRes.code === 0) {
          anySuccess = true;
        } else if (clipRes.error) {
          errors.push(clipRes.error.message);
        }
      } catch (e: any) {
        errors.push(e?.message || 'clip.exe failed');
      }
    }

    // ----- 3. OSC 52 --------------------------------------------------------
    // Write an OSC 52 escape sequence. If the terminal (or tmux with
    // set-clipboard on) supports it, this also sets the system clipboard.
    if (opts?.writeOsc52) {
      try {
        const b64 = Buffer.from(String(text)).toString('base64');
        opts.writeOsc52(`\x1b]52;c;${b64}\x07`);
        anySuccess = true;
      } catch (e: any) {
        errors.push(e?.message || 'OSC 52 write failed');
      }
    }

    // ----- 3. Platform clipboard tools --------------------------------------
    const plat = process.platform;
    if (plat === 'darwin') {
      const res = await run('pbcopy', []);
      if (res.code === 0) { anySuccess = true; }
      else { errors.push(res.error?.message || 'pbcopy failed'); }
    } else if (plat === 'win32') {
      const res = await run('cmd', ['/c', 'clip']);
      if (res.code === 0) { anySuccess = true; }
      else { errors.push(res.error?.message || 'clip failed'); }
    } else {
      // Linux / other: try wl-copy (Wayland), then xclip, then xsel
      let systemClipOk = false;
      if (env.WAYLAND_DISPLAY) {
        const wlcopy = await run('wl-copy', []);
        if (wlcopy.code === 0) { anySuccess = true; systemClipOk = true; }
        else if (wlcopy.error) { errors.push(wlcopy.error.message); }
      }
      if (!systemClipOk) {
        const xclip = await run('xclip', ['-selection', 'clipboard']);
        if (xclip.code === 0) { anySuccess = true; systemClipOk = true; }
        else if (xclip.error) { errors.push(xclip.error.message); }
      }
      if (!systemClipOk) {
        const xsel = await run('xsel', ['--clipboard', '--input']);
        if (xsel.code === 0) { anySuccess = true; systemClipOk = true; }
        else if (xsel.error) { errors.push(xsel.error.message); }
      }
      if (!systemClipOk && !anySuccess && errors.length === 0) {
        errors.push('clipboard command not available (install xclip, xsel, or wl-copy)');
      }
    }

    if (anySuccess) return { success: true };
    return { success: false, error: errors.join('; ') || 'no clipboard method available' };
  } catch (err: any) {
    if (anySuccess) return { success: true };
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Read text from the OS clipboard (paste).
 *
 * Strategy (platform-ordered, no tmux dependency — herdr environment):
 * 1. macOS → `pbpaste`
 * 2. Windows → `powershell -Command Get-Clipboard`
 * 3. Linux + Wayland → `wl-paste --no-newline`
 * 4. Linux + X11 → `xclip -selection clipboard -o` → `xsel --clipboard --output`
 *
 * The function returns the clipboard content as a string. It is designed for
 * the herdr plugin where the tmux paste buffer is NOT used.
 *
 * @param _text - Unused placeholder to keep signature consistent with `copyToClipboard`
 * @param opts - Injected dependencies for testability
 * @returns Clipboard content or an error description
 */
export async function readFromClipboard(
  _text?: string,
  opts?: { spawn?: SpawnLike; env?: Record<string, string | undefined> },
): Promise<ClipboardReadResult> {
  const spawnImpl = opts?.spawn ?? spawn;
  const env = opts?.env ?? process.env;
  let anySuccess = false;
  let data = '';
  const errors: string[] = [];

  // --- Helper: run a command, capture stdout --------------------------------
  const runRead = (cmd: string, args: string[]) =>
    new Promise<{ code: number | null; error?: Error; stdout: string }>((resolve) => {
      try {
        const cp = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        let handled = false;
        const chunks: Buffer[] = [];
        cp.on('error', (err: Error) => {
          if (!handled) { handled = true; resolve({ code: null, error: err, stdout: '' }); }
        });
        cp.on('close', (code: number) => {
          if (!handled) {
            handled = true;
            resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), error: undefined });
          }
          try { if (typeof cp.unref === 'function') cp.unref(); } catch (_) {}
        });
        cp.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
        cp.stderr?.on('data', () => { /* discard stderr */ });
      } catch (err: any) {
        resolve({ code: null, error: err, stdout: '' });
      }
    });

  try {
    // ----- 1. macOS --------------------------------------------------------
    if (process.platform === 'darwin') {
      const res = await runRead('pbpaste', []);
      if (res.code === 0 && res.stdout !== undefined) {
        anySuccess = true;
        data = res.stdout;
      } else {
        errors.push(res.error?.message || 'pbpaste failed');
      }
    }
    // ----- 2. Windows ------------------------------------------------------
    else if (process.platform === 'win32') {
      const res = await runRead('powershell', ['-Command', 'Get-Clipboard']);
      if (res.code === 0 && res.stdout !== undefined) {
        anySuccess = true;
        data = res.stdout.trim();
      } else {
        // Fallback: cmd /c clip.exe doesn't read, try Get-Clipboard via cmd
        errors.push(res.error?.message || 'Get-Clipboard failed');
      }
    }
    // ----- 3. Linux --------------------------------------------------------
    else {
      // Try wl-paste (Wayland) first
      let systemClipOk = false;
      if (env.WAYLAND_DISPLAY) {
        const res = await runRead('wl-paste', ['--no-newline']);
        if (res.code === 0 && res.stdout !== undefined) {
          anySuccess = true;
          data = res.stdout;
          systemClipOk = true;
        } else {
          errors.push(res.error?.message || 'wl-paste failed');
        }
      }
      // Fall back to xclip (X11)
      if (!systemClipOk) {
        const res = await runRead('xclip', ['-selection', 'clipboard', '-o']);
        if (res.code === 0 && res.stdout !== undefined) {
          anySuccess = true;
          data = res.stdout;
          systemClipOk = true;
        } else {
          errors.push(res.error?.message || 'xclip failed');
        }
      }
      // Fall back to xsel (X11)
      if (!systemClipOk) {
        const res = await runRead('xsel', ['--clipboard', '--output']);
        if (res.code === 0 && res.stdout !== undefined) {
          anySuccess = true;
          data = res.stdout;
          systemClipOk = true;
        } else {
          errors.push(res.error?.message || 'xsel failed');
        }
      }
      if (!systemClipOk && !anySuccess && errors.length === 0) {
        errors.push('no clipboard reader available (install wl-paste, xclip, or xsel)');
      }
    }

    if (anySuccess) return { success: true, data };
    return { success: false, error: errors.join('; ') || 'no clipboard reader available' };
  } catch (err: any) {
    if (anySuccess) return { success: true, data };
    return { success: false, error: err?.message || String(err) };
  }
}
