/**
 * packages/herdr/src/audit-availability.cross-host.test.ts — the CROSS-HOST
 * ACCEPTANCE PROOF for proxy-managed audit admission (WL-0MWAMSLBL001JNKO,
 * parent WL-0MW95GBEG005ERHS).
 *
 * The incident this suite prevents: two ContextHub hosts, each enforcing its
 * own `maxAudit: 1`, produced two concurrent audits on the single local GPU
 * (2026-11-03). Per-host unit tests cannot prove that is now impossible; this
 * suite drives TWO independent dispatcher admission paths against ONE shared,
 * in-process stub proxy, so a second host is refused the moment the first
 * host's live audit lease is visible on the proxy.
 *
 * ## What makes this an ACCEPTANCE proof (not another unit test)
 *
 * The per-feature suites already pin the client (`downtime-worker.
 * audit-availability.test.ts`), the parser (`…contract.test.ts`) and the
 * admission mapping (`host-dispatch-budget.*`). This file does not re-test
 * those in isolation. It composes the REAL production pieces end to end:
 *
 *   stub proxy (pinned availability contract)
 *     → real `createAuditAvailabilityClient` (bounded GET + typed outcome)
 *     → real `decideAuditAvailability` (the single pre-check/admission mapping)
 *     → real `admitHostDispatch` (proxy-derived audit admission)
 *     → real `dispatchDowntimeWork` dispatch pipeline (gates + claim + spawn).
 *
 * The only test-owned glue is the `readAuditAvailability`/`getActiveAudit`/
 * `admitHostDispatch` seam wiring — exactly the `createDowntimeDeps`-style
 * seam shape `index.ts` uses — so the scenarios exercise production decisions,
 * not a re-implementation of them.
 *
 * ## Scenario → acceptance-criterion map
 *
 *   case 1  availability-only reads BOTH admit; the ATOMIC lease arbitrates (AC1/AC4)
 *   pin     pre-change per-host caps admit BOTH hosts concurrently  (AC2)
 *   case 2  both hosts refused with one token and one evidence set  (AC3)
 *   case 3  unreachable proxy fails both hosts closed, no pane      (AC4)
 *   case 4  an expired lease is reclaimed, a live lease refuses     (AC3/AC5)
 *   case 5  the implement tier is unaffected by the audit verdict    (AC6)
 *
 * The stub is the CONTRACT RECORD (the pinned availability contract): if the
 * real proxy's shape differs, the stub and the pinned parser change together,
 * never the scenarios.
 *
 * No network access: the stub proxy is a plain injected `fetcher` (the client's
 * documented seam). The client's abort timer is cleared on every path, so the
 * suite leaves no open handles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAuditAvailabilityClient,
  type AuditAvailabilityOutcome,
} from './downtime-worker.audit-availability.js';
import {
  createAuditLeaseClient,
  auditLeaseSessionId,
  type AuditLeaseFetcher,
} from './downtime-worker.audit-lease.js';
import {
  AUDIT_BUDGET_SATURATED_REASON,
  AUDIT_BUDGET_UNKNOWN_REASON,
} from './downtime-worker.audit-availability.contract.js';
import {
  admitHostDispatch,
  decideAuditAvailability,
  type AuditBudgetLogEvent,
} from './host-dispatch-budget.admission.js';
import {
  dispatchDowntimeWork,
  type DowntimeCandidate,
  type DowntimeWorkerDeps,
} from './downtime-worker.js';
import {
  createTempDirTracker,
  jsonResponseFixture,
  makeDeps,
  type TempDirTracker,
} from './downtime-worker.fixtures.js';

// ── Shared fixtures ───────────────────────────────────────────────────

/** No environment overrides: the proxy path is active (not the legacy flag). */
const CLEAN_ENV: Readonly<Record<string, string | undefined>> = {};

/** One hour in ms, for an already-expired lease. */
const HOUR_MS = 60 * 60 * 1000;
/** The stub proxy's lease TTL (bounded; a leaked lease expires). */
const LEASE_TTL_MS = 5 * 60 * 1000;
/** The proxy's bounded retry on a saturated acquire, pinning the 429 body. */
const SATURATED_RETRY_S = 30;
/** The pinned lease/availability paths the stub proxy routes (contract record). */
const AUDIT_LEASE_PATH_PIN = '/llama/local/audit/lease';
const AUDIT_LEASE_RENEW_PATH_PIN = `${AUDIT_LEASE_PATH_PIN}/renew`;
const AUDIT_AVAILABILITY_PATH_PIN = '/llama/local/audit/availability';

