"""
Unit tests for the heartbeat skill.

Tests the decision logic of the heartbeat script:
  - Queue length branching (< 10 vs >= 10)
  - Item selection by sortIndex
  - Audit result detection ("Ready to close: Yes")
  - Graceful handling of edge cases (empty queue, no next item)
"""

import json
import unittest
from unittest.mock import patch, MagicMock
import sys
import os

# Add the skill scripts directory to the path so we can import heartbeat
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'skill', 'heartbeat', 'scripts'))

# Import the heartbeat module
import heartbeat


class TestQueueLengthBranching(unittest.TestCase):
    """Test that the correct action is taken based on queue length."""

    @patch('heartbeat.run_wl')
    @patch('heartbeat.subprocess')
    def test_sparse_queue_flags_next_item(self, mock_subprocess, mock_run_wl):
        """Queue with <10 completed/in_review items should flag next item for review."""
        # Mock queue count: 3 items (less than threshold of 10)
        mock_run_wl.side_effect = [
            # First call: wl list --status completed --stage in_review --json
            {
                'success': True,
                'count': 3,
                'workItems': [
                    {'id': 'WL-ITEM1', 'title': 'Item 1', 'sortIndex': 100, 'auditResult': True},
                    {'id': 'WL-ITEM2', 'title': 'Item 2', 'sortIndex': 200, 'auditResult': True},
                    {'id': 'WL-ITEM3', 'title': 'Item 3', 'sortIndex': 300, 'auditResult': None},
                ]
            },
            # Second call: wl next --json
            {
                'success': True,
                'workItem': {'id': 'WL-NEXT1', 'title': 'Next Ready Item'}
            },
            # Third call: wl update --needs-producer-review true
            {
                'success': True,
                'workItem': {'id': 'WL-NEXT1', 'title': 'Next Ready Item', 'needsProducerReview': True}
            },
        ]

        result = heartbeat.check_queue()

        # Should print the flagging message
        self.assertIn('Flagged', result)
        self.assertIn('WL-NEXT1', result)
        self.assertIn('Next Ready Item', result)
        self.assertIn('3', result)
        self.assertIn('below threshold', result)

        # Verify wl update was called with --needs-producer-review true
        update_call = [c for c in mock_run_wl.call_args_list if 'update' in str(c)]
        self.assertEqual(len(update_call), 1)

    @patch('heartbeat.run_wl')
    @patch('heartbeat.subprocess')
    def test_full_queue_audits_first_non_ready(self, mock_subprocess, mock_run_wl):
        """Queue with >=10 completed/in_review items should audit first non-ready item."""
        # Create 10 completed/in_review items, sorted by sortIndex
        items = []
        for i in range(10):
            items.append({
                'id': f'WL-ITEM{i}',
                'title': f'Item {i}',
                'sortIndex': (i + 1) * 100,
                'auditResult': True if i < 9 else None,  # Last item has no audit
            })

        # Simulate successful audit subprocess call
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = 'Audit complete'
        mock_subprocess.run.return_value.stderr = ''

        mock_run_wl.side_effect = [
            # First call: wl list --status completed --stage in_review --json
            {
                'success': True,
                'count': 10,
                'workItems': items,
            },
            # Calls to audit-show for first 9 items (all ready)
            *[
                {
                    'success': True,
                    'audit': {
                        'workItemId': f'WL-ITEM{i}',
                        'readyToClose': True,
                        'rawOutput': 'Ready to close: Yes\n\nAcceptance criteria all met.',
                    }
                }
                for i in range(9)
            ],
            # Call to audit-show for item 9 (not ready - no audit)
            {
                'success': True,
                'audit': None,
            },
        ]

        result = heartbeat.check_queue()

        # Should find item 9 as the first non-ready item and trigger audit
        self.assertIn('Running audit on', result)
        self.assertIn('WL-ITEM9', result)

    @patch('heartbeat.run_wl')
    @patch('heartbeat.subprocess')
    def test_full_queue_audits_item_with_no_verdict_first(self, mock_subprocess, mock_run_wl):
        """Queue with 10 items: first non-ready by sortIndex should be audited."""
        items = []
        for i in range(10):
            items.append({
                'id': f'WL-ITEM{i}',
                'title': f'Item {i}',
                'sortIndex': (i + 1) * 100,
                'auditResult': True,
            })

        # Simulate successful audit subprocess call
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = 'Audit complete'
        mock_subprocess.run.return_value.stderr = ''

        # Item 0 has audit but wrong verdict, items 1-9 are ready
        mock_run_wl.side_effect = [
            # First: wl list
            {'success': True, 'count': 10, 'workItems': items},
            # audit-show for item 0 (has audit but not ready)
            {
                'success': True,
                'audit': {
                    'workItemId': 'WL-ITEM0',
                    'readyToClose': False,
                    'rawOutput': 'Ready to close: No\n\nSome criteria not met.',
                }
            },
        ]

        result = heartbeat.check_queue()

        self.assertIn('Running audit on', result)
        self.assertIn('WL-ITEM0', result)

    @patch('heartbeat.run_wl')
    @patch('heartbeat.subprocess')
    def test_full_queue_audits_item_with_null_audit_first(self, mock_subprocess, mock_run_wl):
        """First item by sortIndex with null auditResult should be audited first."""
        items = [
            {'id': 'WL-A', 'title': 'A', 'sortIndex': 100, 'auditResult': True},
            {'id': 'WL-B', 'title': 'B', 'sortIndex': 200, 'auditResult': None},  # No audit
            {'id': 'WL-C', 'title': 'C', 'sortIndex': 300, 'auditResult': True},
        ]

        # Simulate successful audit subprocess call
        mock_subprocess.run.return_value.returncode = 0
        mock_subprocess.run.return_value.stdout = 'Audit complete'
        mock_subprocess.run.return_value.stderr = ''

        mock_run_wl.side_effect = [
            # wl list with 3 items (but using count >= 10 code path...
            # Actually, let's adjust: we need 10 items but only one non-ready
            # Mock: wl list
            {'success': True, 'count': 10, 'workItems': items + [
                {'id': f'WL-EXTRA{i}', 'title': f'Extra {i}', 'sortIndex': 400 + (i * 100), 'auditResult': True}
                for i in range(7)
            ]},
            # audit-show for WL-A (ready)
            {'success': True, 'audit': {
                'workItemId': 'WL-A', 'readyToClose': True,
                'rawOutput': 'Ready to close: Yes\n\nAll met.'
            }},
            # audit-show for WL-B (no audit)
            {'success': True, 'audit': None},
        ]

        result = heartbeat.check_queue()

        self.assertIn('Running audit on', result)
        self.assertIn('WL-B', result)

    @patch('heartbeat.run_wl')
    @patch('heartbeat.subprocess')
    def test_all_items_ready_reports_done(self, mock_subprocess, mock_run_wl):
        """All completed/in_review items with valid audit should report project ready."""
        items = [
            {'id': 'WL-ITEM1', 'title': 'Item 1', 'sortIndex': 100, 'auditResult': True},
            {'id': 'WL-ITEM2', 'title': 'Item 2', 'sortIndex': 200, 'auditResult': True},
        ]

        # Need 10 items for the full-queue path
        for i in range(8):
            items.append({
                'id': f'WL-EXTRA{i}', 'title': f'Extra {i}',
                'sortIndex': 300 + (i * 100), 'auditResult': True
            })

        audit_results = []
        for item in items:
            audit_results.append({
                'success': True,
                'audit': {
                    'workItemId': item['id'],
                    'readyToClose': True,
                    'rawOutput': 'Ready to close: Yes\n\nAll criteria met.',
                }
            })

        mock_run_wl.side_effect = [
            {'success': True, 'count': 10, 'workItems': items},
            *audit_results,
        ]

        result = heartbeat.check_queue()

        self.assertIn('ready for producer review', result)
        self.assertIn('new release', result)

    @patch('heartbeat.run_wl')
    def test_empty_queue(self, mock_run_wl):
        """Empty queue should report no items."""
        mock_run_wl.return_value = {'success': True, 'count': 0, 'workItems': []}

        result = heartbeat.check_queue()

        self.assertIn('No items', result)
        self.assertIn('completed/in_review', result)


