/**
 * Init command - Initialize worklog configuration
 */

import type { PluginContext } from '../plugin-types.js';
import type { InitOptions } from '../cli-types.js';
import { initConfig, loadConfig, configExists, isInitialized, readInitSemaphore, writeInitSemaphore, type InitConfigOptions } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import { theme } from '../theme.js';
import {
  DEFAULT_COMMITTED_HOOKS_DIR,
  WORKFLOW_DESTINATION_FILENAME,
} from './init.constants.js';
import {
  ensureAgentTemplateInstalled,
  resolveAgentDestination,
} from './init.agent-template.js';
import { normalizeContent } from './init.content.js';
import { ensureGitignore } from './init.gitignore.js';
import {
  installCommittedHooks,
  installPostPullHooks,
  installPrePushHook,
} from './init.hooks.js';
import {
  normalizeInitOptions,
  type NormalizedInitOptions,
} from './init.options.js';
import {
  locateAgentTemplate,
  locateWorkflowTemplate,
  resolveProjectRoot,
} from './init.paths.js';
import { ensureScheduledPromptsInstalled } from './init.scheduled-prompts.js';
import { ensureStatsPluginInstalled } from './init.stats-plugin.js';
import { isSorraAgentsInstalled } from './init.sorra-agents.js';
import { performInitSync } from './init.sync.js';
import {
  ensureWorkflowTemplateInstalled,
  insertWorkflowLoaderIntoAgents,
  promptWorkflowChoice,
} from './init.workflow.js';

export { isSorraAgentsInstalled };

