# Sort_index migration benchmark

## Purpose

Measure the time required to assign `sort_index` values using the migration logic on a hierarchy of work items (up to 1000 items per level).

## How to run

```
npm run benchmark:sort-index -- --level-size 1000 --depth 3 --gap 100
```

### Options

- `--level-size` (default: 1000)
- `--depth` (default: 3)
- `--gap` (default: 100)
- `--auto-export` (default: false)
- `--keep` (default: false)
- `--prefix` (default: BENCH)

## Results

```
Sort-index migration benchmark
- levelSize: 1,000
- depth: 3
- totalItems: 3,000
- gap: 100
- autoExport: false
- updatedItems: 3,000
- durationMs: 604.27
- itemsPerSecond: 4,964.68
- dbPath: /tmp/worklog-sort-index-bench-kp4J2m/worklog.db
- jsonlPath: /tmp/worklog-sort-index-bench-kp4J2m/worklog-data.jsonl
---
{"levelSize":1000,"depth":3,"totalItems":3000,"gap":100,"autoExport":false,"updatedItems":3000,"durationMs":604.27,"itemsPerSecond":4964.68,"dbPath":"/tmp/worklog-sort-index-bench-kp4J2m/worklog.db","jsonlPath":"/tmp/worklog-sort-index-bench-kp4J2m/worklog-data.jsonl","timestamp":"2026-01-29T07:20:16.852Z","keepArtifacts":false}
```

## Environment

- OS: Linux 6.6.87.2-microsoft-standard-WSL2 (x86_64)
- CPU: 11th Gen Intel(R) Core(TM) i7-1185G7 @ 3.00GHz (8 vCPU)
- RAM: 23.3 GB
- Node.js: v25.2.0
- Worklog commit: 5fdfd5a2d8fac1beb29d299f4050f851447d6845

## Notes

- `--auto-export` adds JSONL export overhead, so keep it disabled for pure migration cost.
- Use `--keep` if you need to inspect the generated SQLite DB or JSONL.
