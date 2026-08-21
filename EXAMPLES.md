# Worklog Examples

This document provides practical examples of using the Worklog system.

## CLI Examples

### Creating Work Items

```bash
# Create a root work item
worklog create -t "Build authentication system" -d "Implement user login and registration" -s open -p high --tags "security,backend"

# Create a child work item
worklog create -t "Design database schema" -d "Define user and session tables" -s open -p medium -P WI-0J8L1JQ3H8ZQ2K6D

# Create with minimal info
worklog create -t "Fix bug in login"
```

### Listing and Filtering

```bash
# List all work items
worklog list

# List only root items (no parent)
worklog list --parent null

# Filter by status
worklog list -s in-progress

# Filter by multiple statuses (comma-separated, OR semantics)
worklog list -s open,in-progress
worklog list --status open,completed,blocked

# Filter by priority
worklog list -p high

# Filter by tags
worklog list --tags "backend,api"

# Combine filters
worklog list -s open -p high

# Combine multi-status with stage filter (AND semantics)
worklog list -s open,in-progress --stage in_review
```

### Viewing Work Items

```bash
# Show a specific item
worklog show WI-0J8L1JQ3H8ZQ2K6D

# Show with children
worklog show WI-0J8L1JQ3H8ZQ2K6D -c
```

### Updating Work Items

```bash
# Update status
worklog update WI-0J8L1JQ3H8ZQ2K6D -s in-progress

# Update priority
worklog update WI-0J8L1JQ3H8ZQ2K6D -p critical

# Update multiple fields
worklog update WI-0J8L1JQ3H8ZQ2K6D -s completed -d "Implementation finished and tested"

# Change parent (move in hierarchy)
worklog update WI-0J8L1JQ3H8ZQ2K6F -P WI-0J8L1JQ3H8ZQ2K6E

# Add tags
worklog update WI-0J8L1JQ3H8ZQ2K6D --tags "urgent,reviewed"

# Toggle needs-producer-review flag
worklog reviewed WI-0J8L1JQ3H8ZQ2K6D
# Set needs-producer-review flag explicitly
worklog reviewed WI-0J8L1JQ3H8ZQ2K6D true
```

### Audit Operations

Audit functionality allows you to attach structured readiness metadata to work items. The first line must be either "Ready to close: Yes" or "Ready to close: No".

```bash
# Set audit text on a work item
wl update WI-123 --audit-text "Ready to close: Yes\nAll acceptance criteria verified."

# Set audit from a file (useful for shell scripts)
wl update WI-123 --audit-file audit-report.txt

# Set audit on create
wl create -t "New feature" --audit-text "Ready to close: No\nNeeds code review"

# View audit via show --json
wl show WI-123 --json
# Returns: workItem.audit = { text, author, time, status }
# Returns: workItem.auditResult = { readyToClose, summary, auditedAt, author }
```

### Tolerant ID Resolution

`wl show` tolerates truncated, case-differing, or partial ID references:

```bash
# Full ID — works as before
wl show WI-123

# Partial ID — resolves if unique
wl show WI-1
# → Returns WI-123 (unique substring match)

# Case-insensitive substring
wl show wi-1
# → Returns WI-123

# Ambiguous — multiple items match
wl show WI-
# → {"success": false, "error": "ambiguous-match", "candidates": ["WI-123", "WI-456"]}

# Strict exact match only (skip substring)
wl show --exact WI-1
# → Error: Work item not found (no exact match)
```

### Deleting Work Items

```bash
# Delete a work item
worklog delete WI-0J8L1JQ3H8ZQ2K6G
```

### Import/Export

```bash
# Export to a specific file
worklog export -f backup-2024-01-23.jsonl

# Import from a file
worklog import -f backup-2024-01-23.jsonl
```

## API Examples

### Using curl

