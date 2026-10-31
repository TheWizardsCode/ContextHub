import { vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'

// ── Global child_process mock ──
// A single vi.mock registration prevents module cache conflicts. The factory
// uses importOriginal() to preserve all real exports and creates mock
// functions that delegate to the real implementations by default.
// Test files that need to override spawn/execSync/spawnSync can call
// mockSpawn.mockImplementation(...) on the shared mocks.
import { initChildProcessMocks } from './child-process-mocks.js'
const store = initChildProcessMocks()
const { mockSpawn, mockExecSync, mockSpawnSync, mockExecFile } = store

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal()
  store.realExecFile = actual.execFile
  return {
    ...actual,
    // By default delegate to real implementation so CLI tests work.
    // Test files that need to mock call mockSpawn.mockImplementation(...).
    spawn: mockSpawn.mockImplementation(actual.spawn),
    execSync: mockExecSync.mockImplementation(actual.execSync),
    spawnSync: mockSpawnSync.mockImplementation(actual.spawnSync),
    execFile: mockExecFile.mockImplementation(actual.execFile),
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal()
  if (!store.realExecFile) store.realExecFile = actual.execFile
  return {
    ...actual,
    spawn: mockSpawn.mockImplementation(actual.spawn),
    execSync: mockExecSync.mockImplementation(actual.execSync),
    spawnSync: mockSpawnSync.mockImplementation(actual.spawnSync),
    execFile: mockExecFile.mockImplementation(actual.execFile),
  }
})

// ── Hermetic git environment for the whole suite (WL-0MVVWRPRO006IQ61) ──
// A caller can export a repository-override variable that git honours over the
// working directory. `implement.py finish` in particular exports GIT_INDEX_FILE
// (a temporary index) while it validates the would-be-commit tree: any fixture
// that then runs `git add`/`git commit` stages into THAT index instead of its
// own throwaway repository, corrupting the enclosing gate's evidence ("the
// temporary index changed while the suite ran") and then failing itself with
// "invalid object ... / Error building trees". Fixtures must be hermetic, so the
// override variables are removed once, before any test file runs; cwd alone
// then decides the repository, exactly as in a normal run. Tests that exercise
// an override set it explicitly themselves and are unaffected.
for (const name of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
]) {
  delete process.env[name]
}

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
