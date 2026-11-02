# Crash Reporting Setup & Retention Policy

**Work Item:** WL-0MT1KJNMV0018SWP — Enable automatic crash reporting and review existing crash dumps
**Date:** 2026-09-05
**Status:** Verified, gaps documented, remediation steps provided

---

## 1. Summary

| Component | Tool | Status | Action Required |
|-----------|------|--------|-----------------|
| Userspace crash reports | **apport** | ✅ Functional | None |
| Upload daemon | **whoopsie** (+ whoopsie.path) | ⚠️ Installed but path unit disabled | `sudo systemctl enable --now whoopsie.path` |
| Kernel crash dumps | **kdump-tools** (kexec/kdump) | ✅ Functional — crash kernel loaded | None |
| Retention / rotation | **apport cron** (`/etc/cron.daily/apport`) | ✅ Active (prunes >7 days) | Optional: add size guard (see §4) |
| Existing dump | `_usr_bin_node.1000.crash` 468 MB (2026-08-29) | Reviewed — safe to purge | `rm /var/crash/_usr_bin_node.1000.crash` or let cron prune ~2026-09-05 |

Verification script: `scripts/crash-reporting-check.sh` (run `scripts/crash-reporting-check.sh --json` for machine-readable output). CI/test coverage in `tests/crash-reporting-check.test.ts`.

---

## 2. Userspace crash reporting (apport + whoopsie)

### 2.1 Apport — report generation

Apport generates per-crash `.crash` files in `/var/crash/` via a kernel `core_pattern` pipe.

Verified on 2026-09-05:

```
$ systemctl status apport
● apport.service - automatic crash report generation
  Loaded: loaded (/usr/lib/systemd/system/apport.service; enabled)
  Active: active (exited) since 2026-08-31

$ cat /etc/default/apport
enabled=1

$ cat /proc/sys/kernel/core_pattern
|/usr/share/apport/apport -p%p -s%s -c%c -d%d -P%P -u%u -g%g -F%F -- %E

$ apport-cli --version
2.34.0
```

Result: ✅ Report generation is enabled and apport is capturing crashes.

### 2.2 Whoopsie — upload daemon

Whoopsie watches `/var/crash` (via `whoopsie.path`) and uploads reports to `https://daisy.ubuntu.com` (Ubuntu Error Tracker). It is path-activated — `whoopsie.service` runs oneshot (`--no-polling`) each time `/var/crash` changes.

Verified on 2026-09-05:

```
$ systemctl status whoopsie.path
○ whoopsie.path - Start whoopsie on modification of the /var/crash directory
  Loaded: loaded (/usr/lib/systemd/system/whoopsie.path; disabled; preset: enabled)
  Active: inactive (dead)
  Triggers: whoopsie.service

$ systemctl status whoopsie
○ whoopsie.service - Service uploading crash reports to the Ubuntu Error Tracker
  Loaded: loaded (/usr/lib/systemd/system/whoopsie.service; static)
  Active: inactive (dead)

$ cat /etc/whoopsie
[General]
report_metrics=true

$ /usr/bin/whoopsie --version
0.2.82ubuntu

$ cat /etc/apport/crashdb.conf  # default database = "ubuntu" (Launchpad)
databases["ubuntu"]["impl"] = "launchpad"
```

Gap: `whoopsie.path` is **disabled**. Crash files are generated but never uploaded/processed until the path unit is enabled. This matches the RCA gap (crashes accumulated without reporting until system outage).

Remediation (requires sudo):

```bash
sudo systemctl enable --now whoopsie.path
systemctl status whoopsie.path   # should show active (waiting)
# Trigger a test upload run (processes any existing .crash files):
sudo systemctl start whoopsie.service
journalctl -u whoopsie -n 50
```

Risk: enabling the path unit has no memory or performance cost — it is a `PathChanged=/var/crash` inotify watch that spawns `whoopsie --no-polling` briefly. No additional reservation.

Verification after fix:

```bash
scripts/crash-reporting-check.sh        # human output
scripts/crash-reporting-check.sh --json # machine-readable
```