class TestAuditResultDetection(unittest.TestCase):
    """Test detection of 'Ready to close: Yes' in audit results."""

    def test_ready_to_close_yes(self):
        """Should return True for audit starting with 'Ready to close: Yes'."""
        raw = 'Ready to close: Yes\n\nAll acceptance criteria met.'
        self.assertTrue(heartbeat.is_ready_to_close(raw))

    def test_ready_to_close_no(self):
        """Should return False for audit starting with 'Ready to close: No'."""
        raw = 'Ready to close: No\n\nSome criteria not met.'
        self.assertFalse(heartbeat.is_ready_to_close(raw))

    def test_null_audit(self):
        """Should return False for None input."""
        self.assertFalse(heartbeat.is_ready_to_close(None))

    def test_empty_audit(self):
        """Should return False for empty string."""
        self.assertFalse(heartbeat.is_ready_to_close(''))

    def test_audit_with_leading_whitespace(self):
        """Should handle leading whitespace in rawOutput."""
        raw = '  Ready to close: Yes\n\nCriteria met.'
        self.assertTrue(heartbeat.is_ready_to_close(raw))

    def test_audit_with_trailing_newlines(self):
        """Should handle trailing newlines."""
        raw = 'Ready to close: Yes\n\nCriteria met.\n\n\n'
        self.assertTrue(heartbeat.is_ready_to_close(raw))


