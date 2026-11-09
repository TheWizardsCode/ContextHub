/**
 * init sorra-agents — SorraAgents global-install detection for `wl init`.
 *
 * Single responsibility: detect whether the SorraAgents global install is
 * present by inspecting the `~/.pi/agent/AGENTS.md` symlink.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Detect whether the SorraAgents global install is present.  The canonical
 * indicator is `~/.pi/agent/AGENTS.md` being a symlink whose resolved
 * target file name is `AGENTS_GLOBAL.md` (regardless of the symlink
 * target path).  This is the same convention used by
 * `scripts/install_pi.sh`.
 *
 * Environment variable `WL_SORRA_AGENTS_OVERRIDE` can be set to `0` or `1`
 * to force the result for testing purposes.  Any other value (including
 * unset) falls through to filesystem detection.
 */
export function isSorraAgentsInstalled(): boolean {
  const envOverride = process.env.WL_SORRA_AGENTS_OVERRIDE;
  if (envOverride === '1') return true;
  if (envOverride === '0') return false;
  const homeDir = os.homedir();
  const agentsMdPath = path.join(homeDir, '.pi', 'agent', 'AGENTS.md');
  try {
    const stat = fs.lstatSync(agentsMdPath);
    if (!stat.isSymbolicLink()) return false;
    const target = fs.readlinkSync(agentsMdPath);
    // Resolve relative symlinks against the directory containing the link.
    const resolved = path.isAbsolute(target)
      ? target
      : path.resolve(path.dirname(agentsMdPath), target);
    return path.basename(resolved) === 'AGENTS_GLOBAL.md';
  } catch {
    return false;
  }
}