export default function register(ctx: PluginContext): void {
  const { program, version, dataPath, output } = ctx;
  
  program
    .command('init')
    .description('Initialize worklog configuration (delegates agent-guidance/workflow setup to the SorraAgents global install when detected)')
    .option('--project-name <name>', 'Project name')
    .option('--prefix <prefix>', 'Issue ID prefix (e.g., WI, PROJ, TASK)')
    .option('--auto-export <yes|no>', 'Auto-export data to JSONL after changes')
    .option('--auto-sync <yes|no>', 'Auto-sync data to git after changes')
    .option('--agents-template <overwrite|append|skip>', 'What to do when AGENTS.md exists (append inserts the global-agents reference above existing content; omit to prompt)')
    .option('--workflow-inline <yes|no>', 'Inline workflow into AGENTS.md when prompted (omit to prompt interactively; no-op when SorraAgents global install is detected)')
    .option('--stats-plugin-overwrite <yes|no>', 'Overwrite existing stats plugin if present (default: no)')
    .action(async (_options: InitOptions) => {
      const argv = process.argv;
      const isJsonMode = program.opts().json || argv.includes('--json');
      const isVerbose = program.opts().verbose === true || argv.includes('--verbose');
      const workflowInlineProvided = argv.includes('--workflow-inline');
      const sorraAgentsDetected = isSorraAgentsInstalled();
      let normalizedOptions: NormalizedInitOptions;
      try {
        normalizedOptions = normalizeInitOptions(_options);
      } catch (error) {
        const message = (error as Error).message;
        if (isJsonMode) {
          output.json({ success: false, error: message });
        } else {
          console.error(`Error: ${message}`);
        }
        process.exit(1);
        return;
      }
      
      if (configExists()) {
        if (!isInitialized()) {
          writeInitSemaphore(version);
        }
        
        const config = loadConfig();
        const initInfo = readInitSemaphore();
        
        if (isJsonMode) {
          const gitignoreResult = ensureGitignore({ silent: true });
          const hookResult = installPrePushHook({ silent: true });
          const postPullResult = installPostPullHooks({ silent: true });
          const committedHooksResult = installCommittedHooks({ silent: true });
          const agentTemplatePath = locateAgentTemplate();
          if (!agentTemplatePath && isVerbose && !isJsonMode) {
            console.log('Verbose: AGENTS template not found, skipping AGENTS.md update.');
          }
          const agentTemplateResult = await ensureAgentTemplateInstalled({ silent: true, action: normalizedOptions.agentsTemplateAction ?? 'skip' });
          const workflowTemplatePath = locateWorkflowTemplate();
          const workflowInlineAnswer = normalizedOptions.workflowInline ?? false;
          if (!workflowTemplatePath && isVerbose && !isJsonMode) {
            console.log('Verbose: workflow template not found, skipping workflow integration.');
          }
          if (workflowTemplatePath && !sorraAgentsDetected) {
            const projectRoot = resolveProjectRoot();
            const agentDestination = resolveAgentDestination(projectRoot);
            if (fs.existsSync(agentDestination)) {
              const agentContent = fs.readFileSync(agentDestination, 'utf-8');
              if (!agentContent.includes('<!-- WORKFLOW: start -->') && workflowInlineAnswer) {
                await ensureWorkflowTemplateInstalled({ silent: true, agentDestinationPath: agentDestination });
              }
            } else if (workflowInlineAnswer) {
              await ensureWorkflowTemplateInstalled({ silent: true, agentDestinationPath: agentDestination });
            }
          }
          const statsPluginResult = await ensureStatsPluginInstalled({ silent: true, overwrite: normalizedOptions.statsPluginOverwrite });
          const scheduledPromptsResult = ensureScheduledPromptsInstalled({ silent: true });
          output.json({
            success: true,
            message: 'Configuration already exists',
            sorraAgentsDetected,
            config: {
              projectName: config?.projectName,
              prefix: config?.prefix
            },
            version: initInfo?.version || version,
            initializedAt: initInfo?.initializedAt,
            gitignore: gitignoreResult,
            gitHook: hookResult,
            postPullHooks: postPullResult,
            committedHooks: committedHooksResult,
            agentTemplate: agentTemplateResult,
            statsPlugin: statsPluginResult,
            scheduledPrompts: scheduledPromptsResult
          });
          return;
        } else {
          try {
            const updatedConfig = await initConfig(config, {
              projectName: normalizedOptions.projectName,
              prefix: normalizedOptions.prefix,
              autoSync: normalizedOptions.autoSync,
            } satisfies InitConfigOptions);
            writeInitSemaphore(version);
            
             console.log('\n' + theme.text.heading('## Git Sync') + '\n');
            console.log('Syncing database...');
            
            try {
              await performInitSync(dataPath, updatedConfig?.prefix, false);
            } catch (syncError) {
              console.log('\nSync failed (this is OK for new projects without remote data)');
              console.log(`  ${(syncError as Error).message}`);
            }

             console.log('\n' + theme.text.heading('## Gitignore') + '\n');
            const gitignoreResult = ensureGitignore({ silent: false });
            if (gitignoreResult.updated) {
              console.log(`.gitignore updated at ${gitignoreResult.gitignorePath} (added ${gitignoreResult.added?.length || 0} entries)`);
            } else if (gitignoreResult.present) {
              console.log('.gitignore is already up-to-date');
            } else {
              if (gitignoreResult.reason) {
                console.log(`.gitignore not updated: ${gitignoreResult.reason}`);
              } else {
                console.log('.gitignore: no changes required');
              }
            }

             console.log('\n' + theme.text.heading('## Git Hooks') + '\n');
            const hookResult = installPrePushHook({ silent: false });
            // Try to install post-pull hooks too, but don't fail init if they can't be installed
            const postPullResult = installPostPullHooks({ silent: true });
            // Also write a committed hooks directory (.githooks) the user may enable
            const committedHooksResult = installCommittedHooks({ silent: true });
            if (hookResult.present) {
              // Use consistent phrasing with post-pull hooks
              if (hookResult.hookPath) {
                console.log(`Git pre-push hook: installed at ${hookResult.hookPath}`);
              } else {
                console.log('Git pre-push hook: present');
              }
            } else {
              console.log('Git pre-push hook: not present');
            }
            if (!hookResult.installed && hookResult.reason && hookResult.reason !== 'hook already installed') {
              console.log(`\ngit pre-push hook not installed: ${hookResult.reason}`);
            }
            if (postPullResult && postPullResult.installed) {
              // Prefer to show the central script path when available
              if ((postPullResult as any).centralScriptPath) {
                console.log(`Git post-pull hooks: installed (central script at ${(postPullResult as any).centralScriptPath})`);
              } else {
                console.log(`Git post-pull hooks: installed at ${postPullResult.hookPaths?.join(', ')}`);
              }
            } else if (postPullResult && postPullResult.skipped) {
              // don't spam the user when we silently skipped
            } else if (postPullResult && postPullResult.reason) {
              console.log(`Git post-pull hooks: not installed: ${postPullResult.reason}`);
            }

            if (committedHooksResult && committedHooksResult.installed) {
              console.log(`Git committed hooks: written to ${committedHooksResult.dirPath}. To enable run: git config core.hooksPath ${DEFAULT_COMMITTED_HOOKS_DIR}`);
            } else if (committedHooksResult && committedHooksResult.skipped && committedHooksResult.reason) {
              // skip quietly
            }

             console.log('\n' + theme.text.heading('## Agent Template') + '\n');
            const agentTemplatePath = locateAgentTemplate();
            if (!agentTemplatePath && isVerbose) {
              console.log('Verbose: AGENTS template not found, skipping AGENTS.md update.');
            }
            const agentTemplateResult = await ensureAgentTemplateInstalled({
              silent: false,
              action: normalizedOptions.agentsTemplateAction
            });
            if (!agentTemplateResult.installed && agentTemplateResult.reason === 'global reference already present') {
              console.log('AGENTS.md already contains the global-agents reference.');
            }
            if (!agentTemplateResult.installed && agentTemplateResult.reason && agentTemplateResult.reason !== 'global reference already present') {
              console.log(`Note: AGENTS template not installed: ${agentTemplateResult.reason}`);
            }
            console.log('');
            // Offer workflow integration after AGENTS.md handling
            const workflowTemplatePath = locateWorkflowTemplate();
            if (!workflowTemplatePath && isVerbose) {
              console.log('Verbose: workflow template not found, skipping workflow integration.');
            }
            if (workflowTemplatePath) {
              if (sorraAgentsDetected) {
                // When SorraAgents is installed, workflow setup is delegated to
                // the canonical global install.  Report that fact and skip all
                // workflow-inline prompts.  The --workflow-inline flag is a
                // no-op in this path.
                console.log('Workflow setup is delegated to the SorraAgents global install (global AGENTS.md is managed externally).');
              } else {
                const projectRoot = resolveProjectRoot();
                const agentDestination = resolveAgentDestination(projectRoot);

                if (fs.existsSync(agentDestination)) {
                  const agentContent = fs.readFileSync(agentDestination, 'utf-8');
                  // If loader already present, note it and still offer to install WORKFLOW.md
                  if (agentContent.includes('<!-- WORKFLOW: start -->')) {
                    // If loader present, report and do not prompt.
                    console.log('Workflow already inlined in AGENTS.md.');
                    // Report status of WORKFLOW.md (installed / exists but differs / missing) without prompting
                    try {
                      const projectRootCheck = resolveProjectRoot();
                      const wfDest = path.join(projectRootCheck, WORKFLOW_DESTINATION_FILENAME);
                      if (fs.existsSync(wfDest)) {
                        const existingWf = normalizeContent(fs.readFileSync(wfDest, 'utf-8'));
                        const templateWf = normalizeContent(fs.readFileSync(workflowTemplatePath, 'utf-8'));
                        if (existingWf.includes(templateWf)) {
                          // WORKFLOW.md already matches template — loader presence already communicates this intent, skip duplicate line
                        } else {

                        }
                      } else {

                      }
                    } catch (e) {

                    }
                  } else {
                    // Loader missing: offer to insert loader and install WORKFLOW.md
                    const choice = await promptWorkflowChoice(
                      workflowInlineProvided ? normalizedOptions.workflowInline : undefined
                    );
                    if (choice === 'basic') {
                      await ensureWorkflowTemplateInstalled({ silent: false, agentDestinationPath: agentDestination });
                      insertWorkflowLoaderIntoAgents(agentDestination);
                    } else {
                      // user skipped — do not add summary lines
                    }
                  }
                } else {
                  // No AGENTS.md present: offer to install only WORKFLOW.md
                  const choice = await promptWorkflowChoice(
                    workflowInlineProvided ? normalizedOptions.workflowInline : undefined
                  );
                  if (choice === 'basic') {
                    await ensureWorkflowTemplateInstalled({ silent: false, agentDestinationPath: agentDestination });
                  } else {
                    // user skipped — no summary
                  }
                }

                // We no longer print a workflowReport summary; helpers print output
              }
            }
            // (note: reporting already emitted above)
            // Offer to install example stats plugin
             console.log('\n' + theme.text.heading('## Install plugins') + '\n');
            const statsPluginResult = await ensureStatsPluginInstalled({ silent: false, overwrite: normalizedOptions.statsPluginOverwrite });
            if (statsPluginResult.installed) {
              console.log(`✓ Installed example stats plugin at ${statsPluginResult.destinationPath}`);
            } else if (statsPluginResult.skipped && statsPluginResult.reason === 'already in place') {
              console.log('Stats plugin already present.');
            } else if (statsPluginResult.skipped && statsPluginResult.reason === 'user declined') {
              console.log('Stats plugin installation skipped by user.');
            } else if (statsPluginResult.skipped && statsPluginResult.reason) {
              console.log(`Stats plugin: ${statsPluginResult.reason}`);
            }

            // Summary of actions
             console.log('\n\n' + theme.text.heading('## Summary') + '\n');
            // gitignore
            if (gitignoreResult.updated) {
              console.log(' - .gitignore: updated');
            } else if (gitignoreResult.present) {
              console.log(' - .gitignore: present (no changes)');
            } else {
              console.log(` - .gitignore: not updated${gitignoreResult.reason ? `: ${gitignoreResult.reason}` : ''}`);
            }
            // pre-push hook
            if (hookResult.installed) {
              console.log(' - Git pre-push hook: installed');
            } else if (hookResult.skipped && hookResult.present) {
              console.log(' - Git pre-push hook: present (not modified)');
            } else {
              console.log(` - Git pre-push hook: not installed${hookResult.reason ? `: ${hookResult.reason}` : ''}`);
            }
            // post-pull hooks
            if (postPullResult && (postPullResult as any).installed) {
              console.log(' - Git post-pull hooks: installed');
            } else if (postPullResult && (postPullResult as any).skipped) {
              console.log(' - Git post-pull hooks: skipped');
            } else if (postPullResult && (postPullResult as any).reason) {
              console.log(` - Git post-pull hooks: not installed: ${(postPullResult as any).reason}`);
            }
            // committed hooks
            if (committedHooksResult && committedHooksResult.installed) {
              console.log(' - Git committed hooks: written');
            } else if (committedHooksResult && committedHooksResult.skipped) {
              console.log(' - Git committed hooks: skipped');
            }
            // agent template
            if (agentTemplateResult.installed) {
              console.log(' - AGENTS.md: installed');
            } else if (agentTemplateResult.skipped && agentTemplateResult.reason === 'global reference already present') {
              console.log(' - AGENTS.md: global reference already present');
            } else if (agentTemplateResult.skipped) {
              console.log(` - AGENTS.md: skipped${agentTemplateResult.reason ? `: ${agentTemplateResult.reason}` : ''}`);
            }
            // stats plugin
            if (statsPluginResult.installed) {
              console.log(' - Stats plugin: installed');
            } else if (statsPluginResult.skipped && statsPluginResult.reason === 'already in place') {
              console.log(' - Stats plugin: already in place');
            } else if (statsPluginResult.skipped && statsPluginResult.reason === 'user declined') {
              console.log(' - Stats plugin: skipped by user');
            } else if (statsPluginResult.skipped) {
              console.log(` - Stats plugin: skipped${statsPluginResult.reason ? `: ${statsPluginResult.reason}` : ''}`);
            }
            // scheduled prompts (WL-0MSS1Q5ER007QDKX AC1)
            const scheduledPromptsResult = ensureScheduledPromptsInstalled({ silent: true });
            if (scheduledPromptsResult.installed) {
              console.log(` - Scheduled prompts: provisioned at ${scheduledPromptsResult.destinationPath} (base set: /skill:refactor every 3 days)`);
            } else if (scheduledPromptsResult.skipped && scheduledPromptsResult.reason === 'already in place') {
              console.log(' - Scheduled prompts: already in place (not overwritten)');
            } else if (scheduledPromptsResult.skipped) {
              console.log(` - Scheduled prompts: skipped${scheduledPromptsResult.reason ? `: ${scheduledPromptsResult.reason}` : ''}`);
            }

            console.log('\nNote: `wl init` is idempotent and can safely be run again if any options need to be changed.');
            return;
          } catch (error) {
            output.error('Error: ' + (error as Error).message, { success: false, error: (error as Error).message });
            process.exit(1);
          }
        }
      }
      
      try {
        await initConfig(undefined, {
          projectName: normalizedOptions.projectName,
          prefix: normalizedOptions.prefix,
          autoSync: normalizedOptions.autoSync,
        } satisfies InitConfigOptions);
        const config = loadConfig();
        writeInitSemaphore(version);
        const initInfo = readInitSemaphore();
        
        if (isJsonMode) {
          const gitignoreResult = ensureGitignore({ silent: true });
          const hookResult = installPrePushHook({ silent: true });
          const postPullResult = installPostPullHooks({ silent: true });
          const committedHooksResult = installCommittedHooks({ silent: true });
          const agentTemplatePath = locateAgentTemplate();
          if (!agentTemplatePath && isVerbose && !isJsonMode) {
            console.log('Verbose: AGENTS template not found, skipping AGENTS.md update.');
          }
          const agentTemplateResult = await ensureAgentTemplateInstalled({ silent: true, action: normalizedOptions.agentsTemplateAction ?? 'skip' });
          const workflowTemplatePath = locateWorkflowTemplate();
          const workflowInlineAnswer = normalizedOptions.workflowInline ?? false;
          if (!workflowTemplatePath && isVerbose && !isJsonMode) {
            console.log('Verbose: workflow template not found, skipping workflow integration.');
          }
          if (workflowTemplatePath && !sorraAgentsDetected) {
            const projectRoot = resolveProjectRoot();
            const agentDestination = resolveAgentDestination(projectRoot);
            if (fs.existsSync(agentDestination)) {
              const agentContent = fs.readFileSync(agentDestination, 'utf-8');
              if (!agentContent.includes('<!-- WORKFLOW: start -->') && workflowInlineAnswer) {
                await ensureWorkflowTemplateInstalled({ silent: true, agentDestinationPath: agentDestination });
              }
            } else if (workflowInlineAnswer) {
              await ensureWorkflowTemplateInstalled({ silent: true, agentDestinationPath: agentDestination });
            }
          }
          const statsPluginResult = await ensureStatsPluginInstalled({ silent: true, overwrite: normalizedOptions.statsPluginOverwrite });
          const scheduledPromptsResult = ensureScheduledPromptsInstalled({ silent: true });
          output.json({
            success: true,
            message: 'Configuration initialized',
            sorraAgentsDetected,
            config: {
              projectName: config?.projectName,
              prefix: config?.prefix
            },
            version: version,
            initializedAt: initInfo?.initializedAt,
            gitignore: gitignoreResult,
            gitHook: hookResult,
            postPullHooks: postPullResult,
            committedHooks: committedHooksResult,
            agentTemplate: agentTemplateResult,
            statsPlugin: statsPluginResult,
            scheduledPrompts: scheduledPromptsResult
          });
        }
        
        if (!isJsonMode) {
          console.log('\n' + theme.text.heading('## Git Sync') + '\n');
          console.log('Syncing database...');
        }
        
        try {
          await performInitSync(dataPath, config?.prefix, isJsonMode);
        } catch (syncError) {
          if (isJsonMode) {
            const outputData: any = {
              success: true,
              message: 'Configuration initialized',
              sorraAgentsDetected,
              config: {
                projectName: config?.projectName,
                prefix: config?.prefix
              },
              syncWarning: {
                message: 'Sync failed (this is OK for new projects without remote data)',
                error: (syncError as Error).message
              }
            };
            output.json(outputData);
          } else {
            console.log('\nSync failed (this is OK for new projects without remote data)');
            console.log(`  ${(syncError as Error).message}`);
          }
        }

          if (!isJsonMode) {
            console.log('\n' + theme.text.heading('## Gitignore') + '\n');
            const gitignoreResult = ensureGitignore({ silent: false });
            if (gitignoreResult.updated) {
              console.log(`.gitignore updated at ${gitignoreResult.gitignorePath} (added ${gitignoreResult.added?.length || 0} entries)`);
            } else if (gitignoreResult.present) {
              console.log('.gitignore is already up-to-date');
            } else {
              if (gitignoreResult.reason) {
                console.log(`.gitignore not updated: ${gitignoreResult.reason}`);
              } else {
                console.log('.gitignore: no changes required');
              }
            }

          console.log('\n' + theme.text.heading('## Git Hooks') + '\n');
            const hookResult = installPrePushHook({ silent: false });
            const postPullResult = installPostPullHooks({ silent: true });
            const committedHooksResult = installCommittedHooks({ silent: true });
            if (hookResult.present) {
              if (hookResult.hookPath) {
                console.log(`Git pre-push hook: installed at ${hookResult.hookPath}`);
              } else {
                console.log('Git pre-push hook: present');
              }
            } else {
              console.log('Git pre-push hook: not present');
            }
            if (!hookResult.installed && hookResult.reason && hookResult.reason !== 'hook already installed') {
              console.log(`\ngit pre-push hook not installed: ${hookResult.reason}`);
            }
            if (postPullResult && postPullResult.installed) {
              console.log(`Git post-pull hooks: installed at ${postPullResult.hookPaths?.join(', ')}`);
            } else if (postPullResult && postPullResult.skipped) {
              // ok
            } else if (postPullResult && postPullResult.reason) {
              console.log(`Git post-pull hooks: not installed: ${postPullResult.reason}`);
            }

            if (committedHooksResult && committedHooksResult.installed) {
              console.log(`Git committed hooks: written to ${committedHooksResult.dirPath}. To enable run: git config core.hooksPath ${DEFAULT_COMMITTED_HOOKS_DIR}`);
            }

          console.log('\n' + theme.text.heading('## Agent Template') + '\n');
          const agentTemplateResult = await ensureAgentTemplateInstalled({ silent: false, action: normalizedOptions.agentsTemplateAction });
          if (!agentTemplateResult.templatePath && isVerbose) {
            console.log('Verbose: AGENTS template not found, skipping AGENTS.md update.');
          }
          // Offer workflow integration after AGENTS.md handling
          const workflowTemplatePath = locateWorkflowTemplate();
          if (!workflowTemplatePath && isVerbose) {
            console.log('Verbose: workflow template not found, skipping workflow integration.');
          }
          if (workflowTemplatePath) {
            if (sorraAgentsDetected) {
              // When SorraAgents is installed, workflow setup is delegated to
              // the canonical global install.  Report that fact and skip all
              // workflow-inline prompts.  The --workflow-inline flag is a
              // no-op in this path.
              console.log('Workflow setup is delegated to the SorraAgents global install (global AGENTS.md is managed externally).');
            } else {
              const projectRoot = resolveProjectRoot();
              const agentDestination = resolveAgentDestination(projectRoot);

              if (fs.existsSync(agentDestination)) {
                const agentContent = fs.readFileSync(agentDestination, 'utf-8');
                // If loader already present, note it and still offer to install WORKFLOW.md
                if (agentContent.includes('<!-- WORKFLOW: start -->')) {
                  // If loader present, report and do not prompt.
                  console.log('Workflow already inlined in AGENTS.md.');
                  // Report status of WORKFLOW.md (installed / exists but differs / missing) without prompting
                  try {
                    const projectRootCheck = resolveProjectRoot();
                    const wfDest = path.join(projectRootCheck, WORKFLOW_DESTINATION_FILENAME);
                    if (fs.existsSync(wfDest)) {
                      const existingWf = normalizeContent(fs.readFileSync(wfDest, 'utf-8'));
                      const templateWf = normalizeContent(fs.readFileSync(workflowTemplatePath, 'utf-8'));
                      if (existingWf.includes(templateWf)) {
                        // WORKFLOW.md already matches template — loader presence already communicates this intent, skip duplicate line
                      } else {

                      }
                    } else {

                    }
                  } catch (e) {

                  }
                } else {
                  // Loader missing: offer to insert loader and install WORKFLOW.md
                  const choice = await promptWorkflowChoice(
                    workflowInlineProvided ? normalizedOptions.workflowInline : undefined
                  );
                  if (choice === 'basic') {
                    await ensureWorkflowTemplateInstalled({ silent: false, agentDestinationPath: agentDestination });
                    insertWorkflowLoaderIntoAgents(agentDestination);
                  } else {
                    // user skipped — no summary output
                  }
                }
              } else {
                // No AGENTS.md present: offer to install only WORKFLOW.md
                const choice = await promptWorkflowChoice(
                  workflowInlineProvided ? normalizedOptions.workflowInline : undefined
                );
                if (choice === 'basic') {
                  await ensureWorkflowTemplateInstalled({ silent: false });
                } else {
                  // user skipped — no summary output
                }
              }

              // We no longer print a workflowReport summary; helpers print output
            }
          }

          if (!agentTemplateResult.installed && agentTemplateResult.reason === 'global reference already present') {
            console.log('AGENTS.md already contains the global-agents reference.');
          }
          if (!agentTemplateResult.installed && agentTemplateResult.reason && agentTemplateResult.reason !== 'global reference already present') {
            console.log(`Note: AGENTS template not installed: ${agentTemplateResult.reason}`);
          }
          // Offer to install example stats plugin
          console.log('\n' + theme.text.heading('## Install plugins') + '\n');
          const statsPluginResult = await ensureStatsPluginInstalled({ silent: false, overwrite: normalizedOptions.statsPluginOverwrite });
          if (statsPluginResult.installed) {
            console.log(`✓ Installed example stats plugin at ${statsPluginResult.destinationPath}`);
          } else if (statsPluginResult.skipped && statsPluginResult.reason === 'already in place') {
            console.log('Stats plugin already present.');
          } else if (statsPluginResult.skipped && statsPluginResult.reason === 'user declined') {
            console.log('Stats plugin installation skipped by user.');
          } else if (statsPluginResult.skipped && statsPluginResult.reason) {
            console.log(`Stats plugin: ${statsPluginResult.reason}`);
          }

          // Scheduled-prompts provisioning (WL-0MSS1Q5ER007QDKX AC1):
          // create-if-absent — never clobber user edits or lastTriggeredAt
          // state on re-init.
          const scheduledPromptsResult = ensureScheduledPromptsInstalled({ silent: false });
          if (scheduledPromptsResult.installed) {
            console.log(`✓ Provisioned scheduled prompts at ${scheduledPromptsResult.destinationPath} (base set: /skill:refactor every 3 days)`);
          } else if (scheduledPromptsResult.skipped && scheduledPromptsResult.reason === 'already in place') {
            console.log('Scheduled prompts config already present (not overwritten).');
          } else if (scheduledPromptsResult.skipped && scheduledPromptsResult.reason) {
            console.log(`Scheduled prompts: ${scheduledPromptsResult.reason}`);
          }
        }
      } catch (error) {
        output.error('Error: ' + (error as Error).message, { success: false, error: (error as Error).message });
        process.exit(1);
      }
    });
}