---

## 3. Kernel crash reporting (kdump / kexec)

### 3.1 Current state

```
$ dpkg -l kdump-tools
ii  kdump-tools  1:1.10.7ubuntu3

$ cat /etc/default/kdump-tools
USE_KDUMP=1
KDUMP_KERNEL=/var/lib/kdump/vmlinuz       # -> /boot/vmlinuz-7.0.0-30-generic
KDUMP_INITRD=/var/lib/kdump/initrd.img
KDUMP_COREDIR="/var/crash"

$ systemctl status kdump-tools.service
● kdump-tools.service - Kernel crash dump capture service
  Loaded: loaded (/usr/lib/systemd/system/kdump-tools.service; enabled)
  Active: active (exited) since 2026-08-31
  * Creating symlink /var/lib/kdump/vmlinuz
  * Creating symlink /var/lib/kdump/initrd.img
  * loaded kdump kernel

$ cat /var/crash/kexec_cmd
/sbin/kexec -p -s --command-line="... systemd.unit=kdump-tools-dump.service nr_cpus=1 irqpoll usbcore.nousb" --initrd=/var/lib/kdump/initrd.img /var/lib/kdump/vmlinuz

$ ls -l /var/lib/kdump/
initrd.img-7.0.0-30-generic  255 MB
vmlinuz -> /boot/vmlinuz-7.0.0-30-generic
```

Result: ✅ **kdump is configured and the crash kernel is loaded.** The next kernel panic will:

1. kexec into the crash kernel (`kdump-tools-dump.service`),
2. run `makedumpfile -c -d 31` (compressed, in-use pages only),
3. save `vmcore` + `dmesg` to `KDUMP_COREDIR` (`/var/crash`).

No `/etc/kdump.conf` is expected on Ubuntu — configuration lives in `/etc/default/kdump-tools`.

