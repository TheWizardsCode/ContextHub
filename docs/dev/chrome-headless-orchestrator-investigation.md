# Investigation: What Orchestrates `chrome-headless-shell`?

**Work items:**
- WL-0MT386OYV004DBD5 — Identify orchestrating process launching chrome-headless-shell
- WL-0MT1KJNHY00286QE — Investigate chrome-headless workload causing GPU crashes and memory pressure (parent)

**Status:** Investigation complete. Single orchestrator identified — the
Vitest **browser-mode** test runner (Playwright provider) invoked by the
herdr-dispatched pi agent pipeline.

**Related:** [NVIDIA driver API mismatch RCA / fix (WL-0MT1KJNDK004SNPK)] — root
cause and mitigation owned by the sibling item; concurrency + memory profile in
[chrome-headless-concurrency-memory-profile-investigation.md](./chrome-headless-concurrency-memory-profile-investigation.md).

---

## 1. Executive summary

`chrome-headless-shell` on this machine is **not** launched by systemd units,
cron jobs, scripts, or a standalone service. The only launch mechanism is the
**Vitest browser-mode test runner** (`vitest run --project browser`) executed
by the **test skill / implement workflow** inside **herdr-dispatched pi agent
sessions**. Vitest's browser provider is **Playwright**, which spawns the
Playwright-managed `chrome-headless-shell` binary from
`~/.cache/ms-playwright/chromium_headless_shell-1208/`.

The observed live launch chain (2026-08-21 22:43–22:53):

```
herdr server (PID 8984)
└─ run-pi-agent.sh herdr-XXX --model plan        (PID 68766)
   └─ pi                                           (PID 68796)
      └─ bash -c "cd <worktree> && timeout 1500 npx vitest run --project browser 2>&1 | grep -E 'Test Files|Tests |FAIL' | head -10"
                                                    (PID 2884024)
         └─ timeout 1500 npx vitest run --project browser
                                                    (PID 2884026)
            └─ npm exec vitest run --project browser (PID 2884030)
               └─ sh -c vitest run --project browser (PID 2884090)
                  └─ node (vitest)                   (PID 2884092)
                     └─ chrome-headless-shell         (PID 2884256, +6 child procs)
```

The vitest invocation was running inside a **Tableau-Card-Engine worktree**
(`.worklog/worktrees/wl-CG-0MT3C744B009DS84-...`) — the suite being tested is
Tableau-Card-Engine's `--project browser` branch of `vite.config.ts`
(`browser: { enabled: true, provider: 'playwright', headless: true,
instances: [{ browser: 'chromium' }] }`).

## 2. Launch mechanisms assessed

| Mechanism | Present? | Evidence |
|---|---|---|
| **Vitest browser mode (Playwright provider)** | ✅ **YES — the orchestrator** | Live pid-tree capture (section 3); `vite.config.ts` `browser` project; playwright dep in Tableau-Card-Engine `package.json` line 41 |
| systemd user services/timers | ❌ No | `systemctl list-units --user --all` — only desktop/GPG/pipewire/snap units; no chrome/playwright/browser entries; 4 user timers all unrelated (firmware-notifier, launchpadlib-cache-clean, ubuntu-insights) |
| systemd system services | ❌ No | `systemctl list-units --all` — no chrome/playwright/browser match |
| cron / at | ❌ No | `crontab -l` only has `llm-wiki-autoupdate` (runs `pi -p /wiki-run` — a Pi prompt, not a test/browser launcher); `atq` empty; `/etc/crontab` stock |
| Standalone scripts / git hooks | ❌ No | No vitest/playwright references in `.git/hooks`; no tmux/systemd-run test launchers |
| System-wide chromium | ❌ No | No `chromium`, `chromium-browser`, `google-chrome` on PATH; no snap chromium |

**If multiple launch mechanisms exist, document all of them:** only one was
found (Vitest browser mode via Playwright). The `llm-wiki-autoupdate` cron
job (`0 8 * * * /bin/bash -lc '... pi -p "/wiki-run" ...'`) invokes the pi
CLI with a prompt called `/wiki-run`; the pi agent does not recognise that
prompt and it does not launch browsers. Verified: it is not a test runner.

## 3. Live evidence (captured 2026-08-21 ~22:43)