/** The two fake ContextHub hosts sharing the single local GPU. */
type HostId = 'A' | 'B';

const AUDIT_ON_A: DowntimeCandidate = { id: 'WL-AUD-A', title: 'Audit on host A', stage: 'audit' };
const AUDIT_ON_B: DowntimeCandidate = { id: 'WL-AUD-B', title: 'Audit on host B', stage: 'audit' };
const IMPLEMENT_ON_HOST: DowntimeCandidate = {
  id: 'WL-IMP',
  title: 'Implement me',
  stage: 'implement',
};

// ── The in-process stub proxy (the pinned availability contract) ──────

/**
 * The proxy's served availability body, in the pinned wire shape. Only the
 * fields the contract parser accepts are used; `leases`/`reclaimed` model the
 * reclamation scenario and `reason` supplies the proxy's own refusal token.
 */
interface StubAvailabilityBody {
  cap: number;
  live: number;
  available: boolean;
  leases?: Array<{ id: string; expires_at: number }>;
  reclaimed?: number;
  reason?: string;
}

/**
 * A single in-process stub proxy shared by BOTH hosts. It serves the mutable
 * availability body through the injected `fetcher` seam, records every body it
 * serves (the contract record the lease-evidence assertions read), can be
 * closed to model an unreachable proxy, AND runs the ATOMIC audit-lease
 * registry (WL-0MWFJH3NW006F5GN): `POST /llama/local/audit/lease` grants the
 * first session and answers `429` with the pinned `retry_after_s` while a
 * DIFFERENT session holds the budget — the cross-host arbiter the scenarios
 * prove. The availability body is deliberately SERVED SEPARATELY (and can
 * therefore go stale): that is the point-in-time-observation race this suite
 * pins.
 */
function createStubProxy(initial: StubAvailabilityBody) {
  let body: StubAvailabilityBody = { ...initial };
  let unreachable = false;
  const served: StubAvailabilityBody[] = [];
  // The audit-lease registry: session id -> absolute expiry (epoch ms).
  const registry = new Map<string, number>();
  const fetcher: AuditLeaseFetcher = async (url, init) => {
    if (unreachable) {
      // A connection refusal / DNS failure: the clients classify this as
      // `unreachable/network` and fail closed — never a throw to the caller.
      throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    }
    const path = new URL(url).pathname;
    if (path === AUDIT_LEASE_RENEW_PATH_PIN) {
      const session = (JSON.parse(String(init.body)) as { session_id?: string }).session_id;
      if (session === undefined || !registry.has(session)) return jsonResponseFixture({}, 404);
      registry.set(session, Date.now() + LEASE_TTL_MS);
      return jsonResponseFixture({ session_id: session, expires_at: Date.now() + LEASE_TTL_MS }, 200);
    }
    if (path === AUDIT_LEASE_PATH_PIN && init.method === 'POST') {
      const session = (JSON.parse(String(init.body)) as { session_id?: string }).session_id;
      if (session === undefined) return jsonResponseFixture({}, 400);
      // Reap expired leases, then arbitrate: a DIFFERENT live session holding
      // the budget is a 429 with the pinned saturated contract.
      const now = Date.now();
      for (const [held, expiresAt] of [...registry]) {
        if (expiresAt <= now) registry.delete(held);
      }
      if (registry.size > 0 && !registry.has(session)) {
        return jsonResponseFixture(
          {
            reason: AUDIT_BUDGET_SATURATED_REASON,
            retry_after_s: SATURATED_RETRY_S,
          },
          429,
        );
      }
      registry.set(session, now + LEASE_TTL_MS);
      return jsonResponseFixture(
        { session_id: session, lease_id: `lease-${session}`, expires_at: now + LEASE_TTL_MS },
        200,
      );
    }
    if (path.startsWith(`${AUDIT_LEASE_PATH_PIN}/`)) {
      const session = decodeURIComponent(path.slice(AUDIT_LEASE_PATH_PIN.length + 1));
      registry.delete(session);
      return jsonResponseFixture({}, 200);
    }
    if (init.method === 'GET' && path === AUDIT_AVAILABILITY_PATH_PIN) {
      const snapshot = structuredClone(body);
      served.push(snapshot);
      return jsonResponseFixture(snapshot, 200);
    }
    return jsonResponseFixture({}, 404);
  };
  return {
    fetcher,
    /** Every availability body served so far, in order. */
    served,
    /** Publish a new availability verdict (the live lease comes/goes). */
    set(next: StubAvailabilityBody): void {
      body = { ...next };
    },
    /** The session ids currently holding an audit lease (registry evidence). */
    heldSessions(): string[] {
      return [...registry.keys()];
    },
    /** The proxy becomes unreachable (connection refused). */
    close(): void {
      unreachable = true;
    },
    /** Seed a lease for a scenario (e.g. an already-expired one to reclaim). */
    seedLease(session: string, expiresAt: number): void {
      registry.set(session, expiresAt);
    },
  };
}

