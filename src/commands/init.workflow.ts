/**
 * init workflow — WORKFLOW content inlining for `wl init`.
 *
 * Single responsibility: ask how the project wants to manage its agent
 * workflow and inline the Worklog WORKFLOW content into the project's
 * AGENTS.md. Deliberately never writes a standalone WORKFLOW.md into the
 * repository; declares no path resolution, no other provisioning and no
 * command wiring, and never imports `init.ts` or `init.register.ts`.
 *
 * Dependency direction: external packages, `init.constants.ts`,
 * `init.content.ts` and `init.paths.ts` only.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { WORKFLOW_DESTINATION_FILENAME } from './init.constants.js';
import { normalizeContent } from './init.content.js';
import { locateWorkflowTemplate, resolveProjectRoot } from './init.paths.js';

export type WorkflowChoice = 'none' | 'basic' | 'manual';

export async function promptWorkflowChoice(forceAnswer?: boolean): Promise<WorkflowChoice> {
  if (forceAnswer !== undefined) return forceAnswer ? 'basic' : 'none';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt =
    'Worklog is designed to support whatever workflow you wish to adopt. It is possible to use it without any formal workflow definition at all. However, many users like to define specifc actions that agents should take under specific circumstances. To that end please choose how you want manage your workflow.\n\n' +
    'N - No formal workflow, let the agents figure it out.\n' +
    '\tPRO: Worklog simply augments whatever agents you use.\n' +
    '\tCON: Very little control over how and when things occur.\n\n' +
    'B - Include a basic workflow that is Worklog aware.\n' +
    '\tPRO: Minimally invasive but prompts agents to record key information at key stages of work.\n' +
    '\tCON: Agents sill have significant freedom, some agents will all but ignore these lightweight workflow instructions.\n\n' +
    'M - Manage custom workflow by editing AGENTS.md directly.\n' +
    '\tPRO: Maximum flexibility to define the workflow that suits you best.\n' +
    '\tCON: More work to setup\n\n' +
    'Choose No workflow (N), Basic workflow (B), or Manual (M): ';
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'b' || trimmed === 'basic') return resolve('basic');
      if (trimmed === 'm' || trimmed === 'manual') return resolve('manual');
      return resolve('none');
    });
  });
}

export async function ensureWorkflowTemplateInstalled(options: { silent: boolean; agentTemplateAction?: string; agentDestinationPath?: string }) {
  // We do not write a standalone WORKFLOW.md into the repository. If an
  // agent destination path is provided, inline the workflow content into the
  // agent file. Otherwise, return a skipped result explaining that writing
  // to disk is disabled by design.
  const templatePath = locateWorkflowTemplate();
  if (!templatePath) return { installed: false, skipped: true, reason: 'workflow template not found', templatePath: null, destinationPath: null };

  const projectRoot = resolveProjectRoot();
  const repoWorkflowPath = path.join(projectRoot, WORKFLOW_DESTINATION_FILENAME);

  // If caller provided an agentDestinationPath, attempt to inline workflow
  // content into the agent file (prefer repo copy if present, otherwise packaged template).
  if (options.agentDestinationPath) {
    try {
      // insertWorkflowLoaderIntoAgents will read repo/workspace or packaged
      // template as needed and perform the insertion. It will also avoid
      // duplicating content if already present.
      const insertResult = insertWorkflowLoaderIntoAgents(options.agentDestinationPath);
      if (insertResult.inserted) {
        if (!options.silent) console.log(`✓ Inlined WORKFLOW content into ${options.agentDestinationPath}`);
        return { installed: true, skipped: false, templatePath, destinationPath: null };
      }
      // Already present is not an error — report as skipped
      if (insertResult.reason === 'already present') return { installed: false, skipped: true, reason: 'already in place', templatePath, destinationPath: null };
      return { installed: false, skipped: true, reason: insertResult.reason || 'insertion failed', templatePath, destinationPath: null };
    } catch (e) {
      return { installed: false, skipped: true, reason: (e as Error).message, templatePath, destinationPath: null };
    }
  }

  // No agent destination provided: do not create a standalone WORKFLOW.md file.
  return { installed: false, skipped: true, reason: 'not writing WORKFLOW.md to repository (inlining only)', templatePath, destinationPath: null };
}

export function insertWorkflowLoaderIntoAgents(agentPath: string) {
  try {
    if (!fs.existsSync(agentPath)) return { inserted: false, reason: 'agents file not found' };

    // Determine workflow content: prefer repository WORKFLOW.md, fall back to packaged template
    const projectRoot = resolveProjectRoot();
    const repoWorkflowPath = path.join(projectRoot, WORKFLOW_DESTINATION_FILENAME);
    let workflowContent: string | null = null;
    if (fs.existsSync(repoWorkflowPath)) {
      workflowContent = normalizeContent(fs.readFileSync(repoWorkflowPath, 'utf-8'));
    } else {
      const packaged = locateWorkflowTemplate();
      if (packaged && fs.existsSync(packaged)) {
        workflowContent = normalizeContent(fs.readFileSync(packaged, 'utf-8'));
      }
    }
    if (!workflowContent) return { inserted: false, reason: 'workflow file not found' };

    const existing = fs.readFileSync(agentPath, 'utf-8');

    // Avoid inserting twice (if the agent file already contains the workflow markers)
    if (existing.includes('<!-- WORKFLOW: start -->')) return { inserted: false, reason: 'already present' };

    const out = `<!-- WORKFLOW: start -->\n${workflowContent}\n<!-- WORKFLOW: end -->\n\n${existing}`;
    fs.writeFileSync(agentPath, out, { encoding: 'utf-8' });
    return { inserted: true, path: agentPath };
  } catch (e) {
    return { inserted: false, reason: (e as Error).message };
  }
}