### 3.1 Process tree of a chrome-headless-shell instance

```
chrome-headless-shell (root, PID 2884256)
├─ chrome-headless-shell --type=zygote   (2884258)
│  └─ chrome-headless-shell --type=gpu-process (2884275, 20 threads)
├─ chrome-headless-shell --type=zygote   (2884259)
│  └─ chrome-headless-shell --type=renderer (2884289)
├─ chrome-headless-shell --type=utility network.mojom.NetworkService (2884277)
└─ chrome-headless-shell --type=utility audio.mojom.AudioService (2884521)
```

Each instance: **7–8 processes** (root browser process, 2 zygotes, gpu-process,
network utility, audio utility, ≥1 renderer).

### 3.2 Parent chain (the orchestrator)

| PID | Parent | Command |
|-----|--------|---------|
| 2884256 | 2884092 | `chrome-headless-shell` (binary from `~/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/`) |
| 2884092 | 2884090 | `node (vitest)` |
| 2884090 | 2884030 | `sh -c vitest run --project browser` |
| 2884030 | 2884026 | `npm exec vitest run --project browser` |
| 2884026 | 2884024 | `timeout 1500 npx vitest run --project browser` |
| 2884024 | 68796 | `bash -c cd /home/rgardler/projects/Tableau-Card-Engine/.worklog/worktrees/wl-CG-0MT3C744B009DS84-... && timeout 1500 npx vitest run --project browser 2>&1 | grep ...` |
| 68796 | 68766 | `pi` |
| 68766 | 8984 | `bash .../packages/herdr/shared/run-pi-agent.sh herdr-1787312214-68751-18001 --model plan` |
| 8984 | — | `herdr server` |

### 3.3 The suite configuration

Tableau-Card-Engine `vite.config.ts`, `test.projects[]`, project `browser`:

```ts
{
  name: 'browser',
  include: ['tests/**/*.browser.test.ts'],
  fileParallelism: false,
  sequence: { concurrent: false },
  testTimeout: 30_000,
  browser: {
    enabled: true,
    provider: 'playwright',
    headless: true,
    instances: [{ browser: 'chromium' }],
    viewport: { width: 900, height: 700 },
    isolate: true,
  },
}
```

`package.json` declares `"playwright": "^1.58.2"`, and the Playwright-managed
binary is `~/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell`.

### 3.4 Who triggers it: herdr-downtime dispatch

The `pi` parent is a **herdr-downtime worker**:
`run-pi-agent.sh herdr-* --model plan` — herdr server auto-dispatches agents
to process work items; the **implement workflow** runs the full test suite via
the **test skill** (`/skill:test` → `run_tests.py` → suite commands), and for
Tableau-Card-Engine the suite (`npm --silent test` → `scripts/run-ci-tests.sh`)
includes `npx tsx scripts/vitest-run-with-retry.ts --project browser
--timeout-ms 900000`. During implementation, agents also invoke
`npx vitest run --project browser` directly (the live chain above shows the
direct `timeout 1500 npx vitest run --project browser` form).

## 4. Commands used for identification

```bash
pgrep -af chrome-headless-shell                          # find instances
ps -o ppid= -p <PID>                                     # walk parents
ps -o pid,ppid,args -p <PID>                             # full chain
pstree -ap <PID>                                         # instance tree
systemctl list-units --user --all --type=service,timer   # no browser units
crontab -l; atq; ls /etc/cron.d; cat /etc/crontab        # no test/browser jobs
grep -rln 'vitest\|playwright' .git/hooks                # no git hooks
which chromium chromium-browser google-chrome            # no system chromium
```

## 5. Conclusion

- **Orchestrating process:** `node (vitest)` running `vitest run --project
  browser`, parented by `npm exec` → `timeout` → `bash -c` → `pi` →
  `run-pi-agent.sh` → `herdr server`.
- **Launching mechanism:** programmatic invocation — Vitest browser-mode with
  the **Playwright** provider (Node.js code), not systemd/cron/script.
- **Single mechanism confirmed:** all other candidate mechanisms audited and
  found absent (systemd user/system, cron/at, git hooks, system chromium).
- **Suite owner:** Tableau-Card-Engine (the machine hosts its worktrees; the
  machine is also the ContextHub dev machine — herdr orchestrates both).