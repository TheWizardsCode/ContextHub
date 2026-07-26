import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const mockBinDir = path.join(__dirname, 'mock-bin')

describe('process cleanup integration', () => {
  it('should track PIDs from multiple concurrent execAsync calls', async () => {
    const helpers = await import('./cli-helpers.js')
    const { execAsync, killTrackedProcesses, pidTrackingSet } = helpers

    // Clear any previous state
    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    // Run multiple echo commands concurrently - each should track and then
    // auto-remove the PID on exit
    const results = await Promise.all([
      execAsync('echo one', { timeout: 5000 }),
      execAsync('echo two', { timeout: 5000 }),
      execAsync('echo three', { timeout: 5000 }),
    ])

    // All should complete successfully
    expect(results.map(r => r.stdout.trim())).toEqual(['one', 'two', 'three'])

    // All PIDs should have been removed on exit
    expect(pidTrackingSet.size).toBe(0)
  })

  it('should track PIDs from concurrent execAsync and execWithInput calls', async () => {
    const helpers = await import('./cli-helpers.js')
    const { execAsync, execWithInput, killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    // Run a mix of execAsync and execWithInput calls
    const results = await Promise.all([
      execAsync('echo async', { timeout: 5000 }),
      execWithInput('echo with-input', '', { timeout: 5000 }),
    ])

    expect(results[0].stdout.trim()).toBe('async')
    expect(results[1].stdout.trim()).toBe('with-input')

    // All PIDs should be cleaned up
    expect(pidTrackingSet.size).toBe(0)
  })

  it('should handle cleanup after a batch of mock-bin git calls', async () => {
    const helpers = await import('./cli-helpers.js')
    const { execAsync, killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    // Run mock-bin git commands to simulate the real use case
    // We need to set PATH so git commands find the mock
    const env = { ...process.env, PATH: `${mockBinDir}:${process.env.PATH || ''}` }

    const results = await Promise.all([
      execAsync('git init', { timeout: 5000, env }),
      execAsync('git rev-parse --show-toplevel', { timeout: 5000, env }),
      execAsync('git rev-parse --is-inside-work-tree', { timeout: 5000, env }),
    ])

    // Verify all commands completed (some may have non-empty stderr due to
    // directory context, but that's OK - we're testing cleanup, not git behavior)
    expect(results.length).toBe(3)

    // All PIDs cleaned up
    expect(pidTrackingSet.size).toBe(0)
  })

  it('killTrackedProcesses can be called multiple times safely', async () => {
    const helpers = await import('./cli-helpers.js')
    const { killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    // First call should be safe (no-op since nothing is tracked)
    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    // Second call also safe
    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)
  })

  it('should run setup-tests signal handlers without error', async () => {
    // The setup-tests module registers signal handlers at import time.
    // Verify it exports killTrackedProcesses (via re-import or direct access).
    const setupTests = await import('../setup-tests.js')
    // The module may not export anything - just verify it doesn't throw
    expect(setupTests).toBeDefined()
  })
})
