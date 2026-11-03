# Host Freeze Remediation Runbook — ASUS TUF Gaming A15 FA506IE

**Work Item:** WL-0MVY89AYG005DKLG
**Parent:** WL-0MVY88KU8005XFZ4 — *Recurring total machine freezes with blinking caps-lock LED — RCA and hardware remediation*
**Date:** 2026-11-01
**Status:** Re-scoped 2026-11-01 after the root cause was proven from a vmcore.

> **Read this first (2026-11-01 correction).** The recurring "total freezes with a blinking caps-lock
> LED" are **kernel panics caused by the MediaTek `mt7921e` Wi-Fi driver** — proven from
> `/var/crash/202611012042` (mt76 DMA page fault in `mt7921_mac_reset_work`), **not** a
> hardware/firmware freeze. The caps-lock blink is the Linux panic LED loop, and the mitigation
> (blacklist `mt7921e`, host now Ethernet-only) is already applied and verified (see
> WL-0MVYAZQEB006HBOP). Everything in this runbook is therefore **second-order stability work** —
> it addresses degraded cooling, an outdated BIOS and a weak battery, but **none of it is the fix for
> the freezes**. Do not act on these steps until (a) the 24 h durability check (WL-0MVYEQKAM003THSP)
> has passed and (b) a real panic trace has been read, as instructed by the parent epic.
>
> **Gate (a) is now satisfied.** The 24 h durability check reported
> `VERIFY-COMPLETE verdict=PASS` at 2026-11-02T21:08:21Z (uptime 86 481 s, unchanged boot id, no new
> vmcore) — evidence in `/var/tmp/mt7921-verify-24h.*`, recorded in §6 of
> [`mt7921e-mt76-panic-trace.md`](./mt7921e-mt76-panic-trace.md). Steps 4–7 below are therefore
> unblocked.

---

## 1. Summary & ordering (do these first)

| # | Step | Type | Expected time | Downtime | Cost | Verifies |
|---|------|------|---------------|----------|------|----------|
| 0 | Record the caps-lock blink code | observation, free | 1 min | none | £0 | subsystem implicated at crash |
| 1 | Evidence capture after the next freeze | read-only | 10 min | none | £0 | crash trace (sibling item) |
| 2 | Re-measure temperatures (baseline) | read-only | 1 min | none | £0 | thermal degradation vs after-service |
| 3 | **Held while the mt7921e blacklist window runs** (thermals/BIOS/battery) | — | 24 h–7 d | — | — | avoids confounding the mitigation |
| 4 | memtest86+ overnight | diagnostic | 8–12 h | yes | £0 | memory integrity |
| 5 | BIOS update (FA506IE.302 → newer) | firmware | 30 min | yes (mains) | £0 | SBIOS/EC thermal handshake |
| 6 | Thermal service (re-paste + clean) | hardware | 1–2 h | yes | ~£10 paste | idle temperature change |
| 7 | Battery replacement | hardware | 30 min | yes | ~£60 | battery sag vs thermal cut-out |

> **Order rationale.** Every step before #4 is free, reversible and non-destructive, so it can be done
> immediately. Steps 4–7 require a reboot or physical work and must be sequenced **after** the
> 24 h durability window (2026-11-02 21:08) so a deliberate interruption cannot invalidate the
> blacklist evidence; they are ranked cheap→expensive so the operator never spends money before a
> free diagnostic has ruled a cause in or out. Each block below follows
> **pre-condition → action → verification → rollback**.

---

## 2. Step 0 — Record the caps-lock blink code (the single most valuable observation)

**Pre-condition:** the machine is frozen/unresponsive; you are physically present.

**Action**
1. Photograph or video the keyboard — specifically the caps-lock LED — for ≥ 30 s.
2. Record on paper/notes: the **count of blinks per group**, the **pause between groups** (s), the
   **number of repeats**, and whether the pattern is constant.
3. Note the time, and any smell/heat (hot spots under the machine), and whether the fans spun up
   just before the freeze.
4. Log the observation in the parent epic WL-0MVY88KU8005XFZ4 (or the freeze-forensics item
   WL-0MVY898D4007BZ28) as a comment.

**Why it matters:** on this host the ~1 blink / 0.5 s steady pattern is the **Linux kernel panic LED
loop** — it tells you the machine reached `panic()`, not that the EC is failing. A *different*
blink code (e.g. long/short groups) is the ASUS EC fault signalling and would indicate a different,
firmware-level, subsystem — capturing it distinguishes the two. This is now a supporting observation,
not the primary diagnosis: the primary is the vmcore trace.

**Verification:** you can state the blink pattern and whether it matches the panic loop (≈1 blink /
0.5 s steady, no pauses).

**Rollback:** none (observation only).

---

## 3. Step 1 — Evidence capture after the next freeze

**Pre-condition:** a freeze has just happened and the machine is back up (auto-reboot with
`kernel.panic=5`, or a manual power-cycle). Work is saved elsewhere.

