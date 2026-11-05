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
//
// Defence-in-depth: this is the suite-wide layer only. Fixtures that hand an
// environment to their own git commands must additionally route it through the
// shared `fixtureGitEnv()` helper (tests/cli/git-helpers.ts), which scrubs the
// same list per invocation — a test that sets an override *after* this setup
// has run must still not leak it (WL-0MVWRR4GD001M9LA).
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

// ── No application or CLI-helper imports here (WL-0MW3JIYIR002RCP8) ──
//
// This setup module is evaluated once per worker BEFORE the test file. Any
// application module it reaches is therefore already in the module registry
// when that test file's hoisted `vi.mock(...)` registrations take effect, so
// the module under test keeps its REAL binding while the test asserts on the
// mock. The lazy `import('./cli/cli-helpers.js')` that used to install
// shutdown handlers here reached `src/jsonl.ts` → `src/github.ts` and raced
// the per-file mocks — intermittently breaking
// `tests/github-sync/comments-module.test.ts` (real calls through the
// `tests/cli/mock-bin/gh` stub, so the assertions saw 0 mock calls rather than
// an error). `tests/cli/cli-helpers.ts` installs the same SIGTERM/SIGINT/
// SIGHUP/beforeExit handlers itself at module load (`_installSignalHandlers`),
// and only a file that imports it ever tracks a PID, so those handlers are not
// needed here. `tests/unit/global-setup-isolation.test.ts` pins both halves of
// that contract.