> **Correction (2026-11-01, WL-0MVY898D4007BZ28): the old "no further action required" conclusion
> was wrong, and the same misconfiguration is what made every earlier freeze leave no evidence.**
> `crashkernel` was reserved at 512 MB against a `kdump-config show` requirement of 1103 MB
> (the kdump initrd is 244 MB on disk / 310 MB recorded — the crash kernel could never boot far
> enough to write a vmcore). `current state: ready to kdump` was true and useless: it only verifies
> the reservation is *present*, never that a dump can be *written*.
>
> Fixed 2026-11-01 19:50 by a deliberate SysRq panic that reproduced the failure and forced the
> fix. The reservation was raised to **1280M** in `/etc/default/grub.d/kdump-tools.cfg`:
>
> ```
> crashkernel=2G-4G:320M,4G-32G:1280M,32G-64G:1280M,64G-128G:2048M,128G-:4096M
> ```
>
> Post-reboot verification (all pass):
>
> ```
> $ cat /sys/kernel/kexec_crash_size      # 1342177280 (= 1280 MiB)
> $ cat /sys/kernel/kexec_crash_loaded    # 1
> $ sudo kdump-config show | grep 'crashkernel addr'   # 0x8b000000 — populated
> ```
>
> **Proof, not trust:** a synthetic panic (`echo c > /proc/sysrq-trigger`) produced the host's first
> vmcore (`/var/crash/202611011959`, 309 MB + dmesg), and a genuine driver panic on the same day
> produced `/var/crash/202611012042` and `/var/crash/202611012106` — see the
> [Silent freezes / panic blink](#8-silent-freezes--panic-blink) section below.

### 3.2 Why not disabled

On a workstation with 32 GB+ RAM, the kdump reservation (~256 MB initrd + ~tens of MB runtime) is negligible. Disabling would mean a kernel panic leaves no post-mortem (the 2026-08-20 hang RCA would be impossible). Trade-off favours keeping it enabled.

Optional tuning (if disk pressure is a concern):

```bash
# /etc/default/kdump-tools
KDUMP_NUM_DUMPS=2          # keep at most 2 vmcores
KDUMP_COMPRESSION=xz       # higher compression
MAKEDUMP_ARGS="-c -d 31"   # default: compressed, filter free pages
```

---

## 4. Retention / rotation — preventing disk fill

### 4.1 Existing mechanism: apport daily cron

```
/etc/cron.daily/apport  (executable, runs via anacron)
```

```sh
find /var/crash/. ! -name . -prune -type f \( \( -size 0 -a ! -name '*.upload*' -a ! -name '*.drkonqi*' \) -o -mtime +7 \) -exec rm -f -- '{}' \;
find /var/crash/. ! -name . -prune -type d -regextype posix-extended -regex '.*/[0-9]{12}$' \( -mtime +7 \) -exec rm -Rf -- '{}' \;
```

Behaviour:

- Zero-byte crash files purged immediately (except `.upload`/`.drkonqi` sentinels).
- Non-zero files (including the 468 MB node dump) purged after **7 days** (`-mtime +7`).
- Crash report directories (apport-retrace) pruned similarly.

For the current dump (`_usr_bin_node.1000.crash`, mtime 2026-08-29 12:35), auto-prune fires **~2026-09-05** (already pending at time of this doc). This already prevents unbounded accumulation, but a single large dump can still sit for a week.

### 4.2 Size guard (recommended, not yet enabled)

The apport cron has no size cap. A future burst (e.g., repeated browser crashes) could fill `/var/crash` within the 7-day window. Recommended guard:

- `scripts/crash-reporting-check.sh` reports `WARN` when `/var/crash` exceeds 1 GB or a single file exceeds 500 MB (thresholds tunable via `--warn-size-mb`).
- Optional cron/systemd timer to run the check every 5 minutes and page on WARN (parallel to `wl-process-healthcheck.sh`).

Example timer (not installed by default — enable if desired):

```ini
# /etc/systemd/system/crash-reporting-check.service
[Unit]
Description=Crash reporting health check

[Service]
Type=oneshot
ExecStart=/home/rgardler/projects/ContextHub/scripts/crash-reporting-check.sh

# /etc/systemd/system/crash-reporting-check.timer
[Unit]
Description=Run crash reporting check every 5 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now crash-reporting-check.timer
```

### 4.3 Whoopsie retention

Whoopsie itself does not retain — it processes `.crash` files and leaves `.upload`/`.uploaded` sentinels that the apport cron ignores. No separate whoopsie retention setting is needed.

---

## 5. Existing crash dump review (WL-0MT1KJNMV0018SWP AC2)

### 5.1 File

```
File:  /var/crash/_usr_bin_node.1000.crash
Size:  490,251,823 bytes (468 MB)
Owner: rgardler:whoopsie (0640)
Date:  Sat Aug 29 12:34:55 2026  (mtime 2026-08-29 12:35:38)
```

### 5.2 Metadata (from report headers)

```
ProblemType:     Crash
Architecture:    amd64
DistroRelease:   Ubuntu 26.04
Package:         nodejs 22.22.1+dfsg+~cs22.19.15-1ubuntu1
ExecutablePath:  /usr/bin/node
ProcCmdline:     node (vitest 6)
ProcCwd:         /home/rgardler/projects/Tableau-Card-Engine
Signal:          6 (SIGABRT)
Uname:           Linux 7.0.0-30-generic x86_64
CoreDump:        base64  (468 MB decoded; full process memory included)
Stacktrace:      (absent — no Stacktrace/StacktraceTop/StacktraceAddressSignature fields)
```

ProcStatus excerpt:

```
Name:            node (vitest 6)
State:           S (sleeping)
VmPeak:          5,335,380 kB
VmSize:          5,335,128 kB
VmRSS:           4,364,048 kB  (~4.2 GiB)
RssAnon:         4,306,668 kB
VmData:          4,394,332 kB
CoreDumping:     1
Threads:         7
```

### 5.3 Interpretation

- The dump is a **Node.js SIGABRT** (abort signal) in a **vitest worker** (`node (vitest 6)`) running inside `Tableau-Card-Engine`. Signal 6 is typically `abort()` from an assertion, failed `CHECK`, or OOM-triggered abort (Node hits `--max-old-space-size` or V8 fatal error).
- Resident memory at crash was **~4.3 GiB RSS** with 5.3 GiB virtual — consistent with a browser-mode vitest run holding a large Chromium renderer plus JS heap.
- No structured stacktrace was captured (apport did not run `gdb`/`apport-retrace` to unwind; only `ProcMaps` + raw `CoreDump` are present). The 468 MB is a base64-encoded full core — the textual metadata itself is only a few hundred KB.
- This pattern matches the project's known vitest browser pressure (see `docs/dev/chrome-headless-concurrency-memory-profile-investigation.md`) and is unrelated to the kernel `int3` traps or the NVIDIA `Xid 119` GPU timeouts noted in the work item (those are separate headless-shell GPU issues; the most recent kernel trap was `electron[3853159] trap int3` on 2026-09-02).

### 5.4 Decision: purge

Recommendation: **purge the file** (or let the apport cron do it within 24 h). Rationale:

- RCA value is low: without a stacktrace the dump only proves "vitest 6 OOM/abort at 4.3 GiB" — that is already captured in this note.
- Cost is high: 468 MB is ~96% of `/var/crash` usage and risks masking a subsequent, more actionable crash if the partition fills.
- If deeper analysis is ever needed, a new dump will be generated with fresher state; alternatively, retain only the header (first ~64 KB) for provenance.

Purge (user-owned file — no sudo required):

```bash
# Keep a header excerpt for provenance (optional):
head -c 65536 /var/crash/_usr_bin_node.1000.crash > /tmp/node-crash-2026-08-29.header.txt
rm /var/crash/_usr_bin_node.1000.crash
du -sh /var/crash
```

Alternatively, rely on the existing cron: `/etc/cron.daily/apport` will remove the file automatically on its next run (by 2026-09-06 at latest, given `-mtime +7`).

---

## 6. How to verify (operator runbook)

```bash
# Quick human-readable check:
scripts/crash-reporting-check.sh
# Expected (before whoopsie.path fix):
#   apport:         OK (enabled=1, core_pattern piped to apport)
#   whoopsie.path:  WARN (disabled — run: sudo systemctl enable --now whoopsie.path)
#   kdump:          OK (USE_KDUMP=1, crash kernel loaded, KDUMP_COREDIR=/var/crash)
#   retention:      OK (cron /etc/cron.daily/apport prunes >7d; warn >1GB)
#   /var/crash:     WARN if 468 MB file present

# Machine-readable:
scripts/crash-reporting-check.sh --json | jq .

# After enabling whoopsie.path:
sudo systemctl enable --now whoopsie.path
systemctl status whoopsie.path
scripts/crash-reporting-check.sh --json | jq .whoopsie

# After purging the old dump:
rm /var/crash/_usr_bin_node.1000.crash   # or: sudo apport-cli --crash-file /var/crash/... --save /tmp/...
du -sh /var/crash
```

---

## 8. Silent freezes / panic blink (2026-11-01, WL-0MVY898D4007BZ28 AC-D)

**A "total freeze with blinking caps-lock LED" is a kernel panic, not a hardware/firmware freeze.**
The caps-lock blink is the **Linux panic LED loop** (~1 blink / 0.5 s), reproduced by a deliberate
SysRq crash on this host. Blaming the firmware/EC put every investigation on the wrong path; the
host's own filter chain made panic evidence invisible (each of the four capture layers failed
independently):

