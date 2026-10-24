/**
 * local-preference — pi client extension entry point
 * (WL-0MVLJTV03000KIQZ, parent WL-0MVIKRFP0005JDL8 AC4, slice C4).
 *
 * Wires the per-turn local-preference hooks:
 *   - sends `X-Local-Preference` on every proxied request, taken from the
 *     pane-launch env var `HERDR_LOCAL_PREFERENCE` herdr sets per spawn;
 *   - parses `X-Local-Route` / `X-Local-Fallback-Reason` from responses and
 *     appends one bounded JSONL line per response to
 *     `<cwd>/.worklog/local-route.log` (session id + reservation ticket
 *     included, so a dispatcher decision correlates with its turns).
 *
 * Fail-open: with no knob set (an interactive pane, or an older herdr) the
 * extension injects no header and writes no log — requests and behaviour are
 * byte-identical to today. The implementation lives in
 * `local-preference.ts` (pi-import-free apart from types, unit tested in
 * `local-preference.test.ts`).
 *
 * Loaded through the Worklog pi-extension package
 * (`packages/tui/extensions/package.json` → `pi.extensions`), installed as
 * the global `~/.pi/agent/extensions/worklog` symlink by
 * `scripts/install-pi-extension.sh`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerLocalPreference } from './local-preference.js';

export default function registerLocalPreferenceExtension(pi: ExtensionAPI): void {
  registerLocalPreference(pi);
}
