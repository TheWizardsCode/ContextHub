// Small test-only helpers for deterministic timing and network stubbing.
// These are intentionally minimal and opt-in: tests must explicitly import
// them from `tests/test-helpers.js`.

export function makeDeterministicClock(initial = 0) {
  let t = initial;
  return {
    now() {
      return t;
    },
    advance(ms) {
      t += Number(ms) || 0;
    },
  };
}

/**
 * makeNetworkStub({ throttler, attempts, failAttempts, result })
 *
 * Returns an async function suitable for mocking a network helper that performs
 * internal retries. Each internal attempt is scheduled through the provided
 * throttler to match real helper behaviour.
 *
 * - throttler: the shared throttler instance used in tests
 * - attempts: total number of internal attempts (default 3)
 * - failAttempts: number of initial attempts that should fail (default 2)
 * - result: either a value or a function returning the success value
 */
export function makeNetworkStub(throttler, { attempts = 3, failAttempts = 2, result = {} } = {}) {
  return async function networkStub() {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await throttler.schedule(async () => {
          if (attempt <= failAttempts) {
            const err = new Error('API rate limit exceeded');
            // preserve shape used by some tests
            err.stdout = '';
            err.stderr = '403 rate limit';
            throw err;
          }
          return typeof result === 'function' ? result() : result;
        });
        return res;
      } catch (err) {
        if (attempt === attempts) throw err;
        // small non-blocking pause to simulate backoff without slowing tests
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    throw new Error('makeNetworkStub: unexpected');
  };
}

export function withScheduleSpy(throttler) {
  const orig = throttler.schedule;
  const calls = [];
  function spy(fn) {
    calls.push(fn);
    return orig.call(throttler, fn);
  }
  return {
    attach() {
      throttler.schedule = spy;
    },
    detach() {
      throttler.schedule = orig;
    },
    calls,
  };
}