| Why nothing was captured | Evidence |
|---|---|
| crashkernel reservation too small | needed 1103M, reserved 512M → crash kernel never booted; fixed to 1280M (AC-A) |
| pstore cannot work on this firmware | `efi_pstore` loads but `/sys/firmware/efi/efivars` has no dump/OOPS store — dead end |
| journald cannot flush at panic | journal always stops mid-sentence; panic text goes to console only |
| `quiet splash` hides the console | panic banner and stack were never visible on screen |

### 8.1 Corrected observability table (`silent` ≠ `panic`)

| Previous-boot end | Signature that actually ended it | Classification |
|---|---|---|
| No last line, freezing until manual power-cycle | panic that `crash_kexec()` entered but the undersized region hung before the 5 s reboot | `silent` (no dump) |
| `mt7921e: driver own failed` / `Timeout for driver own` loop | the MediaTek Wi-Fi driver panic (`mt76_dma_add_buf` page fault, `panic_on_oops=1`) | `mt7921e-timeout` |
| `NVRM … RmCheckForGcxSupport…` storm (>10³ lines) | NVIDIA driver storm | `NVRM-storm` |
| `Kdump: loaded` panic header + `/var/crash/<ts>/` | captured panic — the trace is readable | `panic-dump-available` |
| `Reached target shutdown.target`, `Powering off.` | deliberate reboot/power-off | `clean-shutdown` |

