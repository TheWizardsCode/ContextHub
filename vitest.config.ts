import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Increase default timeout to reduce intermittent test timeouts in CI.
    // Tests that spawn tsx subprocesses should set explicit per-test timeouts
    // (45-60s) since subprocess startup is slow under concurrent load.
    testTimeout: 30000,
    // Run setup to inject mock git into PATH for spawn-based calls
    setupFiles: ['./tests/setup-tests.ts'],
  },
})