class TestSparseQueueEdgeCases(unittest.TestCase):
    """Test edge cases for sparse queue (< 10 items) behavior."""

    @patch('heartbeat.run_wl')
    def test_next_item_returns_none(self, mock_run_wl):
        """When wl next returns no item, should report gracefully."""
        mock_run_wl.side_effect = [
            {'success': True, 'count': 5, 'workItems': [
                {'id': 'WL-A', 'title': 'A', 'sortIndex': 100, 'auditResult': True}
                for _ in range(5)
            ]},
            # wl next returns no item
            {'success': True, 'workItem': None},
        ]

        result = heartbeat.check_queue()

        self.assertIn('No next item', result)
        self.assertIn('flag for review', result)

    @patch('heartbeat.run_wl')
    def test_single_item_queue(self, mock_run_wl):
        """Single item in queue should still flag next item."""
        mock_run_wl.side_effect = [
            {'success': True, 'count': 1, 'workItems': [
                {'id': 'WL-1', 'title': 'Only Item', 'sortIndex': 100, 'auditResult': None}
            ]},
            {'success': True, 'workItem': {'id': 'WL-NEXT', 'title': 'Next Item'}},
            {'success': True, 'workItem': {'id': 'WL-NEXT', 'needsProducerReview': True}},
        ]

        result = heartbeat.check_queue()

        self.assertIn('Flagged', result)
        self.assertIn('WL-NEXT', result)


class TestClientErrorHandling(unittest.TestCase):
    """Test graceful handling of wl command failures."""

    @patch('heartbeat.run_wl')
    def test_run_wl_raises_runtime_error(self, mock_run_wl):
        """When run_wl raises RuntimeError, check_queue should catch it."""
        mock_run_wl.side_effect = RuntimeError('wl command failed')

        result = heartbeat.check_queue()

        # Should return error message gracefully
        self.assertTrue(isinstance(result, str))
        self.assertIn('error', result.lower())


class TestForceFlag(unittest.TestCase):
    """Test the --force flag for standalone/automated use."""

    def test_parse_args_default(self):
        """Without --force, args.force should be False."""
        with patch.object(sys, 'argv', ['heartbeat.py']):
            args = heartbeat.parse_args()
        self.assertFalse(args.force)

    def test_parse_args_force(self):
        """With --force, args.force should be True."""
        with patch.object(sys, 'argv', ['heartbeat.py', '--force']):
            args = heartbeat.parse_args()
        self.assertTrue(args.force)

    def test_main_calls_parse_args(self):
        """main() should call parse_args and check_queue."""
        with patch.object(sys, 'argv', ['heartbeat.py']):
            with patch('heartbeat.check_queue', return_value='All good'):
                with patch('heartbeat.print') as mock_print:
                    heartbeat.main()
                    mock_print.assert_called_once_with('All good')


class TestMonkeypatchedEntrypoint(unittest.TestCase):
    """Test that the module can be imported and functions are defined."""

    def test_module_has_required_functions(self):
        """The heartbeat module should expose required functions."""
        self.assertTrue(hasattr(heartbeat, 'check_queue'))
        self.assertTrue(hasattr(heartbeat, 'is_ready_to_close'))
        self.assertTrue(hasattr(heartbeat, 'run_wl'))
        self.assertTrue(hasattr(heartbeat, 'main'))
        self.assertTrue(hasattr(heartbeat, 'parse_args'))


if __name__ == '__main__':
    unittest.main()
