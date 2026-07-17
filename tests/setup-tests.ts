import * as path from 'path'
import * as fs from 'fs'

// Prepend tests/cli/mock-bin to PATH so child_process.spawn/exec pick up the
// test-local git mock. This runs once before the test suite (configured in
// vitest.config.ts).
try {
  const projectRoot = path.resolve(__dirname, '..')
  const mockBin = path.join(projectRoot, 'tests', 'cli', 'mock-bin')
  if (fs.existsSync(mockBin)) {
    const cur = process.env.PATH || ''
    // Put mockBin at the front so it's preferred over system git
    process.env.PATH = `${mockBin}${path.delimiter}${cur}`
  }
} catch (e) {
  // ignore failures during setup
}

// Install graceful shutdown handlers that clean up orphaned mock processes.
// These complement the handlers already installed by cli-helpers.ts.
// Using lazy import to avoid circular dependency at module load time;
// the actual handlers run only when signals fire or process exits.
import('./cli/cli-helpers.js').then(({ killTrackedProcesses, pidTrackingSet }) => {
  const cleanup = () => {
    if (pidTrackingSet.size > 0) {
      killTrackedProcesses()
    }
  }
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGHUP', cleanup)
  process.on('beforeExit', cleanup)
}).catch(() => {
  // If cli-helpers can't be loaded (e.g., non-test context), skip handlers
})