### 8.2 Each layer, verified on this host

- **kdump (only viable path):** reservation fixed; a synthetic panic and two real driver panics
  produced vmcores (`/var/crash/202611011959`, `…12042`, `…12106`). Extraction needs no root and
  no dbgsym kernel: `makedumpfile -R raw < dump.<ts>` then `makedumpfile --dump-dmesg raw --`.
  `makedumpfile` warns the kernel version is unsupported, so the extracted dmesg is the reliable
  artefact (a `crash(8)` session may need dbgsym symbols + a newer makedumpfile).
- **pstore:** confirmed dead end on this firmware — do not spend time on it again.
- **journald:** cannot flush at panic; panic text is console-only. `kernel.panic_print=0xff`
  (`/etc/sysctl.d/99-panic-print.conf`) widens the on-screen trace, and `quiet splash` has been
  dropped from the kernel command line so the console actually shows it.
- **lockups → panics:** `kernel.hardlockup_panic=1` (`/etc/sysctl.d/99-lockup-panic.conf`)
  converts hard lockups into captureable panics; `kernel.panic=5` (`99-panic-autoreboot.conf`)
  makes a panic self-reboot. `softlockup_panic`/`hung_task_panic` left at 0 (they fire on any
  scheduling stall and would turn recoverable hangs into reboot loops; the observed crash class is
  a hard fault, already covered).

### 8.3 Evidence tooling

- `scripts/hostwatch.sh` (+ `install-hostwatch.sh`) — a timer-driven (≤10 s) telemetry sample
  (`HOSTWATCH` journald lines: k10temp/acpitz/MT7921e temps, loadavg, MemAvailable, wlp3s0
  operstate, mt7921e/NVRM error deltas). Follows the `install-memwatch.sh` root-owned install
  pattern.
- `scripts/collect-freeze-evidence.sh` — gathers vmcore/dmesg + last N HOSTWATCH samples + the
  previous-boot kernel tail and writes a `SUMMARY.md` whose first line is the classification
  (the table above). An unrecognised shape **fails** (exit 3) rather than silently reporting
  "unknown".
- `scripts/crash-reporting-check.sh` — health check (apport/whoopsie/kdump/retention/disk); its
  `kdump` block reports config presence, but proof requires a real dump (see 8.2).

### 8.4 Near-real-time diagnosis

Do not wait for the next panic blankly: `scripts/collect-freeze-evidence.sh` after any reboot turns
"what happened?" into a one-line answer within a minute, and the `HOSTWATCH` lines tell you the
machine was alive (temps/load) right up to the fault.

---

## 7. References

- `/etc/default/apport`, `/proc/sys/kernel/core_pattern`, `/etc/cron.daily/apport`
- `/etc/whoopsie`, `/usr/lib/systemd/system/whoopsie.{service,path}`, `/etc/apport/crashdb.conf`
- `/etc/default/kdump-tools`, `/var/lib/kdump/*`, `/var/crash/kexec_cmd`
- Kernel log: `journalctl -k | grep -E "trap int3|NVRM.*Xid"`
- Prior investigations: `docs/dev/chrome-headless-concurrency-memory-profile-investigation.md`, `docs/dev/snapd-udev-monitor-hang-investigation.md`
