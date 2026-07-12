import * as fs from 'fs';
import { spawn } from 'child_process';

export async function openUrlInBrowser(url: string, fsImpl: typeof fs = fs): Promise<boolean> {
  // Prefer candidates based on environment; try each until one succeeds.
  const platform = process.platform;

  const isWsl = (() => {
    try {
      if (process.env.WSL_DISTRO_NAME) return true;
      const ver = fsImpl.readFileSync('/proc/version', 'utf8');
      return /microsoft/i.test(ver);
    } catch (_) {
      return false;
    }
  })();

  const candidates: Array<{ cmd: string; args: string[] }> = [];
  if (platform === 'darwin') {
    candidates.push({ cmd: 'open', args: [url] });
  } else if (platform === 'win32') {
    candidates.push({ cmd: 'powershell.exe', args: ['Start', url] });
  } else {
    // linux-like
    if (isWsl) {
      // In WSL prefer explorer.exe first for faster launch to host browser.
      candidates.push({ cmd: 'explorer.exe', args: [url] });
      candidates.push({ cmd: 'wslview', args: [url] });
      candidates.push({ cmd: 'xdg-open', args: [url] });
    } else {
      candidates.push({ cmd: 'xdg-open', args: [url] });
    }
  }

  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const cp = spawn(candidate.cmd, candidate.args, {
          detached: true,
          stdio: 'ignore',
        });
        let settled = false;
        cp.once('error', () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        });
        cp.once('spawn', () => {
          if (!settled) {
            settled = true;
            try { cp.unref(); } catch (_) {}
            resolve(true);
          }
        });
      } catch (_) {
        resolve(false);
      }
    });
    if (ok) return true;
  }

  return false;
}

export default openUrlInBrowser;
