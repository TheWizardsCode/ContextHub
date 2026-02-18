import { runInProcess } from '../tests/cli/cli-inproc.js';

(async () => {
  try {
    console.log('\n=== Creating completed item ===');
    const createRes = await runInProcess('node src/cli.ts --json create -t "Done item" -s completed --stage "done"', 15000);
    console.log('CREATE:', JSON.stringify(createRes, null, 2));
    const id = (() => { try { return JSON.parse(createRes.stdout).workItem.id; } catch { return null; } })();
    console.log('Created id:', id);
    console.log('\n=== Attempting update to incompatible stage ===');
    const updateRes = await runInProcess(`node src/cli.ts --json update ${id} --stage idea`, 15000);
    console.log('UPDATE:', JSON.stringify(updateRes, null, 2));
  } catch (err: any) {
    console.error('Error running inproc:', err && err.stack ? err.stack : String(err));
    process.exit(2);
  }
})();
