/**
 * packages/herdr/src/index.host-cpu.ts — the single owner of the
 * module-level host-CPU sampler used by the downtime worker's CPU gate.
 *
 * Extracted verbatim from `packages/herdr/src/index.ts` (move-only,
 * WL-0MVOA0U84003EXVK, parent WL-0MVGKGFFN009UCM6): the whitelisted
 * `/proc` metrics paths, the fail-open metrics reader, the in-memory
 * sampler and its test seam.
 *
 * Singleton singularity (AC5): `defaultHostCpuSampler` and
 * `hostCpuSamplerOverride` are module-scope state that lives in exactly this
 * module — never duplicated across modules. `setHostCpuSamplerForTests` is
 * the only way to override the sampler (consumed by `index.test.ts` through
 * the barrel); {@link readHostCpu} is the single internal read path
 * `createDowntimeDeps` wires into the worker, so state and reader live
 * together. Imports are `node:fs`, `node:os` and the concrete sibling
 * `./host-cpu.js`; no barrel value imports, no new cycles.
 */

import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { createHostCpuSampler, type HostCpuReading } from './host-cpu.js';

/**
 * Whitelisted absolute host-metrics paths (never caller-supplied, so the
 * sampler cannot be pointed at an arbitrary file).
 */
const HOST_PROC_STAT_PATH = '/proc/stat';
const HOST_PROC_LOADAVG_PATH = '/proc/loadavg';

/**
 * Read a host-metrics file, resolving `null` on ANY failure (missing file,
 * permissions, a restricted `/proc` in a container). Fail-open by design.
 */
function readHostMetricsFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Module-level host-CPU sampler (WL-0MVK0UO3Q002TXW6): holds the previous
 * `/proc/stat` sample IN MEMORY only (no disk state, no machine-wide marker),
 * so the delta across the worker's poll interval measures host utilisation.
 * A worker restart simply re-seeds via the load-average fallback on the first
 * tick. `os.cpus()` is read lazily per reading so a hot-plugged core count is
 * honoured.
 */
const defaultHostCpuSampler = createHostCpuSampler({
  readProcStat: () => readHostMetricsFile(HOST_PROC_STAT_PATH),
  readLoadAvg: () => readHostMetricsFile(HOST_PROC_LOADAVG_PATH),
  cpuCount: () => cpus().length,
});

/**
 * Test seam for the module-level host-CPU sampler (WL-0MVK0UO3Q002TXW6 AC6:
 * "tests must never read the real `/proc/stat`"). Production never calls the
 * setter; `null` restores the real `/proc` sampler.
 */
let hostCpuSamplerOverride: (() => HostCpuReading) | null = null;

/**
 * Replace the host-CPU sampler that {@link createDowntimeDeps} exposes as
 * `readHostCpu`. Intended for tests only — the gate is pinned with fixture
 * readings rather than the host's current load.
 *
 * @param sampler - The fixture sampler, or `null` to restore production.
 */
export function setHostCpuSamplerForTests(
  sampler: (() => HostCpuReading) | null,
): void {
  hostCpuSamplerOverride = sampler;
}

/**
 * Sample the host CPU through the module-level sampler
 * (WL-0MVK0UO3Q002TXW6): the installed test override when present,
 * otherwise the real `/proc/stat` sampler. `createDowntimeDeps` (still in
 * the barrel) wires this as the worker's `readHostCpu`, keeping the
 * sampler state and its only reader in this one module (AC5).
 *
 * @returns The current host-CPU reading (fail-open: `{ ok: false }` when
 *   `/proc` is unreadable).
 */
export function readHostCpu(): HostCpuReading {
  return (hostCpuSamplerOverride ?? defaultHostCpuSampler)();
}
