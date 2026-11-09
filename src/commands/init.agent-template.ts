/**
 * init agent-template — AGENTS.md template installation for `wl init`.
 *
 * Single responsibility: install, append to or overwrite the project
 * `AGENTS.md` from the packaged template, including the interactive
 * overwrite/append/manual prompt and its summary.
 *
 * Dependency direction: `init.constants.ts` (destination filename),
 * `init.content.ts` (content normalisation and analysis), `init.paths.ts`
 * (template location and project root) and the `init.options.ts` type only.
 * This module never imports `init.ts` or `init.register.ts` at runtime
 * (WL-0MW0KDX260087BWP AC4).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { WORKLOG_AGENT_DESTINATION_FILENAME } from './init.constants.js';
import { analyzeAgentContent, normalizeContent } from './init.content.js';
import type { AgentTemplateAction } from './init.options.js';
import { locateAgentTemplate, resolveProjectRoot } from './init.paths.js';

export function resolveAgentDestination(projectRoot: string): string {
  return path.join(projectRoot, WORKLOG_AGENT_DESTINATION_FILENAME);
}

async function promptAgentTemplateAction(): Promise<AgentTemplateAction> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const prompt =
      'AGENTS.md already exists. To use Worklog we need to ensure that agents are aware of it. You have a few options:\n\n' +
      'O - Overwrite the existing AGENTS.md\n' +
      '\tPRO: no chance of a conflict between existing AGENTS.md and the Workflow instructions\n' +
      '\tCON: DESTRUCTIVE to your existing configuration\n\n' +
      'A - Add the global-agents reference above your existing rules\n' +
      '\tPRO: retains your existing instructions and simply adds to them\n' +
      '\tCON: potentially conflicting instructions between the two files\n\n' +
      'M - Manual management, read the docs and set things up as you like\n' +
      '\tPRO: keep what you need, remove any conflicts\n' +
      '\tCON: Worklog will not be used until you do more config work\n\n' +
      'Choose Overwrite (O), Add (A) or Manual (M): ';
    rl.question(prompt, answer => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'o' || trimmed === 'overwrite') {
        resolve('overwrite');
        return;
      }
      if (trimmed === 'a' || trimmed === 'append') {
        resolve('append');
        return;
      }
      resolve('skip');
    });
  });
}

export async function ensureAgentTemplateInstalled(options: { silent: boolean; action?: AgentTemplateAction }) {
  const templatePath = locateAgentTemplate();
  if (!templatePath) {
    return { installed: false, skipped: true, reason: 'template not found', templatePath: null, destinationPath: null };
  }

  const projectRoot = resolveProjectRoot();
  const destinationPath = resolveAgentDestination(projectRoot);

  try {
    const templateContent = normalizeContent(fs.readFileSync(templatePath, 'utf-8'));
    if (fs.existsSync(destinationPath)) {
      const existingRaw = fs.readFileSync(destinationPath, 'utf-8');
      const { hasGlobalReference, trimmed: existingContent, eol, hasOnlyWhitespace } = analyzeAgentContent(existingRaw);
      if (hasGlobalReference) {
        return { installed: false, skipped: true, reason: 'global reference already present', templatePath, destinationPath };
      }
      if (options.action === 'skip') {
        return { installed: false, skipped: true, reason: 'user chose to manage manually', templatePath, destinationPath };
      }

      if (options.action === 'overwrite') {
        fs.writeFileSync(destinationPath, `${templateContent}\n`, { encoding: 'utf-8' });
        if (!options.silent) {
          console.log(`✓ Overwrote AGENTS template at ${destinationPath}`);
        }
        return { installed: true, skipped: false, templatePath, destinationPath, overwritten: true };
      }

      if (options.action === 'append') {
        // Prepend the canonical global-reference template above existing
        // content so project-specific local rules stay below the reference.
        const insertion = hasOnlyWhitespace
          ? templateContent
          : `${templateContent}${existingContent ? `${eol}${eol}${existingContent}` : ''}`;
        fs.writeFileSync(destinationPath, `${insertion}${eol}`, { encoding: 'utf-8' });
        if (!options.silent) {
          console.log(`✓ Updated AGENTS.md with global-agents reference at ${destinationPath}`);
        }
        return { installed: true, skipped: false, templatePath, destinationPath, insertedReference: true };
      }

      if (options.silent) {
        return { installed: false, skipped: true, reason: 'confirmation required', templatePath, destinationPath };
      }

      printAgentTemplateSummary();
      const resolvedAction = await promptAgentTemplateAction();
      if (resolvedAction === 'skip') {
        return { installed: false, skipped: true, reason: 'user chose to manage manually', templatePath, destinationPath };
      }

      if (resolvedAction === 'overwrite') {
        fs.writeFileSync(destinationPath, `${templateContent}\n`, { encoding: 'utf-8' });
        if (!options.silent) {
          console.log(`✓ Overwrote AGENTS template at ${destinationPath}`);
        }
        return { installed: true, skipped: false, templatePath, destinationPath, overwritten: true };
      }

      const insertion = hasOnlyWhitespace
        ? templateContent
        : `${templateContent}${existingContent ? `${eol}${eol}${existingContent}` : ''}`;
      fs.writeFileSync(destinationPath, `${insertion}${eol}`, { encoding: 'utf-8' });
      if (!options.silent) {
        console.log(`✓ Updated AGENTS.md with global-agents reference at ${destinationPath}`);
      }
      return { installed: true, skipped: false, templatePath, destinationPath, insertedReference: true };
    }

    fs.writeFileSync(destinationPath, `${templateContent}\n`, { encoding: 'utf-8' });
    if (!options.silent) {
      console.log(`✓ Installed AGENTS template at ${destinationPath}`);
    }
    return { installed: true, skipped: false, templatePath, destinationPath };
  } catch (e) {
    return { installed: false, skipped: true, reason: (e as Error).message, templatePath, destinationPath };
  }
}

function printAgentTemplateSummary(): void {
}