type StubProxy = ReturnType<typeof createStubProxy>;

// ── The decision log (what each host saw and decided) ─────────────────

interface ProxyReadEntry {
  host: HostId;
  outcome: AuditAvailabilityOutcome;
}

/** The proxy-derived pre-check decision a host reached (its admission answer). */
interface PreCheckDecisionEntry {
  host: HostId;
  active: boolean;
  reason?: string;
  budget?: { live: number; max: number };
  detail?: string;
}

/** The structural admission verdict captured in the decision log. */
interface RecordedAdmission {
  admitted: boolean;
  live: number;
  max: number;
  reason?: string;
  repaired?: boolean;
}

/** One admission decision plus the audit-budget events it emitted. */
interface AdmissionDecisionEntry {
  host: HostId;
  admission: RecordedAdmission;
  events: AuditBudgetLogEvent[];
}

/**
 * The per-run decision log. It captures the REAL production seam outputs so
 * each scenario can assert the admission answer, the refusal token, the
 * evidence and the recorded proxy error — the "decision log" the acceptance
 * criteria refer to.
 */
interface DecisionLog {
  reads: ProxyReadEntry[];
  preChecks: PreCheckDecisionEntry[];
  admissions: AdmissionDecisionEntry[];
}

function emptyDecisionLog(): DecisionLog {
  return { reads: [], preChecks: [], admissions: [] };
}

// ── The host harness (a `createDowntimeDeps`-style seam slice) ────────

/**
 * Build ONE fake ContextHub host over the shared stub proxy.
 *
 * The seams mirror `index.ts` exactly, with the machine dir / clock injected
 * so the suite is isolated:
 *
 *  - `readAuditAvailability`  → the real bounded-GET client over the stub;
 *  - `getActiveAudit`         → the real proxy pre-check mapping
 *    (`decideAuditAvailability`), i.e. the admission answer before selection;
 *  - `admitHostDispatch`      → the real `admitHostDispatch`, re-reading the
 *    SAME proxy verdict the way `index.ts` does, so the pre-check and the
 *    claim-time admission can never disagree.
 */
