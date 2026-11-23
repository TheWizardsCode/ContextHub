# REST API

Worklog includes an optional REST API server for programmatic access. The API server is only needed if you want to interact with Worklog via HTTP -- the CLI works without it.

## Starting the Server

```bash
npm start
```

The server runs on `http://localhost:3000` by default. It automatically loads data from `.worklog/worklog-data.jsonl` if it exists.

**Note:** The project will automatically build before starting. If you prefer to build manually, run:

```bash
npm run build
npm start
```

## Endpoints

### Work Items

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/items` | Create a work item |
| `GET` | `/items` | List work items (with optional filters) |
| `GET` | `/items/:id` | Get a specific work item |
| `PUT` | `/items/:id` | Update a work item |
| `DELETE` | `/items/:id` | Delete a work item |
| `GET` | `/items/:id/children` | Get children of a work item |
| `GET` | `/items/:id/descendants` | Get all descendants |

### Comments

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/items/:id/comments` | Create a comment on a work item |
| `GET` | `/items/:id/comments` | Get all comments for a work item |
| `GET` | `/comments/:commentId` | Get a specific comment |
| `PUT` | `/comments/:commentId` | Update a comment |
| `DELETE` | `/comments/:commentId` | Delete a comment |

### Data Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/export` | Export data to JSONL |
| `POST` | `/import` | Import data from JSONL |

**Note:** All endpoints also support project prefix routing via `/projects/:prefix/...`

### Audit field on updates

`PUT /items/:id` (and the prefixed variant) accepts an `audit` body field containing structured audit text whose first non-empty line is `Ready to close: Yes` or `Ready to close: No`. The audit is routed to the `audit_results` table (the sole source of truth for audit state). When the verdict is `Ready to close: No` and the item is in `in_review` (status `completed`), the item is automatically reverted to `open`/`plan_complete` (priority preserved) and the response includes a `reverted` field (`{ item, from: { status, stage }, to: { status, stage } }`) — consistent with the CLI audit write paths. See docs/AUDIT_STATUS.md.

## Scheduling: `startOn`

Every work item carries `startOn`, the earliest instant at which it may be
worked on (WL-0MWMGEPY2004EDZ8). The field appears in **every** work-item JSON
surface of this API — the single-item responses of `POST /items`,
`GET /items/:id` and `PUT /items/:id`, and each element of the arrays returned
by `GET /items`, `GET /items/:id/children` and `GET /items/:id/descendants`
(the `/projects/:prefix/...` variants behave identically).

The value is always the **effective** instant, `startOn ?? createdAt`, rendered
as an ISO-8601 UTC string (for example `"2026-11-19T10:25:00.000Z"`). An item
created without an explicit schedule therefore returns its `createdAt` here;
the default is a normal, already-started item, never a hidden or blocked one.

### Writing the field

`POST /items` and `PUT /items/:id` accept `startOn` in the request body:

```bash
curl -X PUT http://localhost:3000/items/WI-ABC123 \
  -H "Content-Type: application/json" \
  -d '{"startOn": "2026-11-19T11:25:00+01:00"}'
```

- A full ISO-8601 timestamp with an explicit timezone is expected. An offset is
  accepted and the stored value is normalised to canonical `...Z` form, so
  `2026-11-19T11:25:00+01:00` and `2026-11-19T10:25:00Z` store identically.
- An empty string clears the field back to the item's `createdAt`.
- Omitting the field on `PUT` keeps the stored value; it is a scheduling-only
  edit that still bumps `updatedAt` so two-way sync propagates it.
- Unlike the CLI's `--start-on`, the REST API does **not** reject an
  unparseable instant. Such a value is preserved verbatim and reads as started
  (fail-open), because discarding scheduling data on write would be worse; the
  CLI's stricter validation remains the authoring path.

### Filtering

`GET /items` does **not** apply the CLI's default not-yet-started filter
(WL-0MWMGET8N009KG33): the API returns scheduled items alongside started ones,
so a consumer that wants the CLI's "workable now" view must compare `startOn`
with the current instant itself (`startOn > now`, with an in-progress item
always counting as started). This is deliberate — a read API should not hide
rows from an integration that is inspecting schedules. The CLI's `--include-not-started`,
`--starts-before` and `start_on_not_reached` claim refusal are CLI-only; see
[CLI.md](CLI.md#scheduling-with-starton).

## Examples

### Create a Work Item

```bash
curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{
    "title": "API test",
    "status": "open",
    "priority": "medium"
  }'
```

### List All Items

```bash
curl http://localhost:3000/items | jq
```

### Using in CI/CD

You can query work items in your CI/CD pipeline:

```yaml
# .github/workflows/check-blockers.yml
name: Check for Blockers

on:
  schedule:
    - cron: '0 9 * * 1-5'  # Weekdays at 9 AM

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build
      - name: Check for blocked items
        run: |
          npm start &
          sleep 5
          BLOCKED=$(curl -s http://localhost:3000/items?status=blocked | jq length)
          if [ "$BLOCKED" -gt 0 ]; then
            echo "Warning: $BLOCKED blocked work items found"
            curl -s http://localhost:3000/items?status=blocked | jq
          fi
```

See [CLI.md](CLI.md) for the command-line interface reference.
