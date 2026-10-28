## Global agent guidance

Read the global agent instructions at `~/.pi/agent/AGENTS.md` — they define the core principles, the Worklog (wl) work-item workflow, and the coding disciplines that apply to every project. That file is installed from this repository's `AGENTS_GLOBAL.md` by `scripts/install_pi.sh`, which symlinks it into place.

## Project-specific guidance

### Claim pattern & scheduling hold (WL-0MV82CHGQ000HAZZ)

The assignee field doubles as the scheduling hold. Implement/plan/intake tiers
claim with a status flip (`wl update <id> --status in_progress --assignee
<agent>`); the herdr **audit tier** claims **status-neutrally** — assignee CAS
only (`wl update <id> --assignee <agent> --if-status completed --if-stage
in_review --if-assignee ""`), so the item stays `completed`/`in_review`. A
non-empty assignee is an intentional hold from auto-dispatch (producer sentinel
`wl update <id> --assignee Map`; clear `--assignee ""` to release); claims
clear the assignee on session end. An all-held dispatch window is surfaced
**read-only** in the worklist (header count + warning banner; never clears a
hold, never changes dispatch — WL-0MVR8FN1D002SCIR). See
[docs/dev/downtime-dispatcher.md](./docs/dev/downtime-dispatcher.md) and the
global instructions (`~/.pi/agent/AGENTS.md`).

### Architecture Notes for Agents

Worklog uses **SQLite as the runtime source of truth** with an **ephemeral JSONL pattern** for Git sync:

- **SQLite** (`.worklog/worklog.db`): All runtime reads/writes happen here
- **JSONL** (`.worklog/worklog-data.jsonl`): Only exists transiently during sync operations
- **Git**: Persistent storage for collaboration

#### Important Rules for Agents

1. **Work with SQLite, not JSONL**
   - Never manually edit JSONL files
   - Use the database API for all data operations
   - JSONL is only for Git transport, not for data manipulation

2. **Migration Complete**
   - The old `autoExport` feature has been removed
   - No automatic JSONL exports after database writes
   - TUI is now responsive regardless of data size

3. **Sync Behavior**
   - `wl sync` exports SQLite → JSONL → pushes to Git → deletes local JSONL
   - JSONL only exists during the sync window (seconds)
   - Working directory should not have persistent JSONL files

4. **Legacy JSONL Files**
   - If you encounter a persistent JSONL file, it may be from an older version
   - Use `wl doctor migrate` to import it into SQLite
   - Use `wl doctor migrate --delete` to import and remove the file

For more information, see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).