# mt7921e → mt76 DMA page-fault panic — canonical trace archive

**Work item:** WL-0MVYAZQEB006HBOP (AC-5 — trace + extraction recipe archived in-repo)
**Host:** ASUS TUF Gaming A15 FA506IE_FA506IE, kernel `7.0.0-38-generic` (Ubuntu 26.04)
**Dumps:** `/var/crash/202611011959` (synthetic SysRq), `/var/crash/202611012042`, `/var/crash/202611012106` (real, 2026-11-01)
**Date:** 2026-11-01

> **Purpose.** A canonical copy of the panic trace, plus the rootless extraction
> recipe, so the next occurrence can be diffed against it in-repo
> (`scripts/collect-freeze-evidence.sh` also runs the same recipe). This is the
> reference signature for the crash register's `mt7921e-timeout` class.

---

## 1. Extraction recipe (no root, no dbgsym, no crash(8))

```bash
# vmcore is world-readable; dmesg.<ts> is 0600 root; makedumpfile does both steps
makedumpfile -R /tmp/raw.dump < /var/crash/202611012042/dump.202611012042
makedumpfile --dump-dmesg /tmp/raw.dump /tmp/dmesg-202611012042.txt
rm -f /tmp/raw.dump
```

`makedumpfile` warns "kernel version is not supported" — the extracted dmesg is
the reliable artefact; a `crash(8)` session may need dbgsym symbols plus a newer
makedumpfile.

---

## 2. Canonical trace (real crash, 2026-11-01 ~20:41:45, boot -2)

```
[ 2516.604897] mt7921e 0000:03:00.0: driver own failed
[ 2517.629784] mt7921e 0000:03:00.0: driver own failed
[ 2518.902860] mt7921e 0000:03:00.0: Timeout for driver own
   ... 10 x ("driver own failed" / "Timeout for driver own") pairs, ~1 s apart ...
[ 2539.381599] mt7921e 0000:03:00.0: Timeout for driver own
[ 2539.381615] mt7921e 0000:03:00.0: chip reset failed
[ 2539.381639] wlp3s0: Driver requested disconnection from AP 18:69:45:ad:24:ab
[ 2539.381642] BUG: unable to handle page fault for address: ffffd55c00250ff0
[ 2539.381644] #PF: supervisor write access in kernel mode
[ 2539.381645] #PF: error_code(0x0002) - not-present page
[ 2539.381647] PGD 100000067 P4D 100000067 PUD 100886067 PMD 1009ff067 PTE 0
[ 2539.381657] Oops: Oops: 0002 [#1] SMP NOPTI
[ 2539.381677] Workqueue: mt76 mt7921_mac_reset_work [mt7921_common]
[ 2539.381688] RIP: 0010:mt76_dma_add_buf.isra.0+0x90/0x200 [mt76]
        Code: ... 41 83 c1 02 48 83 c6 20 <41> 89 18 45 89 78 08 ...
        RAX: 0000000040400000 RBX: 00000000ff6842d0 RCX: 0000000000000000
        RDX: 0000000000000000 RSI: ffffd55c01e77bd8 RDI: ffff8eaecba02928
        RBP: ffffd55c01e77ba0 R08: ffffd55c00250ff0 R09: 0000000000000002
        R10: 00000000004ffeff R11: 0000000000400000 R12: 0000000000000000
        R13: 0000000000000000 R14: 000000000000ffff R15: 0000000000000000
        CR2: ffffd55c00250ff0
[ 2539.381738] Call Trace:
[ 2539.381749]  mt76_dma_tx_queue_skb_raw+0x118/0x1d0 [mt76]
[ 2539.381762]  mt7921_mcu_send_message+0x5a/0x70 [mt7921e]
[ 2539.381768]  mt76_mcu_skb_send_and_get_msg+0x104/0x2b0 [mt76]
[ 2539.381802]  mt76_connac_mcu_uni_add_dev+0x13a/0x1f0 [mt76_connac_lib]
[ 2539.381813]  mt7921_vif_connect_iter+0x47/0xf0 [mt7921_common]
[ 2539.381823]  __iterate_interfaces+0x95/0x130 [mac80211]
[ 2539.381914]  ieee80211_iterate_interfaces+0x3d/0x60 [mac80211]
[ 2539.381983]  mt7921_mac_reset_work+0x13f/0x1f0 [mt7921_common]
[ 2539.381990]  process_one_work+0x1ac/0x3d0
[ 2539.381998]  worker_thread+0x1b8/0x360
```

### Variant (dump 202611012106, 21:06 — same RIP, different path)

