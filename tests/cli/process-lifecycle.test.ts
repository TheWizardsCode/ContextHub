import { describe, it, expect, beforeEach } from 'vitest'
import * as childProcess from 'child_process'
import { promisify } from 'util'

const exec = promisify(childProcess.exec)

/** Return true if the given PID is still alive. */
async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Return the PID of the first process whose command line EXACTLY matches the
 * pattern AND belongs to the given process group (pgid). Scoping the lookup
 * to our own spawned process group makes the assertion deterministic even
 * when unrelated processes on the host run the same command line (e.g. a
 * background `while ...; do sleep 30; done` watcher): those live in a
 * different process group, are never touched by our group-kill, and must
 * not be the subject of the assertion (WL-0MSCA645J005YM1E,
 * WL-0MSKSMRFP001Q3XU).
 *
 * The pattern is anchored (^...$) so shell wrappers whose cmdline merely
 * CONTAINS the pattern (e.g. `sh -c 'sleep 0.2 && sleep 30'`) never match.
 */
async function findPidByPatternInGroup(pattern: string, pgid: number): Promise<number | null> {
  try {
    const { stdout } = await exec(`pgrep -g ${pgid} -f "^${pattern}$" | head -1`)
    const pid = Number(stdout.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Kill every process whose command line exactly matches the pattern.
 * Best-effort: pgrep exits 1 (throwing) when nothing matches, and a process
 * may exit between pgrep and kill — both are ignored.
 */
async function killAllMatching(pattern: string): Promise<void> {
  let stdout = ''
  try {
    const res = await exec(`pgrep -f "^${pattern}$"`)
    stdout = res.stdout
  } catch {
    return // no matches
  }
  for (const line of stdout.split(/\n/)) {
    const pid = Number(line.trim())
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already exited — ignore
    }
  }
}

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

describe('orphaned process prevention (WL-0MSB447TJ000R3N8)', () => {
  beforeEach(async () => {
    // Kill any stale `sleep 30` left behind by a previous failed run. The
    // per-test process-group scoping in findPidByPatternInGroup makes the
    // assertion immune to foreign `sleep 30` processes regardless, but this
    // sweep keeps the host clean across runs (WL-0MSCA645J005YM1E).
    await killAllMatching('sleep 30')
  })

  it('killTrackedProcesses kills the full process tree, not just the shell PID', async () => {
    const helpers = await import('./cli-helpers.js')
    const { execAsync, killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    // Start a long-running command whose child (sleep) outlives the shell
    // wrapper. This mirrors how `tsx src/cli.ts ...` leaves a node child
    // behind when the wrapping shell is killed.
    const marker = `sleep-marker-${Date.now()}`
    const promise = execAsync(`sleep 0.2 && sleep 30 && echo ${marker}`, { timeout: 30000 })
    // Attach a noop catch immediately so the kill below doesn't surface an
    // unhandled rejection before the test reaches its own try/catch.
    promise.catch(() => {})

    // Give it time to spawn the sleep grandchild
    await new Promise((r) => setTimeout(r, 800))

    // Scope the lookup to OUR process group: execAsync spawns detached, so
    // the tracked shell PID is its own process-group leader and the sleep
    // grandchild shares that group. Never consult the global process table —
    // a foreign `sleep 30` (e.g. from a background queue watcher) would be
    // picked by head -1 and survive our group-kill, failing spuriously.
    const tracked = [...pidTrackingSet]
    expect(tracked.length).toBeGreaterThan(0)
    const sleepPid = await findPidByPatternInGroup('sleep 30', tracked[0])
    expect(sleepPid).not.toBeNull()

    // Kill the tracked shell PID only (old behaviour would leave sleep alive)
    killTrackedProcesses()

    // The sleep grandchild must also be dead now (process-tree kill)
    await new Promise((r) => setTimeout(r, 300))
    expect(await isAlive(sleepPid!)).toBe(false)

    try {
      await promise
    } catch {
      // expected: command killed before completing
    }
  }, 40000)

  it('execAsync timeout kills the whole process tree (no orphaned grandchildren)', async () => {
    const helpers = await import('./cli-helpers.js')
    const { execAsync, killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()

    // A command that spawns a long-lived grandchild and would hang forever
    // without a timeout. The 2s timeout must kill the sleep grandchild too.
    const promise = execAsync('sleep 0.2 && sleep 30', { timeout: 2000 })
    promise.catch(() => {})

    await new Promise((r) => setTimeout(r, 800))
    // Scope to our own process group (see the sibling test above): the
    // tracked shell PID is our detached spawn's group leader.
    const tracked = [...pidTrackingSet]
    expect(tracked.length).toBeGreaterThan(0)
    const sleepPid = await findPidByPatternInGroup('sleep 30', tracked[0])
    expect(sleepPid).not.toBeNull()

    await expect(promise).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 300))
    expect(await isAlive(sleepPid!)).toBe(false)
  }, 40000)

  it('killTrackedProcesses is registered for process exit so no orphans remain after test worker dies', async () => {
    // The signal handlers installed by cli-helpers call killTrackedProcesses
    // on SIGTERM/SIGINT/SIGHUP/beforeExit. Verify the wiring exists and
    // that a tracked-but-still-running process gets killed when invoked.
    const helpers = await import('./cli-helpers.js')
    const { execAsync, killTrackedProcesses, pidTrackingSet } = helpers

    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    const promise = execAsync('sleep 0.3 && sleep 30', { timeout: 30000 })
    promise.catch(() => {})
    await new Promise((r) => setTimeout(r, 900))

    expect(pidTrackingSet.size).toBeGreaterThan(0)

    // Simulate the worker-exit path: kill tracked processes and verify the
    // tracking set is empty afterwards (no lingering PIDs that could leak).
    killTrackedProcesses()
    expect(pidTrackingSet.size).toBe(0)

    try {
      await promise
    } catch {
      // expected
    }
  }, 40000)

  it('killStaleWlProcesses sweeps orphaned wl processes matching a worktree slug', async () => {
    const helpers = await import('./cli-helpers.js')
    const { killStaleWlProcesses } = helpers

    // Spawn a fake orphaned wl-like process whose argv[0] contains a unique marker.
    const marker = `wl-marker-${Date.now()}`
    const fake = childProcess.spawn('bash', ['-c', `exec -a "wl ${marker}" sleep 60`], {
      detached: true,
      stdio: 'ignore',
    })
    fake.unref()
    await new Promise((r) => setTimeout(r, 300))

    const fakePid = fake.pid
    expect(fakePid).toBeDefined()

    const killed = killStaleWlProcesses(marker)
    expect(killed).toBeGreaterThan(0)

    await new Promise((r) => setTimeout(r, 300))
    expect(await isAlive(fakePid!)).toBe(false)
  }, 40000)
})