function createHost(opts: {
  id: HostId;
  proxy: StubProxy;
  /** This host's OWN worklog root + machine coordination dir. */
  root: string;
  decisionLog: DecisionLog;
  auditCandidate?: DowntimeCandidate | null;
  implementCandidate?: DowntimeCandidate | null;
}): { id: HostId; deps: DowntimeWorkerDeps; spawnAgentPane: ReturnType<typeof vi.fn> } {
  const client = createAuditAvailabilityClient('http://stub-proxy:0', opts.proxy.fetcher);
  // The atomic arbiter (WL-0MWFJH3NW006F5GN): the SAME proxy URL, exercised
  // through the REAL lease client so the acquire/release wire protocol is
  // what the scenarios prove — not a re-implementation.
  const leaseClient = createAuditLeaseClient('http://stub-proxy:0', opts.proxy.fetcher);

  const readAvailability = async (): Promise<AuditAvailabilityOutcome> => {
    const outcome = await client();
    opts.decisionLog.reads.push({ host: opts.id, outcome });
    return outcome;
  };

  // Mirror `index.ts`'s proxy-derived pre-check (WL-0MWAMSDNW000SL0E): the
  // proxy verdict decides the audit tier; a failed read fails CLOSED.
  const getActiveAudit: DowntimeWorkerDeps['getActiveAudit'] = async () => {
    const decision = decideAuditAvailability(await readAvailability());
    opts.decisionLog.preChecks.push({
      host: opts.id,
      active: decision.active,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      ...(decision.budget !== undefined ? { budget: decision.budget } : {}),
      ...(decision.detail !== undefined ? { detail: decision.detail } : {}),
    });
    if (!decision.active) return { ok: true, active: false, source: 'proxy' };
    return {
      ok: true,
      active: true,
      source: 'proxy',
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      ...(decision.budget !== undefined ? { budget: decision.budget } : {}),
      ...(decision.detail !== undefined ? { detail: decision.detail } : {}),
    };
  };

  // Mirror `index.ts`'s admission seam (WL-0MWFJH3NW006F5GN AC2): the SAME
  // availability pre-check AND the proxy's atomic audit lease decide, so the
  // pre-check and admission agree and quote one vocabulary. The acquire is
  // attempted ONLY when the pre-check admits (never any churn on a refused
  // read) and the session id is derived from the item, so a retry renews
  // rather than competes.
  const admit: DowntimeWorkerDeps['admitHostDispatch'] = async (input) => {
    const audit = input.kind === 'audit';
    const auditAvailability = audit ? await readAvailability() : undefined;
    const preCheck =
      audit && auditAvailability !== undefined
        ? decideAuditAvailability(auditAvailability)
        : undefined;
    const auditLease =
      audit && preCheck !== undefined && !preCheck.active
        ? await leaseClient.acquire(auditLeaseSessionId(input.itemId))
        : undefined;
    const events: AuditBudgetLogEvent[] = [];
    const admission = admitHostDispatch(
      {
        kind: audit ? 'audit' : 'implement',
        itemId: input.itemId,
        instanceId: `host-${opts.id}`,
        root: input.cwd,
      },
      {
        dir: opts.root,
        livePanes: [],
        env: CLEAN_ENV,
        ...(auditAvailability !== undefined
          ? { auditAvailability, onAuditBudgetEvent: (event: AuditBudgetLogEvent) => events.push(event) }
          : {}),
        ...(auditLease !== undefined ? { auditLease } : {}),
      },
    );
    opts.decisionLog.admissions.push({ host: opts.id, admission, events });
    return admission;
  };

  const spawnAgentPane = vi.fn().mockResolvedValue({ ok: true });
  const deps = makeDeps({
    getActiveAudit,
    admitHostDispatch: admit,
    spawnAgentPane,
    getNextAuditCandidate: vi
      .fn()
      .mockResolvedValue({ ok: true, candidate: opts.auditCandidate ?? null }),
    getNextImplementCandidate: vi.fn().mockResolvedValue(opts.implementCandidate ?? null),
  });
  return { id: opts.id, deps, spawnAgentPane };
}

// ── Suite scaffolding ─────────────────────────────────────────────────

let tracker: TempDirTracker;
let stderrLines: string[];
let stderrSpy: { mockRestore: () => void };

beforeEach(() => {
  tracker = createTempDirTracker();
  stderrLines = [];
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
});

afterEach(() => {
  stderrSpy.mockRestore();
  tracker.cleanup();
});

/** A fresh worklog root + machine coordination dir for one fake host. */
function hostRoot(label: HostId): string {
  return tracker.make(`wl-xhost-${label.toLowerCase()}-`);
}

// ── Scenarios ─────────────────────────────────────────────────────────

