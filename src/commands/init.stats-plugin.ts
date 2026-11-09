/**
 * init stats-plugin — example stats-plugin installation for `wl init`.
 *
 * Single responsibility: provision the packaged example stats plugin at
 * `<worklog-dir>/plugins/stats-plugin.mjs`, honouring the operator's overwrite
 * choice so an existing plugin is never silently clobbered.
 *
 * Dependency direction: `init.content.ts` (content normalisation),
 * `init.paths.ts` (template location), `init.prompts.ts` (overwrite
 * confirmation) and `../worklog-paths.js` (worklog directory). This module
 * never imports `init.ts` or `init.register.ts` at runtime
 * (WL-0MW0KDX260087BWP AC4).
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveWorklogDir } from '../worklog-paths.js';
import { normalizeContent } from './init.content.js';
import { locateExampleStatsPlugin } from './init.paths.js';
import { promptYesNo } from './init.prompts.js';

export async function ensureStatsPluginInstalled(options: { silent: boolean; overwrite?: boolean }) {
  const templatePath = locateExampleStatsPlugin();
  if (!templatePath) return { installed: false, skipped: true, reason: 'template not found', templatePath: null, destinationPath: null };

  const worklogDir = resolveWorklogDir();
  const pluginsDir = path.join(worklogDir, 'plugins');
  const destinationPath = path.join(pluginsDir, 'stats-plugin.mjs');

  try {
    const templateContent = normalizeContent(fs.readFileSync(templatePath, 'utf-8'));
    if (fs.existsSync(destinationPath)) {
      const existingContent = normalizeContent(fs.readFileSync(destinationPath, 'utf-8'));
      const already = existingContent === templateContent;
      if (already) return { installed: false, skipped: true, reason: 'already in place', templatePath, destinationPath };
      if (options.overwrite === false) return { installed: false, skipped: true, reason: 'user declined', templatePath, destinationPath };
      if (options.overwrite !== true) {
        if (options.silent) return { installed: false, skipped: true, reason: 'confirmation required', templatePath, destinationPath };

        const answer = await promptYesNo('A stats plugin already exists at .worklog/plugins/stats-plugin.mjs. Overwrite? (y/N): ');
        if (!answer) return { installed: false, skipped: true, reason: 'user declined', templatePath, destinationPath };
      }
    }

    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(destinationPath, `${templateContent}\n`, { encoding: 'utf-8' });
    return { installed: true, skipped: false, templatePath, destinationPath };
  } catch (e) {
    return { installed: false, skipped: true, reason: (e as Error).message, templatePath, destinationPath };
  }
}
