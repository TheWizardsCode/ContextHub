Planning Complete. The epic **Slow down investigation** (WL-0MNAGHQ33005BVY6) has been broken into the following feature work items:

1. Add performance instrumentation (WL-0MNAL4SSQ003DFU2)
2. Create benchmark harness (WL-0MNAL6OXK0072IGQ)
3. Prototype incremental rendering (WL-0MNAL79K20048STX)
4. Full virtualization of work‑item tree (WL-0MNAZFD1H004IKKN)
5. Async JSONL export / background refresh (WL-0MNAZFYP10068XLV)
6. Regression test suite for TUI performance (WL-0MNAZGIOM002DFVQ)

**Appendix – Open Questions**

- Q: Should Feature 3 (Prototype incremental rendering) depend on Features 1 (Instrumentation) and 2 (Benchmark)?
  - A: *Open* – pending clarification.
- Q: Is Feature 4 (Full virtualization of work‑item tree) too large and should it be split into separate implementation and UI‑integration tasks?
  - A: *Open* – pending clarification.
- Q: Are there negative test cases needed for the acceptance criteria of any feature (e.g., ensuring latency spikes are caught, regressions for non‑targeted UI paths)?
  - A: *Open* – pending clarification.
