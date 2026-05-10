import { spawnSync } from 'child_process';

export interface PagerOptions {
  noPager?: boolean;
  forcePager?: boolean;
  pager?: string | null;
}

/**
 * Write text to stdout or pipe it through a pager when appropriate.
 * - Respects noPager flag
 * - Only uses pager in interactive TTYs
 * - Respects $PAGER or uses `less -R` fallback
 * - Falls back to plain stdout if pager fails
 */
export default function pageOutput(text: string, opts?: PagerOptions): void {
  const noPager = Boolean(opts?.noPager);
  const forcePager = Boolean(opts?.forcePager);

  if (noPager) {
    process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
    return;
  }

  if (!process.stdout.isTTY) {
    // Non-interactive: just print
    process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
    return;
  }

  const terminalRows = (process.stdout as any).rows || 24;
  const lines = text.split(/\r?\n/).length;

  if (!forcePager && lines <= terminalRows) {
    process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
    return;
  }

  const pagerCmd = opts?.pager ?? process.env.PAGER ?? 'less -R';

  try {
    // Use shell so the pagerCmd can include flags (e.g., 'less -R')
    const res = spawnSync(pagerCmd, { input: text, stdio: ['pipe', 'inherit', 'inherit'], shell: true, encoding: 'utf8' });
    if (res.error || res.status !== 0) {
      // Pager failed: fall back to printing
      process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
    }
  } catch (_err) {
    process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
  }
}
