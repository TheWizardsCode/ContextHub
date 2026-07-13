#!/usr/bin/env python3
"""
Heartbeat skill for automated work item monitoring.

Invocation: /skill:heartbeat

Behavior:
1. Get count of completed/in_review work items
2. If count < 10: call wl next, flag next item for producer review
3. If count >= 10: audit first non-ready item (by sortIndex)
4. If all items have "Ready to close: Yes", report ready
"""

import json
import subprocess
import sys


def run_wl(args):
    """Run a wl command and return parsed JSON output.

    Args:
        args: List of command arguments (e.g., ['list', '--status', 'completed', '--json'])

    Returns:
        Parsed JSON dict from wl stdout.

    Raises:
        RuntimeError: If the wl command fails (non-zero exit code).
        json.JSONDecodeError: If wl output is not valid JSON.
    """
    cmd = ['wl'] + args
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"wl command failed: {' '.join(cmd)}\n"
            f"stderr: {result.stderr}"
        )
    return json.loads(result.stdout)


def get_audit_result(item_id):
    """Get the audit raw output for a work item.

    Args:
        item_id: The work item ID.

    Returns:
        The rawOutput string from the audit, or None if no audit exists
        or the audit-show call fails.
    """
    try:
        data = run_wl(['audit-show', item_id, '--json'])
        audit = data.get('audit')
        if audit and audit.get('rawOutput'):
            return audit['rawOutput']
    except (RuntimeError, json.JSONDecodeError):
        pass
    return None


def is_ready_to_close(raw_output):
    """Check whether an audit result indicates the item is ready to close.

    Args:
        raw_output: The rawOutput string from wl audit-show, or None.

    Returns:
        True if raw_output starts with 'Ready to close: Yes' (ignoring
        leading/trailing whitespace), False otherwise.
    """
    if not raw_output:
        return False
    stripped = raw_output.strip()
    return stripped.startswith('Ready to close: Yes')


def check_queue():
    """Main heartbeat decision logic.

    Returns:
        A human-readable string summarizing the action taken (or error).

    This function does NOT raise exceptions on wl failures — it catches
    RuntimeError and returns an error string.
    """
    try:
        # Step 1: Get count of completed/in_review items
        data = run_wl(['list', '--status', 'completed', '--stage', 'in_review', '--json'])
        items = data.get('workItems', [])
        count = len(items)

        if count == 0:
            return "No items in completed/in_review queue."

        if count < 10:
            # Sparse queue — flag next item for producer review
            next_data = run_wl(['next', '--json'])
            next_item = next_data.get('workItem')
            if next_item:
                item_id = next_item['id']
                item_title = next_item.get('title', item_id)
                run_wl(['update', item_id, '--needs-producer-review', 'true', '--json'])
                return (
                    f"Flagged {item_title} ({item_id}) for producer review.\n"
                    f"Queue has {count} completed/in_review items (below threshold of 10)."
                )
            else:
                return "No next item found to flag for review."
        else:
            # Full queue — find first non-ready item by sortIndex
            items_sorted = sorted(items, key=lambda x: x.get('sortIndex', 0) or 0)

            for item in items_sorted:
                item_id = item['id']
                item_title = item.get('title', item_id)
                raw_output = get_audit_result(item_id)
                if not is_ready_to_close(raw_output):
                    # Run audit on this item via the audit runner script
                    audit_script = (
                        '/home/rgardler/.pi/agent/skills/audit/scripts/audit_runner.py'
                    )
                    audit_cmd = [
                        sys.executable or 'python3',
                        audit_script,
                        'issue',
                        item_id,
                    ]
                    audit_result = subprocess.run(
                        audit_cmd, capture_output=True, text=True
                    )
                    if audit_result.returncode != 0:
                        return (
                            f"Audit failed for {item_title} ({item_id}):\n"
                            f"{audit_result.stderr}"
                        )
                    return (
                        f"Running audit on {item_title} ({item_id})...\n"
                        f"Audit completed for {item_id}."
                    )

            # All items ready
            return "Project is ready for producer review prior to a new release."

    except RuntimeError as e:
        return f"Heartbeat error: {e}"
    except json.JSONDecodeError as e:
        return f"Heartbeat error: Invalid JSON from wl command: {e}"


def main():
    """Entry point for command-line invocation."""
    result = check_queue()
    print(result)
    if result.startswith('Heartbeat error'):
        sys.exit(1)


if __name__ == '__main__':
    main()
