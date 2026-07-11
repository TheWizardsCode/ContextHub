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