```bash
# Health check
curl http://localhost:3000/health

# List all work items
curl http://localhost:3000/items

# Get a specific work item
curl http://localhost:3000/items/WI-0J8L1JQ3H8ZQ2K6D

# Create a new work item
curl -X POST http://localhost:3000/items \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implement caching",
    "description": "Add Redis caching layer",
    "status": "open",
    "priority": "medium",
    "tags": ["performance", "backend"]
  }'

# Update a work item
curl -X PUT http://localhost:3000/items/WI-0J8L1JQ3H8ZQ2K6D \
  -H "Content-Type: application/json" \
  -d '{
    "status": "in-progress"
  }'

# Delete a work item
curl -X DELETE http://localhost:3000/items/WI-0J8L1JQ3H8ZQ2K6D

# Get children of a work item
curl http://localhost:3000/items/WI-0J8L1JQ3H8ZQ2K6D/children

# Get all descendants
curl http://localhost:3000/items/WI-0J8L1JQ3H8ZQ2K6D/descendants

# Filter by status
curl "http://localhost:3000/items?status=open"

# Filter by priority
curl "http://localhost:3000/items?priority=high"

# Filter by parent (root items only)
curl "http://localhost:3000/items?parentId=null"

# Export data
curl -X POST http://localhost:3000/export \
  -H "Content-Type: application/json" \
  -d '{"filepath": "backup.jsonl"}'

# Import data
curl -X POST http://localhost:3000/import \
  -H "Content-Type: application/json" \
  -d '{"filepath": "backup.jsonl"}'
```

### Using JavaScript/Node.js

```javascript
// Create a work item
const response = await fetch('http://localhost:3000/items', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: 'Add user profile page',
    description: 'Create a page to display user information',
    status: 'open',
    priority: 'medium',
    tags: ['frontend', 'ui']
  })
});
const newItem = await response.json();
console.log('Created:', newItem.id);

// Get all open items
const openItems = await fetch('http://localhost:3000/items?status=open')
  .then(res => res.json());
console.log(`Found ${openItems.length} open items`);

// Update an item
await fetch(`http://localhost:3000/items/${newItem.id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'in-progress' })
});
```

## Automation & Scripting Examples

### Shell Script: Run Audit and Parse JSON Output

```bash
#!/bin/bash
# audit-work-item.sh - Run an audit on a work item and check results

WORK_ITEM_ID="$1"

if [ -z "$WORK_ITEM_ID" ]; then
  echo "Usage: $0 <work-item-id>"
  exit 1
fi

# Run audit and get JSON output
AUDIT_RESULT=$(wl show "$WORK_ITEM_ID" --json)

if [ $? -ne 0 ]; then
  echo "Error: Failed to show work item"
  exit 1
fi

# Parse audit status using jq
AUDIT_STATUS=$(echo "$AUDIT_RESULT" | jq -r '.workItem.audit.status // "none"')
AUDIT_TEXT=$(echo "$AUDIT_RESULT" | jq -r '.workItem.audit.text // "none"')
READY_TO_CLOSE=$(echo "$AUDIT_RESULT" | jq -r '.workItem.auditResult.readyToClose // false')

echo "Work Item: $WORK_ITEM_ID"
echo "Audit Status: $AUDIT_STATUS"
echo "Ready to Close: $READY_TO_CLOSE"
echo "Audit Text: $AUDIT_TEXT"

# Exit with appropriate code
if [ "$READY_TO_CLOSE" = "true" ]; then
  exit 0  # Ready to close
else
  exit 1  # Not ready
fi
```

### Shell Script: Set Audit via Automation

```bash
#!/bin/bash
# set-audit.sh - Set audit text on a work item from automation

WORK_ITEM_ID="$1"
AUDIT_STATUS="$2"  # "yes" or "no"
DETAILS="$3"

if [ -z "$WORK_ITEM_ID" ] || [ -z "$AUDIT_STATUS" ]; then
  echo "Usage: $0 <work-item-id> <yes|no> [details]"
  exit 1
fi

# Build audit text
if [ "$AUDIT_STATUS" = "yes" ]; then
  FIRST_LINE="Ready to close: Yes"
else
  FIRST_LINE="Ready to close: No"
fi

AUDIT_TEXT="$FIRST_LINE"
if [ -n "$DETAILS" ]; then
  AUDIT_TEXT="$AUDIT_TEXT\n$DETAILS"
fi