**Action**
```bash
scripts/collect-freeze-evidence.sh --out ~/freeze-evidence-$(date +%Y%m%d)
```
This gathers: any vmcore + its crash dmesg (extracted **without root** via `makedumpfile`), the last
40 `HOSTWATCH` telemetry samples (temps/load/MemAvailable up to the fault), the previous-boot kernel
tail, and a classification (`panic-dump-available` / `mt7921e-timeout` / `NVRM-storm` / `silent` /
`clean-shutdown`) whose first line is `SUMMARY.md`. Then read the trace:

```bash
grep -nE 'BUG:|Oops|RIP: 0010|Workqueue:|mt7921|mt76_dma' ~/freeze-evidence-*/crash-dmesg.txt | tail -20
```

**Verification:** `SUMMARY.md` first line states a classification (not "unknown" — the script fails
loudly on unrecognised evidence).

**Rollback:** none (read-only bundle). Delete `~/freeze-evidence-*` if not wanted.

---

## 4. Step 2 — Re-measure temperatures (baseline before any thermal work)

**Pre-condition:** host idle > 15 min (no load, laptop lid closed/external display not required).

**Action**
```bash
cat /sys/class/thermal/thermal_zone0/temp        # acpitz:  74000 → 74.0 °C (idle, 2026-11-01)
cat /sys/class/hwmon/hwmon7/temp1_input          # k10temp: 70000 → 70.0 °C (idle, 2026-11-01)
nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader   # 56 °C idle
```

**Verification:** record k10temp + acpitz before thermal service. Idle 70–74 °C is abnormal on this
host and is the number any service must improve (target: < 60 °C idle).

**Rollback:** none (read-only).

---

## 5. Step 3 — Hold thermal/BIOS/battery work during the blacklist window

**Pre-condition:** the 24 h durability check (WL-0MVYEQKAM003THSP) has **not yet passed** —
*resolved: it passed at 2026-11-02 21:08 (`VERDICT: PASS`), so this hold no longer applies*.

**Action:** explicitly do **not** reboot, do **not** flash BIOS, do **not** open the chassis,
do **not** run memtest until the check completes at **2026-11-02 21:08** and the migration is
verified. Any of those reboots would kill the running durability watcher (PID 370950) and reset the
boot-id/uptime evidence the check depends on.

**Why:** the blacklist mitigation is the *cure under test*; a reboot now invalidates the test and
confounds attribution. The hold is time-boxed to ≤ 7 days.

**Verification:** `ps -p 370950` shows the watcher alive; `cat /proc/sys/kernel/random/boot_id`
unchanged (`e11d0dbe-1b4b-47c5-988a-b0142a3ad15e`).

**Rollback:** n/a — the hold is passive.

---

## 6. Step 4 — Overnight memtest86+ (rule out non-ECC memory corruption)

**Pre-condition:** a reboot is approved (post-24 h window); no work unsaved; the run will last 8–12 h.

**Action**
1. Reboot into the GRUB menu (hold Shift/Esc at POST).
2. Choose *memtest86+* (Ubuntu installs it via `memtest86+`; if absent: `sudo apt install memtest86+`
   then `sudo update-grub`).
3. Let it run overnight. A result is a pass after **4 full passes** (`PASS` counter ≥ 4) or any
   failing address reported.

**Why:** non-ECC DDR4 can corrupt silently with no MCE record, masquerading as an intermittent
driver/hardware fault. The observed freezes already have a driver-level root cause, so this is a
consistency check — a memtest failure would escalate (replace the stick) before hardware work.

**Verification:** test log shows ≥ 4 passes with zero errors.
**Rollback:** reboot out of memtest; nothing is installed if you never enabled the entry.

---

## 7. Step 5 — BIOS update (FA506IE.302, 2022-12-28 → newer)

**Pre-condition:** ❗**Hard gate** — verify the model **before** downloading anything. Flashing the
wrong variant bricks the unit.

```bash
cat /sys/class/dmi/id/product_name        # expect: ASUS TUF Gaming A15 FA506IE_FA506IE
cat /sys/class/dmi/id/product_version     # expect: 1.0
cat /sys/class/dmi/id/bios_version        # expect: FA506IE.302
cat /sys/class/dmi/id/bios_date           # expect: 12/28/2022
```

**Action**
1. Find the exact model on Asus support: search **TUF Gaming A15 FA506IE** (note: "TUF A15" alone is
   ambiguous — several variants share the name; the DMI string `FA506IE_FA506IE` is authoritative).
   Prefer the ASUS Support Downloads page, model selector, *Drivers & Tools → BIOS & FIRMWARE*.
2. Download the newest BIOS for **FA506IE** specifically. Match the variant (e.g. FA506IE vs FA506IEB
   differ); never flash a `.302`-lineage file for a different board revision.
3. Run the bundled EZ Flash (inside the AsusWinFlash app, or the UEFI EZ Flash tool from a FAT32
   USB stick) on **AC power with battery ≥ 60 %**, nothing else running, display plugged in.
