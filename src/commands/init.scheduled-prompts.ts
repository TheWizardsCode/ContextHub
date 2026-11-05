/**
 * init scheduled-prompts — create-if-absent provisioning of
 * `<worklog-dir>/scheduled-prompts.json` for `wl init`.
 *
 * Single responsibility: copy the packaged scheduled-prompts template into the
 * worklog directory on first init, never clobbering an existing file (user
 * edits or runtime `lastTriggeredAt` state).
 *
 * Dependency direction: `init.paths.ts` (template location) and
 * `init.constants.ts` (destination filename) only. This module never imports
 * `init.ts` at runtime (WL-0MW0KDRAS000V2RL AC4).
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveWorklogDir } from '../worklog-paths.js';
import { SCHEDULED_PROMPTS_DESTINATION_FILENAME } from './init.constants.js';
import { locateScheduledPromptsTemplate } from './init.paths.js';

/**
 * Provision the scheduled-prompts config (WL-0MSS1Q5ER007QDKX AC1): copy
 * templates/scheduled-prompts.json into `<worklog-dir>/scheduled-prompts.json`
 * CREATE-IF-ABSENT — an existing file (user edits or runtime lastTriggeredAt
 * state) is never clobbered. A missing template is skipped (never fatal).
 */
export function ensureScheduledPromptsInstalled(options: {
  silent: boolean;
}): { installed: boolean; skipped: boolean; destinationPath?: string; reason?: string } {
  const templatePath = locateScheduledPromptsTemplate();
  if (!templatePath) {
    return { installed: false, skipped: true, reason: 'scheduled-prompts template not found' };
  }
  const worklogDir = resolveWorklogDir();
  const destinationPath = path.join(worklogDir, SCHEDULED_PROMPTS_DESTINATION_FILENAME);
  try {
    if (fs.existsSync(destinationPath)) {
      // Create-if-absent: never clobber user edits or lastTriggeredAt state.
      return { installed: false, skipped: true, reason: 'already in place', destinationPath };
    }
    fs.mkdirSync(worklogDir, { recursive: true });
    fs.copyFileSync(templatePath, destinationPath);
    if (!options.silent) {
      console.log(`✓ Provisioned scheduled prompts at ${destinationPath}`);
    }
    return { installed: true, skipped: false, destinationPath };
  } catch (e) {
    return { installed: false, skipped: true, reason: (e as Error).message, destinationPath };
  }
}
