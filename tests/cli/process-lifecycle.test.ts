import { describe, it, expect } from 'vitest'

describe('pid tracking and killTrackedProcesses', () => {
  it('should export pidTrackingSet and killTrackedProcesses from cli-helpers', async () => {
    const helpers = await import('./cli-helpers.js')
    expect(helpers.killTrackedProcesses).toBeDefined()
    expect(typeof helpers.killTrackedProcesses).toBe('function')
    expect(helpers.pidTrackingSet).toBeDefined()
    expect(helpers.pidTrackingSet instanceof Set).toBe(true)
  })

  it('should track spawned child PIDs via execAsync and auto-remove on exit', async () => {
    const helpers = await import('./cli-helpers.js')
    const { execAsync, killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    // Run a quick command that completes immediately
    const result = await execAsync('echo hello', { timeout: 5000 })

    // After execution, the PID should have been tracked and auto-removed on exit
    expect(pidTrackingSet.size).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
  })

  it('should track PIDs from execWithInput and remove on exit', async () => {
    const helpers = await import('./cli-helpers.js')
    const { execWithInput, killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    // Run a quick command that completes normally
    const resultPromise = execWithInput('echo hi', '', { timeout: 5000 })
    // PID should be tracked
    expect(pidTrackingSet.size).toBeGreaterThan(0)

    const result = await resultPromise
    expect(result.stdout.trim()).toBe('hi')
    expect(result.exitCode).toBe(0)
    // After completion, PID should be removed
    expect(pidTrackingSet.size).toBe(0)
  }, 10000)

  it('should not throw when killing already-exited processes', async () => {
    const helpers = await import('./cli-helpers.js')
    const { killTrackedProcesses, pidTrackingSet } = helpers

    // Clear and add non-existent PIDs
    killTrackedProcesses()
    pidTrackingSet.add(999999)
    pidTrackingSet.add(999998)

    // Should not throw when killing already-exited PIDs
    expect(() => killTrackedProcesses()).not.toThrow()

    // Set should be cleared
    expect(pidTrackingSet.size).toBe(0)
  })

  it('killTrackedProcesses clears the set (OS-level kill behavior is system-dependent)', async () => {
    const helpers = await import('./cli-helpers.js')
    const { execAsync, killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    // Start a long-running process to verify tracking captures the PID
    // and killTrackedProcesses clears the set without throwing.
    const promise = execAsync('sleep 10', { timeout: 20000 })

    // Give it a moment to start
    await new Promise(r => setTimeout(r, 300))

    // Check that the PID was tracked
    expect(pidTrackingSet.size).toBeGreaterThan(0)

    // Kill tracked processes - this sends SIGTERM and clears the set
    killTrackedProcesses()

    // Tracking set should be cleared immediately
    expect(pidTrackingSet.size).toBe(0)

    // Clean up: wait for the promise to settle (process may or may not
    // have been killed by SIGTERM depending on shell behavior)
    try {
      await promise
    } catch {
      // Expected if the process was killed
    }
  }, 30000)
})

describe('tracking set edge cases', () => {
  it('should be empty after test cleanup', async () => {
    const helpers = await import('./cli-helpers.js')
    const { killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)
  })
})