4. Do **not** interrupt (no key presses, no power loss) — a failed flash bricks the unit.

**Verification:** boot to POST, then `cat /sys/class/dmi/id/bios_version` shows the new version.
**Rollback / recovery:** if the flash fails and the unit does not POST, use the **CrashFree BIOS 3**
recognition built into this board: name the downloaded file `FA506IE.CAP`-style (per the official
instructions) on a FAT32 USB root and boot with it inserted — the UEFI will attempt a recovery flash.
Record the outcome on the runbook item before and after.

**Why the BIOS matters here:** the installed firmware logs SBIOS/EC handshake failures at boot —
`NVRM: … failed to get target temp from SBIOS` and `ACPI BIOS Error (bug): Could not resolve symbol
[_TZ.THRM._SCP.CTYP]`. Those point at a broken thermal handshake between the EC and the northbridge/
NVIDIA stack, consistent with the degraded thermal measurements. A newer BIOS may fix or improve that
interface — but it is **not** the freeze cause (the driver panic is).

---

## 8. Step 6 — Thermal service (re-paste + clean)

**Pre-condition:** BIOS step done or skipped; a reboot window exists; mains power present; warranty
position accepted (opening the unit may void it — check before proceeding).

**Action**
1. Shut down, unplug **both** the AC adapter and the battery connector (TUF A15: unclip the battery
   harness — see the official service manual; a wrong pull damages the connector).
2. Open the rear cover; clean the intake/exhaust fins and fans with compressed air (hold the fans
   still).
3. Remove the heat sink; clean old paste from CPU/GPU dies; apply fresh thermal paste (small blob,
   spread thin; non-conductive type). **Do not over-apply**.
4. Reassemble in reverse.

**Verification:** after overnight idle, re-run the Step 2 thermometer commands — target k10temp
< 60 °C idle (from 70 °C) and acpitz < 60 °C (from 74 °C).

**Rollback:** re-paste can be re-done; if temperatures do not improve, the cooler assembly may need
replacement (cost ~£20–40).

---

## 9. Step 7 — Battery replacement

**Pre-condition:** a thermal/memory/BIOS cause is ruled out or you want the sag test done while the
battery is disconnected; a new battery (model **A32-K55**) is available (~£60).

**Action**
1. Record current health first:
   ```bash
   cat /sys/class/power_supply/BAT1/charge_full /sys/class/power_supply/BAT1/charge_full_design
   # 2026-11-01: 2401000 / 4110000 → 58 % of design
   ```
2. **Sag test (no spend):** run on AC power only (battery physically disconnected) for a defined
   period (≥ 48 h or ≥ 3× the crash MTBF, whichever is longer) and compare against the crash
   register. If the host is stable on AC-only and freezes return on battery, the pack is implicated.
   If it freezes on AC too, the battery is ruled out (save the money).
3. Replace only if the sag test implicates the pack: new **A32-K55**, installed with the same
   battery-harness care as Step 6.

**Verification:** `charge_full` > 85 % of design after a full charge; no battery-attributed freezes
across the test window.
**Rollback:** refit the old battery; the host works on AC regardless.

---

## 10. Decision table (map observation → next action)

| Observation | Meaning | Next action |
|---|---|---|
| Caps-lock blink ≈ 1 / 0.5 s steady; vmcore shows mt76/mt7921 | Driver panic (known cause) | Keep blacklist; track upstream fix (WL-0MVYAZQEB006HBOP AC-3) |
| Caps-lock blink **different** pattern | EC firmware code | Photograph it; open a new item against the EC/BIOS (do not assume driver) |
| vmcore trace shows NVRM storm | GPU driver | Fix/upgrade NVIDIA driver; keep GPU texconv quiesced |
| Idle k10temp stays ≥ 70 °C after service | Cooling still degraded | Re-check heatsink seating; try new cooler assembly |
| memtest fails ≥ 1 address | RAM fault | Replace the module; re-run memtest before trusting host |
| Battery sag test (AC-only stable vs battery freezes) | Pack implicated | Replace A32-K55 |
| No freeze for 7+ days on blacklist, all checks pass | Mitigation holds | Close epic WL-0MVY88KU8005XFZ4 on measured stability |
| 24 h check FAILs with a new mt76 dump | Mitigation broken | Re-open WL-0MVYAZQEB006HBOP; kernel A/B to 7.0.0-34; escalate |

---

## 11. Cross-references

- Sibling items: WL-0MVY898D4007BZ28 (freeze forensics — evidence capture, HOSTWATCH, crash
  reporting), WL-0MVYAZQEB006HBOP (host panic root cause), WL-0MVY89BGN008TX7X (MT7921e isolation
  experiment, superseded as an experiment), WL-0MVYEQKAM003THSP (24 h durability check).
- `docs/dev/crash-reporting.md` — corrected observability story (kdump, panic blink, telemetry).
- Authoritative DMI facts captured 2026-11-01 on the host (`/sys/class/dmi/id/*`).
