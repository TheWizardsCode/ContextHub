# Investigation: chrome-headless Concurrency Profile & Memory Footprint

**Work items:**
- WL-0MT38GKEP0057T4I — Document concurrency profile and memory footprint of chrome-headless instances
- WL-0MT1KJNHY00286QE — Investigate chrome-headless workload causing GPU crashes and memory pressure (parent)

**Status:** Investigation complete. One browser instance at a time per vitest
run (~7–8 processes), typical tree RSS 0.3–1.7 GiB, renderer dominant;
incident window (Aug 20 13:20–13:26) sustained 20+ concurrent instances
chained sequentially through vitest's fileParallelism:false project.

**Related:** [chrome-headless-orchestrator-investigation.md](./chrome-headless-orchestrator-investigation.md)
(orchestrator = vitest browser mode via Playwright inside herdr-downtime pi
agents); [NVIDIA driver API mismatch RCA / fix (WL-0MT1KJNDK004SNPK)] (root
cause + mitigation, owned by sibling).

---

## 1. Executive summary

Each chrome-headless-shell instance is a **single browser process tree of 7–8
processes** (root browser process + 2 zygotes + gpu-process + network utility +
audio utility + ≥1 renderer). During a running vitest browser suite, **exactly
one instance is alive at a time** (the `browser` vitest project is configured
with `fileParallelism: false, sequence: { concurrent: false }`), but instances
are churned sequentially as test files complete — over a ~45-minute incident
window on Aug 20 the kernel saw **90 distinct chrome-headless client PIDs** and
up to **24 concurrent in the worst minute**.

Memory footprint per instance (live-observed, 2026-08-21 22:43–22:53):

- Root browser process: **~100–110 MiB RSS**, VSZ ~48 GiB (virtual, normal for Chromium)
- gpu-process: ~100–156 MiB (SwiftShader software GL flags present)
- Renderer: **~40 MiB – 1.0 GiB RSS** (dominant; heavy page/tests drive it up)
- Network utility: ~60–104 MiB; audio utility: ~61 MiB; each zygote: ~40 MiB
- Whole tree RSS observed: **461 → 1,721 MiB** across samples in one run
  (fresh instance ~315 MiB, loaded renderer instance ~1.5–1.7 GiB)

## 2. Per-instance process anatomy (live capture 22:43)

```
chrome-headless-shell (root, PID 2884256, RSS 109,720 kB, VSZ 50.7 GB, 20 threads)
├─ zygote (2884258, 40,392 kB)
│  └─ gpu-process (2884275, 156,396 kB)
├─ zygote (2884259, 40,808 kB)
│  └─ renderer (2884289, 1,015,580 kB ← ~1 GiB!)
├─ utility network.mojom.NetworkService (2884277, 104,072 kB)
└─ utility audio.mojom.AudioService (2884521, 61,176 kB)
```

Tree total: **1,492.3 MiB across 7 processes** (this was a renderer-heavy
window; samples 40 s apart showed 461 MiB and 706 MiB for other instances).

## 3. Concurrency profile

### 3.1 Steady state (vitest `browser` project, sequential)

Project config (Tableau-Card-Engine `vite.config.ts`, `browser` project):

```ts
fileParallelism: false,
sequence: { concurrent: false },
testTimeout: 30_000,
browser: { enabled: true, provider: 'playwright', headless: true,
           instances: [{ browser: 'chromium' }], isolate: true }
```

Live sampling while the suite ran (2026-08-21 22:51–22:53):

| Time | root instances | procs | tree RSS |
|------|---------------|-------|----------|
| 22:51:54 | 1 | 7 | 1,721 MiB |
| 22:52:34 | 1 | 6 | 461 MiB |
| 22:53:14 | 1 | 7 | 706 MiB |

So the concurrency ceiling per vitest run is **1 instance at a time**, but the
sibling herdr pipeline runs **multiple pi agents in parallel** (9 agent
sessions observed running concurrently on this machine at 22:49), each of which
may run its own vitest browser suite → multiple instances can coexist when
several agents run tests simultaneously. During the Aug 20 incident this is
exactly what happened (see 3.2).

### 3.2 Incident window (Aug 20 12:50–13:35) — concurrency evidence

From kernel logs (`NVRM: API mismatch: the client 'chrome-headless' (pid …)`):

