/**
 * Worklog Pi extension — thin orchestration layer.
 *
 * Registers the agent-side Pi plugin modules: activity indicator, model
 * display, session health, guardrails, skill-path tool, error recovery
 * (`/retry`), lease release, and provider request priority. The Pi-based TUI
 * browse UI (chat pane,
 * action palette, `/wl` command, `ctrl+shift+b` shortcut, scheduler,
 * auto-injection, settings overlay) has been removed — the Herdr plugin
 * covers work item browsing and management.
 *
 * This extension auto-loads into every pi session via the global extension
 * install (`~/.pi/agent/extensions/worklog` → `packages/tui/extensions`).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerActivityIndicator } from './activity-indicator.js';
import { registerModelDisplay } from './model-display.js';
import { registerSessionHealth } from './session-health.js';
import { INSTALL_GUARDRAILS } from './lib/guardrails.js';
import { registerSkillPathTool } from './lib/skill-path.js';
import { registerRecoveryModule } from './lib/recovery/register-recovery.js';
import { registerLeaseRelease } from './lease-release.js';
import { registerRequestPriority } from './request-priority.js';

export function createWorklogPiExtension() {
  return function registerWorklogPiExtension(pi: ExtensionAPI): void {
    // ── Footer chrome: activity indicator, model display, session health ──
    registerActivityIndicator(pi, () => true);
    registerModelDisplay(pi);
    registerSessionHealth(pi);

    // ── Guardrails: protect worklog database files ────────────────────
    INSTALL_GUARDRAILS(pi, { enabled: true });

    // ── Skill path discovery tool ─────────────────────────────────────
    if (typeof pi.registerTool === 'function') {
      pi.registerTool(registerSkillPathTool());
    }

    // ── Recovery module (automatic error recovery, `/retry`) ──────────
    registerRecoveryModule(pi);

    // ── Lease release (proactive proxy model lease release on /new) ────
    registerLeaseRelease(pi);

    // ── Provider request priority (herdr pane-launch env → X-Priority) ──
    // Fail-open: an unset/invalid HERDR_REQUEST_PRIORITY leaves the headers
    // untouched so the proxy applies its own `medium` default
    // (WL-0MVE1NZ4J000H5NH AC4).
    registerRequestPriority(pi);
  };
}

export default createWorklogPiExtension();