# Set audit via CLI
RESULT=$(wl update "$WORK_ITEM_ID" --audit-text "$AUDIT_TEXT" --json)

if [ $? -ne 0 ]; then
  echo "Error: Failed to set audit"
  exit 1
fi

# Verify the audit was set
VERIFY=$(wl show "$WORK_ITEM_ID" --json | jq -r '.workItem.audit.status')
echo "Audit status set to: $VERIFY"
```

### Node.js: Read Audit Field Programmatically

```javascript
import { execSync } from 'child_process';

// Get audit data for a work item
function getAuditData(workItemId) {
  const result = execSync(`wl show ${workItemId} --json`, {
    encoding: 'utf-8'
  });
  const data = JSON.parse(result);
  
  return {
    // Backwards-compatible format
    audit: data.workItem?.audit,
    // Normalized format
    auditResult: data.workItem?.auditResult
  };
}

// Check if work item is ready to close
function isReadyToClose(workItemId) {
  const { auditResult } = getAuditData(workItemId);
  return auditResult?.readyToClose ?? false;
}

// Example usage
const auditData = getAuditData('WI-123');
console.log('Audit text:', auditData.audit?.text);
console.log('Status:', auditData.audit?.status);
console.log('Ready to close:', auditData.auditResult?.readyToClose);
```

## Git Workflow Example

```bash
# 1. Create some work items
worklog create -t "Feature: User profiles" -s open -p high
worklog create -t "Design profile layout" -P WI-0J8L1JQ3H8ZQ2K6D
worklog create -t "Implement profile API" -P WI-0J8L1JQ3H8ZQ2K6D

# 2. Commit to Git
git add .worklog/worklog-data.jsonl
git commit -m "Add user profile work items"

# 3. Push to share with team
git push origin main

# 4. Team member pulls and updates
git pull origin main
worklog update WI-0J8L1JQ3H8ZQ2K6E -s in-progress

# 5. Commit the update
git add .worklog/worklog-data.jsonl
git commit -m "Start working on profile layout"
git push origin main
```

## Sample Hierarchy

Here's an example of creating a hierarchical project structure:

```bash
# Create epic
worklog create -t "MVP Release" -d "First production release" -s open -p critical

# Create features under the epic
worklog create -t "User Management" -P WI-0J8L1JQ3H8ZQ2K6D -s open -p high
worklog create -t "Dashboard" -P WI-0J8L1JQ3H8ZQ2K6D -s open -p high
worklog create -t "Reporting" -P WI-0J8L1JQ3H8ZQ2K6D -s open -p medium

# Create tasks under features
worklog create -t "User registration" -P WI-0J8L1JQ3H8ZQ2K6E -s open -p high
worklog create -t "User login" -P WI-0J8L1JQ3H8ZQ2K6E -s open -p high
worklog create -t "Password reset" -P WI-0J8L1JQ3H8ZQ2K6E -s open -p medium

worklog create -t "Dashboard layout" -P WI-0J8L1JQ3H8ZQ2K6F -s open -p high
worklog create -t "Dashboard widgets" -P WI-0J8L1JQ3H8ZQ2K6F -s open -p medium

# List root items to see the hierarchy
worklog list --parent null

# View a feature with its tasks
worklog show WI-0J8L1JQ3H8ZQ2K6E -c
```

This creates a structure like:
```
WI-0J8L1JQ3H8ZQ2K6D: MVP Release (epic)
├── WI-0J8L1JQ3H8ZQ2K6E: User Management (feature)
│   ├── WI-0J8L1JQ3H8ZQ2K6G: User registration (task)
│   ├── WI-0J8L1JQ3H8ZQ2K6H: User login (task)
│   └── WI-0J8L1JQ3H8ZQ2K6I: Password reset (task)
├── WI-0J8L1JQ3H8ZQ2K6F: Dashboard (feature)
│   ├── WI-0J8L1JQ3H8ZQ2K6J: Dashboard layout (task)
│   └── WI-0J8L1JQ3H8ZQ2K6K: Dashboard widgets (task)
└── WI-0J8L1JQ3H8ZQ2K6L: Reporting (feature)
```
