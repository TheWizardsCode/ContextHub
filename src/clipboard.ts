import { spawn } from 'child_process';

export type SpawnLike = (...args: any[]) => any;

export async function copyToClipboard(text: string, opts?: { spawn?: SpawnLike }): Promise<{ success: boolean; error?: string }> {
  const spawnImpl = opts?.spawn ?? spawn;

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
        // If write succeeds but end() fails, the process may still receive
        // data and close normally. If write itself fails, ensure we still
        // signal EOF so the process can exit and the close event fires.
        try { cp.stdin.end(); } catch (_) {}
        // If the promise hasn't been resolved yet by close/error events,
        // resolve with the write error so callers know something went wrong.
        if (!handled) { handled = true; resolve({ code: null, error: writeErr instanceof Error ? writeErr : new Error(String(writeErr)) }); }
      }
    } catch (err: any) {
      resolve({ code: null, error: err });
    }
  });

  try {
    const plat = process.platform;
    if (plat === 'darwin') {
      const res = await run('pbcopy', []);
      if (res.code === 0) return { success: true };
      return { success: false, error: res.error?.message || 'pbcopy failed' };
    }

    if (plat === 'win32') {
      const res = await run('cmd', ['/c', 'clip']);
      if (res.code === 0) return { success: true };
      return { success: false, error: res.error?.message || 'clip failed' };
    }

    // Linux / other: try wl-copy first on Wayland, then xclip, then xsel
    if (process.env.WAYLAND_DISPLAY) {
      const wlcopy = await run('wl-copy', []);
      if (wlcopy.code === 0) return { success: true };
    }
    const xclip = await run('xclip', ['-selection', 'clipboard']);
    if (xclip.code === 0) return { success: true };
    const xsel = await run('xsel', ['--clipboard', '--input']);
    if (xsel.code === 0) return { success: true };

    // Prefer reporting command error messages if present
    const errMsg = xclip.error?.message || xsel.error?.message || 'clipboard command not available (install xclip or xsel)';
    return { success: false, error: errMsg };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
