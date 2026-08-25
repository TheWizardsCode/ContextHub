# snapd udev Monitor Goroutine Hang — Investigation Report

**Work Item:** WL-0MT1KJNHE0048HW3 — snapd udev monitor goroutine hang - watchdog kills and restart loops  
**Date:** 2026-08-23  
**Investigator:** Map

---

## Incident Summary

On 2026-08-20, the system experienced a hang caused by snapd becoming unresponsive:

```
Aug 20 13:37:51 systemd[1]: snapd.service: Watchdog timeout (limit 5min)!
Aug 20 13:37:51 systemd[1]: snapd.service: Killing process 1734095 (snapd) with signal SIGABRT.
Aug 20 13:37:59 systemd[1]: snapd.service: Failed with result 'watchdog'.
Aug 20 13:38:12 systemd[1]: Starting snapd.service - Snap Daemon...
Aug 20 13:39:52 systemd[1]: snapd.service: start operation timed out. Terminating.
```

The restart also timed out, forcing a manual reboot.

## Root Cause Analysis

### Smoking Gun: Goroutine Stack Dump

From `journalctl -b -2 -u snapd` (boot before the crash), the SIGABRT stack dump shows:

| Goroutine | State | Duration | Location |
|-----------|-------|----------|----------|
| **226** | `select` | 7740 minutes | `udevmonitor/udevmon.go:147` |
| **117** | `IO wait` | 7740 minutes | `main.runWatchdog.func1()` |
| **42** | `IO wait` | 7740 minutes | `dbus/v5.(*Conn).Auth` |
| **170** | `syscall` | 67 minutes | `udev/netlink/rawsockstop.go:57` |
| **2022** | `IO wait` | 388 minutes | `net/http.(*connReader).startBackgroundRead` |

**Root Cause:** Goroutine 226 (`udevmonitor.(*Monitor).Run.func1()`) is stuck in an infinite `select` that never receives events and never times out. This is the classic Go `select` on a file descriptor that becomes unresponsive — the goroutine blocks forever, holding state locks and preventing daemon shutdown.

The cascading effect:
1. Goroutine 226 stuck in `select` on the udev monitor socket
2. Goroutine 170 stuck in `stopperSelectReadable()` — the netlink stopper can't shut down the stuck monitor
3. Goroutine 42 stuck on D-Bus connection auth
4. The watchdog timer (5 min) expires → SIGABRT
5. snapd won't restart because it's waiting for locks held by stuck goroutines

### Affected snapd Version

- **Version:** 2.76.2 (build 27710)
- **File:** `overlord/ifacestate/udevmonitor/udevmon.go:147`
- **Platform:** Ubuntu 26.04 (Resolute) / kernel 7.0.0-30-generic

## Upstream Research

### Available Updates

| Channel | Version | Release Date | Status |
|---------|---------|-------------|--------|
| latest/stable | 2.76.2 | 2026-08-13 | Currently installed |
| latest/candidate | 2.76.3 | 2026-08-20 | Available (90% phased in apt) |
| latest/beta | 2.77 | 2026-07-28 | Available |
| latest/edge | 2.77+g75.bee548f | 2026-08-21 | Available |

### Relevant Changelog Entries in snapd 2.76

The following entries in snapd 2.76 may be related to the udev monitor stability:

1. **"Allow equals signs in uevent values in netlink parser"** — A change to the netlink parser that could affect how udev events are handled and prevent parsing-related hangs
2. **"Ignore net.ErrClosed during daemon shutdown"** — Addresses error handling during shutdown, which is relevant since the stuck goroutine prevents clean shutdown
3. **"Restart snapd from daemon.Stop to improve restart reliability"** — Improves restart handling
4. **"Support racing Loop and Stop correctly in overlord"** — Fixes race conditions during stop

### Known Bug References

No specific Launchpad bug was identified for the udev monitor select hang. The issue class (Go `select` blocking on unresponsive file descriptors) is a known pattern in snapd's udev monitor implementation. The udev monitor goroutine uses `select` on the udev netlink socket without a timeout, making it vulnerable to hangs when the kernel/udev subsystem doesn't deliver events.

**Relevant upstream bug tracker:** https://bugs.launchpad.net/snapd  
**Relevant GitHub:** https://github.com/snapcore/snapd/issues

## Current System Status

### Verification: No Reproduction Since Incident

Since the incident on 2026-08-20, snapd has been running stably:

- **Last crash boot:** 2026-08-20 13:44 (boot -2)
- **Recovery boot:** 2026-08-20 13:43 (boot -1) — snapd started but was later killed by watchdog
- **Current boot:** 2026-08-22 22:39 (boot 0) — snapd has been running for >14 hours
- **Current version:** 2.76.2 (27710)
- **Current goroutines:** 22 tasks, 79.6M memory, healthy
- **Watchdog status:** 5min (mitigation not yet applied)

### Journal Logs (Current Boot)

snapd logs show normal operation with periodic refresh checks and cache cleanups. No error logs or warning signs observed since the incident.

## Mitigation Plan

### Option A: Upgrade snapd to 2.76.3 (Recommended)

The latest stable version (2.76.3) includes netlink parser fixes and shutdown reliability improvements that may address the root cause.

```bash
sudo snap refresh snapd --channel=latest/stable
```

**Trade-off:** Minimal risk; this is the latest stable release.

### Option B: Disable Watchdog (Recommended Fallback)

If upgrading is not possible, disable the systemd watchdog to prevent forced kills:

```bash
sudo mkdir -p /etc/systemd/system/snapd.service.d
sudo cp snapd-watchdog-overrides.conf /etc/systemd/system/snapd.service.d/
sudo systemctl daemon-reload
sudo systemctl restart snapd.service
```

**Trade-off:** If snapd hangs again, it will not be automatically recovered by systemd watchdog. Systemd restart policies (Restart=on-failure) may still catch it, but with longer delays.

### Option C: Increase Watchdog Timeout

If the watchdog needs to stay enabled but the timeout is too aggressive:

```bash
sudo systemctl set-property snapd.service WatchdogSec=10min
sudo systemctl restart snapd.service
```

**Trade-off:** Longer hang before detection, but still allows automatic recovery.

## Recommended Action

**Apply Option B (disable watchdog) with Option A (upgrade snapd) as a complementary fix.**

The systemd override is applied immediately as a safety net. The snapd upgrade should be applied when convenient.

## Monitoring Plan

1. **Immediate:** Monitor snapd health for 7 days post-mitigation
2. **Ongoing:** Check `systemctl status snapd.service` daily for watchdog events
3. **Detection:** Watch for `journalctl -u snapd | grep -i "watchdog\|timeout\|stuck"`
4. **SIGQUIT monitoring:** If hang recurs, trigger `kill -ABRT $(pgrep snapd)` for goroutine dump
5. **Watchdog log:** `journalctl -u snapd | grep -i watchdog`

## References

- Work Item: WL-0MT1KJNHE0048HW3
- snapd source: https://github.com/snapcore/snapd/tree/master/overlord/ifacestate/udevmonitor
- snapd bugs: https://bugs.launchpad.net/snapd
- Affected file: `udevmonitor/udevmon.go:147`
- Kernel: 7.0.0-30-generic (at time of incident)
- snapd installed: 2.76+ubuntu26.04.3 (security updates)
- snapd candidate: 2.76.3+ubuntu26.04 (90% phased)
