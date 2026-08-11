import { runPiAudit } from '../pi-audit.js';
import { theme } from '../theme.js';
const toErrorMessage = (error) => {
    if (error instanceof Error && error.message)
        return error.message;
    return String(error);
};
export default function register(ctx) {
    const { program, output, utils } = ctx;
    program
        .command('audit <id>')
        .description('Run OpenCode audit for a work item and print the result')
        .option('--prefix <prefix>', 'Override the default prefix')
        .action(async (id, options) => {
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
            const result = await runPiAudit({
                workItemId: normalizedId,
                cwd: process.cwd(),
            });
            if (utils.isJsonMode()) {
                // Provide structured parts in JSON mode so consumers can render
                // tool output separately from assistant text if desired.
                output.json({
                    success: true,
                    workItemId: normalizedId,
                    auditText: result.auditText,
                    terminatedOnWait: result.terminatedOnWait,
                    selectedMessageParts: result.selectedMessageParts ?? [],
                });
                return;
            }
            // Human output: prefer structured parts when available so we can
            // render tool results in muted color while keeping assistant text
            // in the default color. Fall back to legacy auditText when parts
            // are not provided.
            process.stdout.write('Audit complete:\n\n');
            if (result.selectedMessageParts && result.selectedMessageParts.length > 0) {
                for (const p of result.selectedMessageParts) {
                    const text = String(p.text || '');
                    // Treat any part that indicates a tool as muted (grey)
                    const partType = String(p.type || '').toLowerCase();
                    if (partType.includes('tool')) {
                        process.stdout.write(theme.text.muted(text) + '\n');
                    }
                    else {
                        process.stdout.write(text + '\n');
                    }
                }
            }
            else {
                process.stdout.write(`${result.auditText}\n`);
            }
        }
        catch (error) {
            const message = toErrorMessage(error);
            if (utils.isJsonMode()) {
                output.json({
                    success: false,
                    error: message,
                    workItemId: normalizedId,
                });
            }
            else {
                console.error(`Audit failed: ${message}`);
            }
            process.exit(1);
        }
    });
}
//# sourceMappingURL=audit.js.map