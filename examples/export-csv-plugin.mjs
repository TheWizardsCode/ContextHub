/**
 * Example Plugin: CSV Export
 * 
 * This plugin demonstrates:
 * - Exporting data to different formats
 * - File system operations
 * - CSV generation with proper escaping
 * 
 * Installation:
 * Copy this file to .worklog/plugins/export-csv.mjs
 */

import * as fs from 'fs';

export default function register(ctx) {
  ctx.program
    .command('export-csv')
    .description('Export work items to CSV')
    .option('-f, --file <file>', 'Output file', 'workitems.csv')
    .option('--prefix <prefix>', 'Override prefix')
    .action((options) => {
      ctx.utils.requireInitialized();
      const db = ctx.utils.getDatabase(options.prefix);
      const items = db.getAll();
      
      // Generate CSV
      const headers = ['ID', 'Title', 'Status', 'Priority', 'Created', 'Updated'];
      const rows = items.map(item => [
        item.id,
        `"${item.title.replace(/"/g, '""')}"`,
        item.status,
        item.priority,
        item.createdAt,
        item.updatedAt
      ]);
      
      const csv = [
        headers.join(','),
        ...rows.map(row => row.join(','))
      ].join('\n');
      
      fs.writeFileSync(options.file, csv);
      
      ctx.output.success(
        `Exported ${items.length} items to ${options.file}`,
        { success: true, count: items.length, file: options.file }
      );
    });
}
