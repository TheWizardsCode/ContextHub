import type { PluginContext } from '../plugin-types.js';
import type { AuditOptions } from '../cli-types.js';
import { runOpencodeAudit } from '../opencode-audit.js';

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
};

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('audit <id>')
    .description('Run OpenCode audit for a work item and print the result')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (id: string, options: AuditOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;

      if (!db.get(normalizedId)) {
        output.error(`Work item not found: ${normalizedId}`, {
          success: false,
          error: `Work item not found: ${normalizedId}`,
          workItemId: normalizedId,
        });
        process.exit(1);
      }

      try {
        const result = await runOpencodeAudit({
          workItemId: normalizedId,
          cwd: process.cwd(),
        });

        if (utils.isJsonMode()) {
          output.json({
            success: true,
            workItemId: normalizedId,
            auditText: result.auditText,
            terminatedOnWait: result.terminatedOnWait,
          });
          return;
        }

        process.stdout.write(`Audit complete:\n\n${result.auditText}\n`);
      } catch (error) {
        const message = toErrorMessage(error);
        if (utils.isJsonMode()) {
          output.json({
            success: false,
            error: message,
            workItemId: normalizedId,
          });
        } else {
          console.error(`Audit failed: ${message}`);
        }
        process.exit(1);
      }
    });
}
