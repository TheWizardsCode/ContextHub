/**
 * packages/herdr/src/clipboard.ts — OS clipboard read/write helpers
 *
 * The herdr plugin targets the OS clipboard directly (it runs inside herdr,
 * not tmux), so clipboard operations must use platform tools / OSC 52 — there
 * is deliberately NO tmux-buffer branch here.
 *
 * Reads (`readFromClipboard`) are async and are wired into the command-input
 * form so `Ctrl+V` / `Ctrl+X` never freeze the TUI (non-blocking UX).
 */

import { spawn, type ChildProcess } from 'child_process';

/** Injectable spawn signature so tests can substitute a fake (mirrors the
 * root `src/clipboard.ts` injectable-spawn pattern). */
export type SpawnLike = (
  command: string,
  args?: readonly string[],
  options?: unknown,
) => ChildProcess;

/**
 * Read text from the OS clipboard.
 *
 * Platform-ordered like the root `copyToClipboard`, in reverse (readers):
 *   1. macOS: `pbpaste`
 *   2. Windows: PowerShell `Get-Clipboard` (`powershell -NoProfile -Command`)
 *   3. Linux (Wayland): `wl-paste` (when WAYLAND_DISPLAY is set)
 *   4. Linux (X11): `xclip -o -selection clipboard`, then `xsel --clipboard --output`
 *
 * Each candidate's stdout and exit status are captured with a bounded timeout;
 * the first tool that exits 0 and produces output wins. Failures degrade
 * gracefully: if no reader is available the result is `{ success: false,
 * error }` so the caller can surface a visible message and keep the form open.
 *
 * @returns The clipboard text when a reader succeeds, plus an error message
 *          describing why paste failed when it did not.
 */
export async function readFromClipboard(
  opts?: { spawn?: SpawnLike; env?: Record<string, string | undefined> },
): Promise<{ success: boolean; text?: string; error?: string }> {
  const spawnImpl = opts?.spawn ?? spawn;
  const env = opts?.env ?? process.env;
  const errors: string[] = [];

  // Run a single candidate, capturing its stdout and exit status. Never
  // throws — a missing binary or spawn error resolves as a failed attempt so
  // the next candidate is tried.
  const run = (cmd: string, args: string[]): Promise<{ code: number | null; out: string; error?: Error }> =>
    new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let cp: ChildProcess;
      try {
        cp = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err: any) {
        resolve({ code: null, out: '', error: err });
        return;
      }
      cp.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      cp.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      // Bound the wait so a hung reader never wedges the input path.
      const timer = setTimeout(() => {
        try { cp.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2000);
      cp.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve({ code: null, out: stdout, error: err });
      });
      cp.on('close', (code: number) => {
        clearTimeout(timer);
        resolve({ code, out: stdout, error: stderr ? new Error(stderr) : undefined });
      });
    });

  const plat = process.platform;
  try {
    if (plat === 'darwin') {
      const res = await run('pbpaste', []);
      if (res.code === 0 && res.out) return { success: true, text: res.out };
      errors.push(res.error?.message || 'pbpaste failed');
    } else if (plat === 'win32') {
      const res = await run('powershell', [
        '-NoProfile',
        '-Command',
        'Get-Clipboard',
      ]);
      if (res.code === 0 && res.out) return { success: true, text: res.out };
      errors.push(res.error?.message || 'Get-Clipboard failed');
    } else {
      // Linux / other.
      let ok = false;
      if (env.WAYLAND_DISPLAY) {
        const wl = await run('wl-paste', []);
        if (wl.code === 0 && wl.out) { return { success: true, text: wl.out }; }
        errors.push(wl.error?.message || 'wl-paste failed');
      }
      if (!ok) {
        if (env.DISPLAY || env.WAYLAND_DISPLAY) {
          const xclip = await run('xclip', ['-o', '-selection', 'clipboard']);
          if (xclip.code === 0 && xclip.out) { return { success: true, text: xclip.out }; }
          errors.push(xclip.error?.message || 'xclip -o failed');
        }
        const xsel = await run('xsel', ['--clipboard', '--output']);
        if (xsel.code === 0 && xsel.out) { return { success: true, text: xsel.out }; }
        errors.push(xsel.error?.message || 'xsel --output failed');
      }
    }

    if (errors.length === 0) {
      errors.push('no clipboard reader available (install pbpaste, wl-paste, xclip, or xsel)');
    }
    return { success: false, error: errors.join('; ') };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Write text to the OS clipboard.
 *
 * Thin herdr-local wrapper around the platform-tool copy strategy (no tmux
 * branch). We cannot reuse the root CLI `src/clipboard.ts` here because the
 * herdr package is an independent TS project; this mirrors the platform-tool
 * portion of that strategy so `Ctrl+X` can copy field text to the OS
 * clipboard from within the form.
 *
 * @returns `{ success: true }` when at least one method succeeds, otherwise
 *          `{ success: false, error }`.
 */
export async function writeToClipboard(
  text: string,
  opts?: { spawn?: SpawnLike; env?: Record<string, string | undefined> },
): Promise<{ success: boolean; error?: string }> {
  const spawnImpl = opts?.spawn ?? spawn;
  const env = opts?.env ?? process.env;
  let success = false;
  const errors: string[] = [];

  const run = (cmd: string, args: string[]): Promise<{ code: number | null; error?: Error }> =>
    new Promise((resolve) => {
      let cp: ChildProcess;
      try {
        cp = spawnImpl(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      } catch (err: any) {
        resolve({ code: null, error: err });
        return;
      }
      let handled = false;
      cp.on('error', (err: Error) => {
        if (handled) return;
        handled = true;
        resolve({ code: null, error: err });
      });
      cp.on('close', (code: number) => {
        if (handled) return;
        handled = true;
        resolve({ code });
      });
      try {
        cp.stdin?.write(String(text));
        cp.stdin?.end();
      } catch (err: any) {
        if (!handled) {
          handled = true;
          resolve({ code: null, error: err });
        }
      }
    });

  const plat = process.platform;
  if (plat === 'darwin') {
    const res = await run('pbcopy', []);
    success = res.code === 0;
    if (!success) errors.push(res.error?.message || 'pbcopy failed');
  } else if (plat === 'win32') {
    const res = await run('cmd', ['/c', 'clip']);
    success = res.code === 0;
    if (!success) errors.push(res.error?.message || 'clip failed');
  } else {
    let ok = false;
    if (env.WAYLAND_DISPLAY) {
      const wl = await run('wl-copy', []);
      if (wl.code === 0) { ok = true; }
      else errors.push(wl.error?.message || 'wl-copy failed');
    }
    if (!ok) {
      const xclip = await run('xclip', ['-selection', 'clipboard']);
      if (xclip.code === 0) { ok = true; }
      else errors.push(xclip.error?.message || 'xclip failed');
    }
    if (!ok) {
      const xsel = await run('xsel', ['--clipboard', '--input']);
      if (xsel.code === 0) { ok = true; }
      else errors.push(xsel.error?.message || 'xsel failed');
    }
    success = ok;
  }

  if (success) return { success: true };
  return { success: false, error: errors.join('; ') || 'no clipboard method available' };
}
