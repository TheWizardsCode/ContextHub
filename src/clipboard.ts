import { spawn } from 'child_process';

export type SpawnLike = (...args: any[]) => any;

export async function copyToClipboard(text: string, opts?: { spawn?: SpawnLike }): Promise<{ success: boolean; error?: string }> {
  const spawnImpl = opts?.spawn ?? spawn;

  const run = (cmd: string, args: string[]) => new Promise<{ code: number | null; error?: Error }>((resolve) => {
    try {
      const cp = spawnImpl(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      let handled = false;
      cp.on('error', (err: Error) => { if (!handled) { handled = true; resolve({ code: null, error: err }); } });
      cp.on('close', (code: number) => { if (!handled) { handled = true; resolve({ code }); } });
      try { cp.stdin.write(String(text)); cp.stdin.end(); } catch (_) {}
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

    // Linux / other: try xclip then xsel
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
