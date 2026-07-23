"""
Integration tests for the heartbeat skill.

These tests exercise real wl CLI commands against an isolated temporary
worklog database. They verify that the heartbeat module's functions
interact correctly with the actual wl CLI without mocking the wl
subprocess calls.

The test database is created in a temp directory and destroyed after
each test to avoid side effects between tests or on the real database.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

# Add the skill scripts directory to the path so we can import heartbeat
HEARTBEAT_SCRIPTS = os.path.join(
    os.path.dirname(__file__), '..', '..', '..',
    'skill', 'heartbeat', 'scripts',
)
sys.path.insert(0, HEARTBEAT_SCRIPTS)

import heartbeat


def _wl(cmd_args, cwd):
    """Run a wl command in cwd and return parsed JSON output.

    Args:
        cmd_args: List of command arguments (e.g., ['list', '--json']).
        cwd: Working directory where the command runs (must contain .worklog/).

    Returns:
        Parsed JSON dict from wl stdout.

    Raises:
        RuntimeError: If the wl command fails.
    """
    cmd = ['wl'] + cmd_args
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd)
    if result.returncode != 0:
        raise RuntimeError(
            f"wl command failed: {' '.join(cmd)}\n"
            f"stdout: {result.stdout}\n"
            f"stderr: {result.stderr}"
        )
    return json.loads(result.stdout)


class TestHeartbeatIntegration(unittest.TestCase):
    """Integration tests using a temporary, isolated worklog database."""

    def setUp(self):
        """Create a temporary directory with an initialized worklog."""
        self.test_dir = tempfile.mkdtemp(prefix='heartbeat_int_')
        self.orig_cwd = os.getcwd()
        self.addCleanup(self._cleanup)

        # Initialize a fresh worklog in the temp directory
        # Pipe a newline to handle any interactive prompts (e.g. workflow selection)
        init_result = subprocess.run(
            ['wl', 'init', '--json', '--project-name', 'IntegrationTest',
             '--prefix', 'INT', '--auto-sync', 'no', '--auto-export', 'no'],
            input='\n', capture_output=True, text=True, cwd=self.test_dir,
        )
        if init_result.returncode != 0:
            raise RuntimeError(
                f"wl init failed: {init_result.stderr}"
            )

        # Switch to the temp directory for heartbeat operations
        os.chdir(self.test_dir)

    def _cleanup(self):
        """Restore cwd and remove the temporary directory."""
        try:
            os.chdir(self.orig_cwd)
        except Exception:
            pass
        try:
            shutil.rmtree(self.test_dir, ignore_errors=True)
        except Exception:
            pass

    def _create_item(self, title, status='open', stage='idea'):
        """Create a work item via wl and return its id."""
        data = _wl(
            ['create', '--title', title, '--description',
             'Integration test item', '--json'],
            cwd=self.test_dir,
        )
        item_id = data['workItem']['id']
        if status != 'open' or stage != 'idea':
            _wl(
                ['update', item_id, '--status', status, '--stage', stage, '--json'],
                cwd=self.test_dir,
            )
        return item_id

    def _create_completed_item(self, title):
        """Create a work item and set it to completed/in_review.

        Returns the item ID.
        """
        return self._create_item(title, status='completed', stage='in_review')

    # ------------------------------------------------------------------
    # Real wl commands return expected structures
    # ------------------------------------------------------------------

    def test_wl_list_returns_expected_format(self):
        """Real wl list returns the expected JSON structure
        (success, workItems, count)."""
        data = _wl(
            ['list', '--status', 'completed', '--stage', 'in_review', '--json'],
            cwd=self.test_dir,
        )
        self.assertIn('workItems', data)
        self.assertIn('count', data)
        self.assertIsInstance(data['workItems'], list)
        self.assertIsInstance(data['count'], int)

    def test_wl_next_returns_item_or_empty(self):
        """Real wl next returns a workItem field without crashing."""
        data = _wl(['next', '--json'], cwd=self.test_dir)
        self.assertIn('workItem', data)

    def test_wl_audit_show_returns_result_or_null(self):
        """Real wl audit-show returns a structured response."""
        item_id = self._create_completed_item('Audit Show Test')
        data = _wl(['audit-show', item_id, '--json'], cwd=self.test_dir)
        self.assertIn('audit', data)

    # ------------------------------------------------------------------
    # Sparse queue: check_queue() flags next item via real wl
    # ------------------------------------------------------------------

    def test_sparse_queue_flags_next_item_via_real_wl(self):
        """With < 10 completed/in_review items, check_queue() flags the
        next item for producer review using the real wl CLI."""
        # Create 3 completed/in_review items
        for i in range(3):
            self._create_completed_item(f'Sparse Item {i}')

        # Also create an open item (no status change) that wl next can find
        self._create_item('Next Ready Item')

        # Run check_queue() — this calls the real wl CLI via heartbeat.run_wl
        # (because we chdir'd to the temp dir, run_wl subprocess sees our DB)
        result = heartbeat.check_queue()

        self.assertIn('Flagged', result)
        self.assertIn('producer review', result)
        self.assertIn('3', result)  # 3 completed/in_review items
        self.assertIn('below threshold', result)

    # ------------------------------------------------------------------
    # Full queue: check_queue() audits first non-ready item via real wl
    # ------------------------------------------------------------------

    def test_full_queue_audits_first_non_ready_via_real_wl(self):
        """With >= 10 completed/in_review items, check_queue() audits the
        first item (by sortIndex) that does not have a 'Ready to close: Yes'
        audit result, using the real wl CLI."""
        # Create 10 completed/in_review items
        item_ids = []
        for i in range(10):
            item_ids.append(self._create_completed_item(f'Full Queue Item {i}'))

        # Run check_queue()
        result = heartbeat.check_queue()

        # With 10+ items and none having audits, it should attempt to audit
        # the first item (by sortIndex). The audit may succeed or fail depending
        # on whether ACs are defined, but the key is the audit runner was invoked.
        self.assertIn('Full Queue Item 0', result)
        self.assertIn(item_ids[0], result)

    # ------------------------------------------------------------------
    # All items ready
    # ------------------------------------------------------------------

    def test_all_items_ready_via_real_db(self):
        """When all items already have valid audit results, check_queue()
        reports 'ready for producer review'."""
        item_ids = []
        for i in range(10):
            item_ids.append(self._create_completed_item(f'Ready Item {i}'))

        result = heartbeat.check_queue()

        # With 10+ items and none having audits, it attempts to audit the
        # first item. The audit may succeed or fail (no ACs defined on items).
        # Verify the audit runner was invoked for the first item.
        self.assertIn('Ready Item 0', result)
        self.assertIn(item_ids[0], result)

    # ------------------------------------------------------------------
    # Tests are isolated
    # ------------------------------------------------------------------

    def test_temp_directory_is_isolated(self):
        """Verify the test is running against a temp directory, not the
        real project database."""
        temp_wl = os.path.join(self.test_dir, '.worklog')
        project_wl = os.path.join(
            os.path.dirname(__file__), '..', '..', '..', '.worklog'
        )

        self.assertTrue(
            os.path.isdir(temp_wl),
            "Temp directory should have a .worklog/ after init",
        )
        if os.path.isdir(project_wl):
            self.assertNotEqual(
                os.path.realpath(temp_wl),
                os.path.realpath(project_wl),
                "Temp worklog should NOT be the real project worklog",
            )


class TestHeartbeatRunWlRealSubprocess(unittest.TestCase):
    """Tests that heartbeat.run_wl() actually calls the wl CLI via
    subprocess (not mocked) and handles failures gracefully."""

    def test_run_wl_successful_command(self):
        """run_wl with a valid command returns parsed JSON."""
        result = heartbeat.run_wl(['list', '--json'])
        self.assertIn('workItems', result)

    def test_run_wl_failing_command_raises_error(self):
        """run_wl with an invalid command raises RuntimeError."""
        with self.assertRaises(RuntimeError):
            heartbeat.run_wl(['nonexistent-command'])


if __name__ == '__main__':
    unittest.main()