Reached via `mt792x_tx_worker` → `mt76_txq_schedule_all` → `mt76_dma_tx_queue_skb`
instead of `mt7921_mac_reset_work` → `mt76_dma_tx_queue_skb_raw`. Identical
faulting instruction and PTE 0 write at `mt76_dma_add_buf.isra.0+0x90`.

---

## 3. Diffing the next occurrence

```bash
grep -nE 'BUG:|Oops|RIP: 0010|Workqueue:|mt7921|mt76_dma' <extracted dmesg> | tail -20
```

Matches `RIP: 0010:mt76_dma_add_buf.isra.0+0x90/0x200 [mt76]` + a supervisor PTE-0
write → same fault. Different RIP inside mt76 → different driver bug — file a new
bug item linked to WL-0MVY88KU8005XFZ4 rather than re-opening this one.

---

## 4. Environment facts for the upstream report (AC-3)

| Fact | Value |
|---|---|
| Kernel | `7.0.0-38-generic` (Ubuntu 26.04) — also `7.0.0-34-generic` installed in /boot |
| Driver stack | `mt7921e` (PCIe 0000:03:00.0), `mt76` / `mt76_connac_lib` / `mt7921_common` in-tree |
| Firmware | `WM Firmware Version: ____010000, Build Time: 20260224110949` |
| ASIC rev | 79610010 |
| Chip details | MT7921 802.11ax; driver logs `HW/SW Version: 0x8a108a10` |
| Config on host | `options mt7921e disable_aspm=1` (ASPM L1 already disabled by driver) |
| Taint | `G O` (out-of-tree NVIDIA modules — unrelated; mt76/mt7921 stack is in-tree) |
| Trigger | firmware hang (`driver own failed` → `Timeout for driver own` ×10 over 23 s) → `chip reset failed` → recovery path faults in `mt76_dma_add_buf` while reconnecting |

---

## 5. Upstream report draft (AC-3) — ready to file

**Filing destinations:** Ubuntu kernel team bug (Launchpad: `ubuntu-bug linux` or
<https://bugs.launchpad.net/ubuntu/+source/linux/+filebug>) and/or
linux-wireless (`netdev` / `wireless` mailing list). Reference this work item
WL-0MVYAZQEB006HBOP and link `/var/tmp`-saved dmesg extracts.

**Subject:** mt7921e: kernel NULL/1 page fault in mt76_dma_add_buf after chip reset fails — Oops 0002, panic_on_oops=1

**Summary**

The MediaTek MT7921e Wi-Fi driver (Ubuntu kernel 7.0.0-38-generic, firmware
WM `____010000` build `20260224110949`) can panic the machine after a firmware
hang. After ~10 repeated `driver own failed` / `Timeout for driver own` failures
over ~23 s, the driver's reset worker (`mt7921_mac_reset_work`) fails to
reinitialise the chip (`chip reset failed`), yet still reconnects the interface
(`mt7921_vif_connect_iter` → `mt76_connac_mcu_uni_add_dev`). During that
recovery, `mt76_dma_add_buf()` writes a TX descriptor through a stale/freed
DMA ring pointer, producing a supervisor write page fault at PTE 0:

```
BUG: unable to handle page fault for address: ffffd55c00250ff0
Oops: Oops: 0002 [#1] SMP NOPTI
RIP: 0010:mt76_dma_add_buf.isra.0+0x90/0x200 [mt76]
Workqueue: mt76 mt7921_mac_reset_work [mt7921_common]
Call Trace: ... mt7921_mac_reset_work+0x13f/0x1f0 [mt7921_common]
```

With `kernel.panic_on_oops=1` the oops becomes a panic (host auto-reboots via
`kernel.panic=5`). The same faulting instruction was observed through two
different call paths in adjacent crashes (reset worker vs `mt792x_tx_worker`),
confirming the fault is in shared `mt76_dma_add_buf` state, not a single
recovery race.

**Repro / frequency:** recurrent freezes for months; MTBF ~24 min just before
mitigation. A vmcore is available on request (543 MB) — see section 2 for the
full trace.

**Suggested investigation:** the DMA ring state used by `mt76_dma_add_buf` is
not being torn down or validated after `chip reset failed`; the reset path
should either abort the reconnect when the ring is invalid, or rebuild the ring
before `mt76_connac_mcu_uni_add_dev` runs.

**Host facts:** ASUS TUF Gaming A15 FA506IE_FA506IE; PCIe 0000:03:00.0; ASIC rev
79610010; `disable_aspm=1` (ASPM L1 off); in-tree driver stack (mt76,
mt76_connac_lib, mt7921_common); kernel taint `G O` from unrelated out-of-tree
NVIDIA modules.