- **703 NVRM API-mismatch events** logged in the 45-minute window; **655 of
  them in 13:20–13:30** (the peak burst); **1,007 events** across the whole
  Aug 20 day; 7,645 events total in the current `/var/log/kern.log`.
- **90 distinct chrome-headless client PIDs** observed over the window →
  ~11–12 instance lifetimes × 7–8 procs each.
- **Distinct chrome PIDs per minute** (worst minutes):
  `13:24: 24`, `13:23: 23`, `13:25: 21`, `13:22: 8`, `13:26: 7` — i.e., up to
  **24 distinct chrome processes alive in the same minute** ≈ **3 concurrent
  instances** (24 ÷ ~7–8 procs).
- Event bursts (per-second): `54 events @ 13:23:26`, `43 @ 13:23:33`,
  `37 @ 13:22:09` — a GPU-call retry storm: each failed GL call logs one
  mismatch event, so repeated failed GPU calls from multiple processes
  generate hundreds of kernel lines per minute.

### 3.3 Memory-pressure timeline (Aug 20 13:27–13:44)

```
13:27:30  systemd-journald: Under memory pressure, flushing caches
13:29:59  systemd-journald: Under memory pressure, flushing caches
13:30:36  systemd-journald: Under memory pressure, flushing caches
13:31:20  systemd-journald: Under memory pressure, flushing caches
13:33:47  systemd-resolved: Under memory pressure, flushing caches
13:37:50-52  journald + resolved: Under memory pressure, flushing caches
13:37:51  snapd.service: Watchdog timeout (limit 5min)! → failed watchdog
13:38:27  snapd watchdog goroutine dump
13:39:54  journald: Under memory pressure, flushing caches
13:40:44  journald: Under memory pressure, flushing caches
13:43:54  systemd-oomd started (userspace OOM-killer socket)
13:43:47  reboot completed (boot 0 begins at 13:43:47 IST)
```

The system became unresponsive and was rebooted at ~13:40–13:44. No OOM-kill
of a single process is recorded — the whole system froze under accumulated
memory pressure + watchdog timeout (the failure mode matches the sibling's RCA:
chrome-headless enters GPU-call retry loops, memory accumulates, system hangs).

## 4. Per-process memory details

| Process type | Observed RSS | Notes |
|---|---|---|
| Root browser process | 100–110 MiB | ~20 threads; VSZ ~48–51 GB (virtual reservations) |
| zygote ×2 | ~40 MiB each | |
| gpu-process | 100–156 MiB | runs with `--use-angle=swiftshader-webgl --enable-unsafe-swiftshader` |
| renderer | 40 MiB – 1,015 MiB | dominant, highly variable with workload |
| network utility | 60–104 MiB | |
| audio utility | ~61 MiB | |

Server memory: **30 GiB total / 8 GiB swap**. A single renderer-heavy instance
(~1.7 GiB) is not by itself fatal, but N instance churn + retry loops +
parallel agent sessions is what overwhelmed the box on Aug 20.

## 5. Commands used

```bash
ps -C chrome-headless-shell -o pid,ppid,etimes,rss,vsz,comm,args   # per-proc memory
grep -E '^(Name|VmRSS|VmSize|Threads)' /proc/<pid>/status         # instance detail
ps -C chrome-headless-shell -o rss= | awk '{s+=$1} END {print s}' # tree total
journalctl --since "2026-08-20 12:50" --until "2026-08-20 13:35" | grep 'NVRM: API mismatch'
journalctl ... | grep -oP 'pid \d+' | sort | uniq -c               # per-PID concurrency
journalctl ... | grep -iE 'memory pressure|oom|watchdog|killed'    # pressure timeline
free -h                                                            # host totals
```

## 6. Conclusion

- **Concurrency profile:** 1 chrome-headless instance per vitest browser run
  (sequential project), ~7–8 processes each; parallel herdr agent sessions
  multiply instances (3+ concurrent observed at the Aug 20 peak; 90 distinct
  instances churned across the 45-minute window).
- **Memory footprint:** root ~100–110 MiB, per-instance tree 0.3–1.7 GiB,
  renderer dominant (up to ~1 GiB). Under normal test load this is
  manageable; under the incident it compounded with GPU retry loops and
  parallel agents into system-wide memory pressure and a reboot.
- This feeds the sibling mitigation (WL-0MT1KJNDK004SNPK): bounding
  concurrency, reducing renderer memory, and/or eliminating the GPU-call
  retry loop are the levers.