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
