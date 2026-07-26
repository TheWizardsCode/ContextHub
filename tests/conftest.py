"""
Pytest conftest for the Worklog Python test suite.

Automatically adds the Pi agent skills directory to sys.path so that tests
under tests/ can import from auditor, code_review, and other Pi skill
modules without requiring the user to set PYTHONPATH manually.
"""

import sys
from pathlib import Path

_PI_SKILLS_ROOT = Path("/home/rgardler/.pi/agent/skills")

if _PI_SKILLS_ROOT.is_dir() and str(_PI_SKILLS_ROOT) not in sys.path:
    sys.path.insert(0, str(_PI_SKILLS_ROOT))
