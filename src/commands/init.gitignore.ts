/**
 * init gitignore — `.gitignore` Worklog-section provisioning for `wl init`.
 *
 * Single responsibility: append the Worklog section from the packaged
 * `.gitignore` template to the repository's `.gitignore` (once, never
 * duplicating it) and detect an already-present section.
 *
 * Dependency direction: `init.paths.ts` (template location and repo-root
 * resolution) and `init.constants.ts` (section markers) only. This module
 * never imports `init.ts` at runtime (WL-0MW0KDRAS000V2RL AC4).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  WORKLOG_GITIGNORE_SECTION_START,
  WORKLOG_GITIGNORE_SECTION_END,
} from './init.constants.js';
import { locateGitignoreTemplate, resolveRepoRoot } from './init.paths.js';

export function ensureGitignore(options: { silent: boolean }): { updated: boolean; present: boolean; gitignorePath?: string; added?: string[]; reason?: string } {
  let gitignorePath = path.join(process.cwd(), '.gitignore');

  // Shared repo-root resolution: `resolveRepoRoot()` returns null outside a git
  // repository, matching the previous inline `git rev-parse` try/catch.
  const repoRoot = resolveRepoRoot();
  if (repoRoot) {
    gitignorePath = path.join(repoRoot, '.gitignore');
  }

  let existing = '';
  try {
    if (fs.existsSync(gitignorePath)) {
      existing = fs.readFileSync(gitignorePath, 'utf-8');
    }
  } catch (e) {
    return { updated: false, present: false, gitignorePath, reason: (e as Error).message };
  }

  if (existing && hasWorklogGitignoreSection(existing)) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, added: [] };
  }

  const templatePath = locateGitignoreTemplate();
  if (!templatePath) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, reason: 'gitignore template not found' };
  }

  let templateContent = '';
  try {
    templateContent = fs.readFileSync(templatePath, 'utf-8');
  } catch (e) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, reason: (e as Error).message };
  }

  if (!templateContent.trim()) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, reason: 'gitignore template is empty' };
  }

  const sectionLines = templateContent.split(/\r?\n/).filter(line => line.length > 0);

  let out = existing;
  if (out.length > 0 && !out.endsWith('\n')) {
    out += '\n';
  }
  if (out.length > 0 && !out.endsWith('\n\n')) {
    out += '\n';
  }
  if (!templateContent.endsWith('\n')) {
    templateContent += '\n';
  }
  out += templateContent;

  try {
    fs.writeFileSync(gitignorePath, out, { encoding: 'utf-8' });
  } catch (e) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, reason: (e as Error).message };
  }

  if (!options.silent) {
    console.log(`✓ Updated .gitignore at ${gitignorePath}`);
  }
  return { updated: true, present: true, gitignorePath, added: sectionLines };
}

export function hasWorklogGitignoreSection(content: string): boolean {
  return content.includes(WORKLOG_GITIGNORE_SECTION_START) && content.includes(WORKLOG_GITIGNORE_SECTION_END);
}