describe('cross-host audit serialisation (parent WL-0MW95GBEG005ERHS)', () => {
  it('case 1: host A is admitted on available:true; host B reads the SAME stale availability and is refused by the atomic lease (the 2026-11-03 race)', async () => {
    const rootA = hostRoot('A');
    const rootB = hostRoot('B');
    const proxy = createStubProxy({ cap: 1, live: 0, available: true });
    const decisionLog = emptyDecisionLog();
    const hostA = createHost({ id: 'A', proxy, root: rootA, decisionLog, auditCandidate: AUDIT_ON_A });
    const hostB = createHost({ id: 'B', proxy, root: rootB, decisionLog, auditCandidate: AUDIT_ON_B });

    // Host A: the proxy reports an open budget → availability pre-check
    // admits, the lease acquire answers 200 → pane spawned.
    const first = await dispatchDowntimeWork(hostA.deps, { model: 'plan', cwd: rootA });
    expect(first).toMatchObject({ dispatched: true, kind: 'audit' });
    expect(first.candidate?.id).toBe(AUDIT_ON_A.id);
    expect(hostA.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(proxy.heldSessions()).toEqual([auditLeaseSessionId(AUDIT_ON_A.id)]);

    // THE RACE: the availability body is NOT updated — host B reads the SAME
    // point-in-time observation (available:true, live:0) that admitted A. The
    // pre-check alone would admit again; ONLY the proxy's atomic lease
    // registry arbitrates, answering 429 for B's different session.
    const second = await dispatchDowntimeWork(hostB.deps, { model: 'plan', cwd: rootB });
    expect(second.dispatched).toBe(false);
    // The refusal quotes the shared saturated token AND the bounded cooldown.
    expect(second.reason).toBe(AUDIT_BUDGET_SATURATED_REASON);
    expect(second.retryAfterS).toBe(SATURATED_RETRY_S);
    expect(hostB.spawnAgentPane).not.toHaveBeenCalled();

    // Demotion pin (AC4): the availability read that would have admitted B
    // (pre-check active:false) did NOT suffice — the lease gate refused.
    const hostBPreCheck = decisionLog.preChecks.find((entry) => entry.host === 'B');
    expect(hostBPreCheck).toMatchObject({ active: false, budget: { live: 0, max: 1 } });
    expect(proxy.heldSessions()).toEqual([auditLeaseSessionId(AUDIT_ON_A.id)]);
  });

  it('regression pin: with per-host caps (pre-change) BOTH hosts admit — the incident this suite prevents', () => {
    // The pre-change admission decided from each host's OWN `budget.json`
    // `maxAudit` + local ledger (reached today only behind the one-release
    // `HERDR_AUDIT_LOCAL_BUDGET=1` flag). With maxAudit 1 and an empty local
    // ledger, each host believes it is under its cap, so two audits run
    // concurrently on the single GPU — exactly the 2026-11-03 incident.
    const legacyEnv: Readonly<Record<string, string | undefined>> = { HERDR_AUDIT_LOCAL_BUDGET: '1' };
    const rootA = hostRoot('A');
    const rootB = hostRoot('B');

    const admittedOnA = admitHostDispatch(
      { kind: 'audit', itemId: AUDIT_ON_A.id, instanceId: 'host-A', root: rootA },
      { dir: rootA, livePanes: [], env: legacyEnv },
    );
    const admittedOnB = admitHostDispatch(
      { kind: 'audit', itemId: AUDIT_ON_B.id, instanceId: 'host-B', root: rootB },
      { dir: rootB, livePanes: [], env: legacyEnv },
    );

    expect(admittedOnA).toMatchObject({ admitted: true, live: 0, max: 1 });
    expect(admittedOnB).toMatchObject({ admitted: true, live: 0, max: 1 });
  });

  it('case 2: both hosts are refused with the proxy\'s own token and the same evidence (one vocabulary)', async () => {
    const rootA = hostRoot('A');
    const rootB = hostRoot('B');
    const proxy = createStubProxy({
      cap: 1,
      live: 1,
      available: false,
      reason: AUDIT_BUDGET_SATURATED_REASON,
    });
    const decisionLog = emptyDecisionLog();
    const hostA = createHost({ id: 'A', proxy, root: rootA, decisionLog, auditCandidate: AUDIT_ON_A });
    const hostB = createHost({ id: 'B', proxy, root: rootB, decisionLog, auditCandidate: AUDIT_ON_B });

    const a = await dispatchDowntimeWork(hostA.deps, { model: 'plan', cwd: rootA });
    const b = await dispatchDowntimeWork(hostB.deps, { model: 'plan', cwd: rootB });

    for (const outcome of [a, b]) {
      expect(outcome.dispatched).toBe(false);
      expect(outcome.reason).toBe(AUDIT_BUDGET_SATURATED_REASON);
      // One vocabulary, one evidence set: the dispatcher's token IS the
      // proxy's refusal reason string and both quote live/cap verbatim.
      expect(outcome.reason).toBe(proxy.served.at(-1)?.reason);
      expect(outcome.budget).toEqual({ live: 1, max: 1 });
    }
    expect(a.reason).toBe(b.reason);
    expect(hostA.spawnAgentPane).not.toHaveBeenCalled();
    expect(hostB.spawnAgentPane).not.toHaveBeenCalled();

    // Both pre-checks agree with the proxy (dispatcher ↔ proxy agreement).
    expect(decisionLog.preChecks).toHaveLength(2);
    for (const entry of decisionLog.preChecks) {
      expect(entry).toMatchObject({
        active: true,
        reason: AUDIT_BUDGET_SATURATED_REASON,
        budget: { live: 1, max: 1 },
      });
    }

    // The real admission reader refuses on the SAME verdict and records the
    // proxy/local divergence with both sides' evidence (the decision log).
    const admission = await hostA.deps.admitHostDispatch?.({
      kind: 'audit',
      itemId: AUDIT_ON_A.id,
      cwd: rootA,
    });
    expect(admission).toMatchObject({
      admitted: false,
      reason: AUDIT_BUDGET_SATURATED_REASON,
      live: 1,
      max: 1,
    });
    const logged = decisionLog.admissions.at(-1);
    expect(logged?.events).toContainEqual(
      expect.objectContaining({ event: 'divergence' }),
    );
  });

  it('case 3: an unreachable proxy fails both hosts closed as audit-budget-unknown with no pane', async () => {
    const rootA = hostRoot('A');
    const rootB = hostRoot('B');
    const proxy = createStubProxy({ cap: 1, live: 0, available: true });
    // The GPU/proxy host goes away: connection refused.
    proxy.close();
    const decisionLog = emptyDecisionLog();
    const hostA = createHost({ id: 'A', proxy, root: rootA, decisionLog, auditCandidate: AUDIT_ON_A });
    const hostB = createHost({ id: 'B', proxy, root: rootB, decisionLog, auditCandidate: AUDIT_ON_B });

    const a = await dispatchDowntimeWork(hostA.deps, { model: 'plan', cwd: rootA });
    const b = await dispatchDowntimeWork(hostB.deps, { model: 'plan', cwd: rootB });

    for (const [outcome, host] of [
      [a, hostA],
      [b, hostB],
    ] as const) {
      expect(outcome.dispatched).toBe(false);
      // Never a permissive fall-back to the local cap: unknown availability
      // STOPS audit dispatch on every host.
      expect(outcome.reason).toBe(AUDIT_BUDGET_UNKNOWN_REASON);
      expect(outcome.reason).not.toBe(AUDIT_BUDGET_SATURATED_REASON);
      // No proxy evidence exists on a failed read — never a fabricated 0/0.
      expect(outcome.budget).toBeUndefined();
      expect(host.spawnAgentPane).not.toHaveBeenCalled();
    }

    // The proxy error is recorded in the decision log: the read is a typed
    // `unreachable/network`, and the pre-check decision carries the failing
    // exchange as its detail.
    for (const entry of decisionLog.reads) {
      expect(entry.outcome).toEqual({ status: 'unreachable', reason: 'network' });
    }
    expect(decisionLog.preChecks).toHaveLength(2);
    for (const entry of decisionLog.preChecks) {
      expect(entry).toMatchObject({
        active: true,
        reason: AUDIT_BUDGET_UNKNOWN_REASON,
        detail: 'network',
      });
    }
    // The production skip line carries the failing exchange to the operator.
    expect(
      stderrLines.some(
        (line) => line.includes(AUDIT_BUDGET_UNKNOWN_REASON) && line.includes('detail=network'),
      ),
    ).toBe(true);
  });

  it('case 4: an EXPIRED lease is reclaimed at acquire time — the first host dispatches, and only a LIVE lease refuses the second (a leak holds the tier only until its expiry)', async () => {
    const restartedAt = Date.now();
    const expiredLease = { id: 'lease-stale', expires_at: restartedAt - HOUR_MS };
    const proxy = createStubProxy({
      cap: 1,
      live: 0,
      available: true,
      leases: [expiredLease],
      reclaimed: 1,
    });
    // The registry holds the SAME expired lease the availability body
    // reports: it must not phantom-block a fresh acquire (AC3 — a leaked
    // lease never holds the audit tier past its expiry).
    proxy.seedLease('lease-stale', restartedAt - HOUR_MS);
    const decisionLog = emptyDecisionLog();
    const rootA = hostRoot('A');
    const rootB = hostRoot('B');
    const hostA = createHost({ id: 'A', proxy, root: rootA, decisionLog, auditCandidate: AUDIT_ON_A });
    const hostB = createHost({ id: 'B', proxy, root: rootB, decisionLog, auditCandidate: AUDIT_ON_B });

    // Host A: the expired lease is reaped on acquire → 200 → dispatched.
    const a = await dispatchDowntimeWork(hostA.deps, { model: 'plan', cwd: rootA });
    expect(a).toMatchObject({ dispatched: true, kind: 'audit' });
    expect(hostA.spawnAgentPane).toHaveBeenCalledTimes(1);
    expect(proxy.heldSessions()).toEqual([auditLeaseSessionId(AUDIT_ON_A.id)]);

    // Host B reads the SAME stale availability body (still available:true)
    // but its acquire is refused by host A's LIVE lease — the arbitration is
    // the lease, never the point-in-time read.
    const b = await dispatchDowntimeWork(hostB.deps, { model: 'plan', cwd: rootB });
    expect(b).toMatchObject({ dispatched: false, reason: AUDIT_BUDGET_SATURATED_REASON });
    expect(hostB.spawnAgentPane).not.toHaveBeenCalled();
    expect(proxy.heldSessions()).toEqual([auditLeaseSessionId(AUDIT_ON_A.id)]);

    // The lease evidence is still in the decision log (the diagnostic read
    // reflects the proxy's reclamation: the expired lease with its reclaimed
    // count survives the pinned parser).
    const read = decisionLog.reads.find((entry) => entry.host === 'A');
    expect(read?.outcome).toMatchObject({
      status: 'ok',
      availability: {
        cap: 1,
        live: 0,
        available: true,
        reclaimed: 1,
        leases: [{ id: expiredLease.id, expiresAt: expiredLease.expires_at }],
      },
    });
    const lease =
      read?.outcome.status === 'ok' ? read.outcome.availability.leases?.[0] : undefined;
    expect(lease?.expiresAt).toBeLessThan(Date.now());
  });

  it('case 5: the implement tier is unaffected by the proxy audit verdict on either host', async () => {
    const rootA = hostRoot('A');
    const rootB = hostRoot('B');
    const proxy = createStubProxy({ cap: 1, live: 0, available: true });
    const decisionLog = emptyDecisionLog();
    const hostA = createHost({
      id: 'A',
      proxy,
      root: rootA,
      decisionLog,
      auditCandidate: null,
      implementCandidate: IMPLEMENT_ON_HOST,
    });
    const hostB = createHost({
      id: 'B',
      proxy,
      root: rootB,
      decisionLog,
      auditCandidate: null,
      implementCandidate: IMPLEMENT_ON_HOST,
    });

    // Both hosts dispatch implement work while the proxy admits audits.
    const before = [
      await dispatchDowntimeWork(hostA.deps, { model: 'plan', cwd: rootA }),
      await dispatchDowntimeWork(hostB.deps, { model: 'plan', cwd: rootB }),
    ];

    // The audit verdict flips to saturated — implement admission must not move.
    proxy.set({ cap: 1, live: 1, available: false, reason: AUDIT_BUDGET_SATURATED_REASON });
    const after = [
      await dispatchDowntimeWork(hostA.deps, { model: 'plan', cwd: rootA }),
      await dispatchDowntimeWork(hostB.deps, { model: 'plan', cwd: rootB }),
    ];

    for (const outcome of [...before, ...after]) {
      expect(outcome).toMatchObject({
        dispatched: true,
        kind: 'implement',
        candidate: { id: IMPLEMENT_ON_HOST.id },
      });
    }
    expect(hostA.spawnAgentPane).toHaveBeenCalledTimes(2);
    expect(hostB.spawnAgentPane).toHaveBeenCalledTimes(2);

    // The audit state WAS consulted on every tick (the pre-check ran before the
    // implement tier), so the unchanged implement answer is independent of it.
    expect(decisionLog.preChecks.filter((entry) => entry.host === 'A')).toHaveLength(2);
    expect(decisionLog.preChecks.filter((entry) => entry.host === 'B')).toHaveLength(2);
    expect(decisionLog.preChecks.map((entry) => entry.active)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});
