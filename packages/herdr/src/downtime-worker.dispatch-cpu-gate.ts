/**
 * packages/herdr/src/downtime-worker.dispatch-cpu-gate.ts — the host-CPU
 * dispatch gate (WL-0MVK0UO3Q002TXW6).
 *
 * Single responsibility: read the host-utilisation seam and decide whether
 * this dispatch tick is CPU-saturated, plus the evidence fields a refusal
 * carries. Pure evaluation — which tiers a saturated tick pauses is the
 * dispatcher's decision, not this module's.
 *
 * Parent: WL-0MVF3F9A7000HKP7 (decompose the `downtime-worker.ts` god class).
 * Moved verbatim out of `downtime-worker.ts` by WL-0MVLII0NO007JJBA (extract
 * the downtime-worker dispatch pipeline) and re-exported from the barrel.
 * No behaviour change.
 *
 * The gate reads the structural CPU seam ({@link HostCpuGateDeps}) rather than
 * the barrel's `DowntimeWorkerDeps`: an extracted module must not import the
 * barrel, not even type-only (the split guard's cycle gate — see
 * `downtime-worker.dispatch-contract.ts`).
 */

import {
  DEFAULT_DOWNTIME_CPU_GATE_PERCENT,
  clampDowntimeCpuGatePercent,
  isCpuGateActive,
  type HostCpuReading,
  type HostCpuSource,
} from './host-cpu.js';

/**
 * The dispatch-facing slice of `DowntimeWorkerDeps` this gate reads — the
 * optional host-CPU reader. Callers keep passing the full deps object.
 */
export interface HostCpuGateDeps {
  /** Host-CPU reading for the gate (see `DowntimeWorkerDeps.readHostCpu`). */
  readHostCpu?(): HostCpuReading;
}

// ── Host-CPU dispatch gate (WL-0MVK0UO3Q002TXW6) ──────────────────────

/**
 * Distinct, NEUTRAL no-dispatch reason for the host-CPU gate
 * (WL-0MVK0UO3Q002TXW6 AC4). It is never a CLI-error strike, never enters the
 * `no-candidate` cooldown, never removes a coordination entry and is
 * deliberately NOT a capacity refusal (see `capacity-starvation.ts`).
 */
export const CPU_SATURATED_REASON = 'cpu-saturated';

/**
 * Read the host-CPU seam, FAIL-OPEN (AC1/AC2): an unwired dep, a thrown
 * reader, a malformed reading (`NaN`, out-of-range percent, unknown source)
 * all resolve `{ ok: false }` — the gate then cannot evaluate and dispatch
 * proceeds unchanged. Never throws.
 */
export function readHostCpuReading(deps: HostCpuGateDeps): HostCpuReading {
  if (typeof deps.readHostCpu !== 'function') return { ok: false };
  let raw: unknown;
  try {
    raw = deps.readHostCpu();
  } catch {
    return { ok: false };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const reading = raw as { ok?: unknown; percent?: unknown; source?: unknown };
  if (reading.ok !== true) return { ok: false };
  if (typeof reading.percent !== 'number' || !Number.isFinite(reading.percent)) return { ok: false };
  if (reading.percent < 0 || reading.percent > 100) return { ok: false };
  if (reading.source !== 'proc-stat' && reading.source !== 'loadavg') return { ok: false };
  return { ok: true, percent: reading.percent, source: reading.source };
}

/**
 * Resolve the CPU-gate state for one dispatch tick: the live threshold
 * (clamped, `0` disables) plus the measured reading.
 *
 * `saturated` is true only when the reading is usable AND the threshold is
 * positive AND `percent >= threshold` (AC2 boundary: equal blocks). Fail-open
 * on every unusable reading (AC1/constraints).
 */
export function resolveCpuGate(
  deps: HostCpuGateDeps,
  cpuGatePercent: number | undefined,
): { saturated: boolean; thresholdPercent: number; reading: HostCpuReading } {
  const thresholdPercent = clampDowntimeCpuGatePercent(
    cpuGatePercent ?? DEFAULT_DOWNTIME_CPU_GATE_PERCENT,
  );
  const reading = readHostCpuReading(deps);
  const saturated = reading.ok && isCpuGateActive(reading.percent, thresholdPercent);
  return { saturated, thresholdPercent, reading };
}

/**
 * CPU-gate evidence copied onto a dispatch outcome / decision entry (AC4):
 * the measured utilisation, its source and the configured threshold. Empty
 * when the gate is inactive or the reading is unusable, so a non-CPU refusal
 * keeps its existing log shape byte-for-byte.
 */
export interface HostCpuGateEvidence {
  hostCpuPercent?: number;
  hostCpuSource?: HostCpuSource;
  cpuGatePercent?: number;
}

/** Build the evidence fields for one resolved gate (empty when not gated). */
export function hostCpuGateEvidence(
  gate: { saturated: boolean; thresholdPercent: number; reading: HostCpuReading },
): HostCpuGateEvidence {
  if (!gate.saturated || !gate.reading.ok) return {};
  return {
    hostCpuPercent: gate.reading.percent,
    hostCpuSource: gate.reading.source,
    cpuGatePercent: gate.thresholdPercent,
  };
}
