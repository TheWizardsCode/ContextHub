/**
 * Init command — thin public barrel for `wl init`.
 *
 * Concern modules (all `src/commands/init.<concern>.ts`), one responsibility
 * each — read the module whose name matches your concern:
 *
 * | Concern | Module |
 * |---|---|
 * | command registration and the init flow | `init.register.ts` |
 * | constants, filenames and markers | `init.constants.ts` |
 * | AGENTS/WORKFLOW content normalisation | `init.content.ts` |
 * | CLI option parsing and validation | `init.options.ts` |
 * | interactive yes/no prompt | `init.prompts.ts` |
 * | SorraAgents global-install detection | `init.sorra-agents.ts` |
 * | repo/project root and template location | `init.paths.ts` |
 * | `.gitignore` section provisioning | `init.gitignore.ts` |
 * | scheduled-prompts provisioning | `init.scheduled-prompts.ts` |
 * | git hook installation | `init.hooks.ts` |
 * | AGENTS.md template installation | `init.agent-template.ts` |
 * | example stats-plugin installation | `init.stats-plugin.ts` |
 * | WORKFLOW inlining into AGENTS.md | `init.workflow.ts` |
 * | one-shot init database/JSONL/git sync | `init.sync.ts` |
 *
 * Consumers (`src/command-registry.ts`, `tests/cli/cli-inproc.ts`) import this
 * barrel; no family module imports it (WL-0MW0KE2DO000IK63).
 */

export { default } from './init.register.js';
export { isSorraAgentsInstalled } from './init.sorra-agents.js';
