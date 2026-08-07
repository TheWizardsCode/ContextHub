import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Resolve the truly-real child_process via createRequire. The vitest global
// setup (tests/setup-tests.ts) mocks `child_process` (spawn/execSync/etc.);
// promisifying the mocked execFile breaks callback-arity detection and
// returns undefined stdout/stderr. This test drives the mock-bin scripts and
// needs the real 4-arity execFile.
const realChildProcess = createRequire(import.meta.url)('child_process')
const execFile = promisify(realChildProcess.execFile)

const mockBinDir = path.join(__dirname, 'mock-bin')
const gitMockPath = path.join(mockBinDir, 'git')
const ghMockPath = path.join(mockBinDir, 'gh')
const wlMockPath = path.join(mockBinDir, 'wl')

describe('mock-bin/git timeout guard', () => {
  it('exits normally when timeout is not triggered', async () => {
    // Running `git --help` should complete within the timeout
    const result = await execFile(gitMockPath, ['--help'], {
      env: { ...process.env, WORKLOG_MOCK_TIMEOUT: '5' },
      timeout: 10000,
    })
    expect(result.stderr).toBe('')
    // The fallback case prints args
    expect(result.stdout).toContain('git (mock): --help')
  }, 15000)

  it('does not trip the timeout guard during normal execution', async () => {
    // Regression for the flake that motivated this suite: a NORMAL rev-parse
    // under full-suite parallel load must never exceed the guard's budget and
    // self-terminate (exit 124). Use a generous WORKLOG_MOCK_TIMEOUT so bash
    // startup slowness alone can never trip the guard.
    const result = await execFile(gitMockPath, ['rev-parse', '--show-toplevel'], {
      env: { ...process.env, WORKLOG_MOCK_TIMEOUT: '30' },
      timeout: 10000,
    })
    // A normal rev-parse resolves (execFile does not reject) and prints the
    // repo root to stdout with nothing on stderr.
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().length).toBeGreaterThan(0)
  }, 15000)

  it('self-terminates when execution exceeds the configured timeout', async () => {
    // WORKLOG_MOCK_TIMEOUT=0 means every execution exceeds the configured
    // budget instantly, so the bash dispatch guard self-terminates with exit
    // code 124 before the mock performs any work. This deterministically
    // verifies the guard's self-termination contract without depending on
    // machine load (a 1s budget flaked under full-suite parallel load).
    let captured: any = null
    try {
      await execFile(gitMockPath, ['--help'], {
        env: { ...process.env, WORKLOG_MOCK_TIMEOUT: '0' },
        timeout: 10000,
      })
    } catch (e: any) {
      captured = e
    }
    expect(captured).toBeTruthy()
    expect(captured.code).toBe(124) // 124 = guard self-termination exit code
  }, 15000)

  it('supports WORKLOG_MOCK_TIMEOUT environment variable with custom value', async () => {
    // Set a very short timeout (0.5s) and run a command that should complete quickly
    const result = await execFile(gitMockPath, ['init'], {
      env: { ...process.env, WORKLOG_MOCK_TIMEOUT: '1' },
      timeout: 10000,
    })
    expect(result.stdout).toContain('Initialized mock git repo')
  }, 15000)

  it('defaults to 5 seconds when WORKLOG_MOCK_TIMEOUT is not set', async () => {
    // Run a normal operation without the env var
    const result = await execFile(gitMockPath, ['--help'], {
      env: { ...process.env },
      timeout: 15000,
    })
    expect(result.stdout).toContain('git (mock): --help')
  }, 20000)
})

describe('mock-bin/gh timeout guard', () => {
  it('exits normally when timeout is not triggered', async () => {
    // Running `gh issue list` without seed data should complete quickly
    const result = await execFile(ghMockPath, ['issue', 'list'], {
      env: { ...process.env, WORKLOG_MOCK_TIMEOUT: '5' },
      timeout: 10000,
    })
    // Should complete without error
    expect(result.status).not.toBe(124)
  }, 15000)

  it('handles the timeout guard without breaking existing functionality', async () => {
    // No seed file -> "Issues were not found" stderr, exit 1
    let captured: any = null
    try {
      await execFile(ghMockPath, ['issue', 'view', '1'], {
        env: { ...process.env, WORKLOG_MOCK_TIMEOUT: '5' },
        timeout: 10000,
      })
    } catch (e: any) {
      captured = e
    }
    expect(captured).toBeTruthy()
    expect(captured.stderr).toContain('Issues were not found')
  }, 15000)
})

describe('mock-bin/wl timeout guard', () => {
  it('exits normally when timeout is not triggered', async () => {
    const result = await execFile('node', [wlMockPath, 'list'], {
      env: { ...process.env, WORKLOG_MOCK_TIMEOUT: '5' },
      timeout: 10000,
    })
    expect(result.stdout).toContain('WL-')
  }, 15000)

  it('exits when timeout is set very short and operation would be delayed', async () => {
    // The wl mock is simple and always completes quickly - this validates
    // the timeout mechanism doesn't interfere with normal operations
    const result = await execFile('node', [wlMockPath, 'list', '--json'], {
      env: { ...process.env, WORKLOG_MOCK_TIMEOUT: '1' },
      timeout: 10000,
    })
    const parsed = JSON.parse(result.stdout)
    expect(Array.isArray(parsed)).toBe(true)
  }, 15000)
})
