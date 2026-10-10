#!/usr/bin/env python3
"""
Test Churn Analysis — Analyse test code rewrite patterns to evaluate TDD value.

Analyzes git commit history on the mainline (dev) branch to quantify how often
existing test code is rewritten when new features are added, providing evidence
for or against the value of test-driven development (TDD).

Scope: mainline (dev) only, non-merge commits.
"""

import json
import os
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class FileChange:
    """A single file change within a commit."""
    path: str
    status: str  # A, M, D, R
    additions: int = 0
    deletions: int = 0
    rename_target: str | None = None


@dataclass
class Commit:
    """A parsed git commit."""
    sha: str
    short_sha: str
    message: str
    date: str
    author: str
    files: list[FileChange] = field(default_factory=list)
    is_feature: bool = False
    touched_test: bool = False
    test_rewrites: list[FileChange] = field(default_factory=list)
    test_additions: list[FileChange] = field(default_factory=list)
    test_modifications: list[FileChange] = field(default_factory=list)
    src_changes: list[FileChange] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Test file patterns
TEST_PATTERNS = ('.test.ts', '.spec.ts')

# Directories considered "source" (non-test, non-scripts, non-docs)
SRC_PATTERNS = (
    'packages/herdr/src/',
    'packages/shared/src/',
    'packages/tui/',
    'src/',
)

# Test directories
TEST_DIRS = (
    'packages/herdr/src/',  # co-located unit tests
    'packages/shared/src/',  # co-located unit tests
    'packages/tui/extensions/',  # co-located tests
    'test/',
    'tests/',
)


def classify_test_area(path: str) -> str:
    """Classify a test file into its area category."""
    if 'packages/herdr/src/' in path:
        return 'herdr-unit'
    elif 'packages/shared/src/' in path:
        return 'shared-unit'
    elif 'packages/tui/extensions/' in path:
        return 'tui-unit'
    elif path.startswith('tests/herdr/'):
        return 'herdr-integration'
    elif path.startswith('tests/integration/'):
        return 'integration'
    elif path.startswith('tests/unit/'):
        return 'unit'
    elif path.startswith('tests/cli/'):
        return 'cli'
    elif path.startswith('tests/bench/'):
        return 'benchmark'
    elif path.startswith('test/') and not path.startswith('tests/'):
        return 'legacy'
    elif '.test.ts' in path or '.spec.ts' in path:
        return 'other-test'
    return 'unknown'


def is_test_file(path: str) -> bool:
    """Check if a file is a test file."""
    return path.endswith(TEST_PATTERNS)


def is_src_file(path: str) -> bool:
    """Check if a file is a source file."""
    return any(path.startswith(p) for p in SRC_PATTERNS)


def is_feature_commit(commit_files: list[FileChange]) -> bool:
    """Check if this commit modifies source code (not just tests/docs)."""
    return any(is_src_file(f.path) for f in commit_files)


# ---------------------------------------------------------------------------
# Git data extraction
# ---------------------------------------------------------------------------

def run_git(*args: str) -> str:
    """Run a git command and return stdout."""
    result = subprocess.run(
        ['git', '-C', '/home/rgardler/projects/ContextHub'] + list(args),
        capture_output=True, text=True, check=True
    )
    return result.stdout


def get_mainline_commits() -> list[str]:
    """Get all non-merge commits on the mainline (dev) branch."""
    output = run_git('log', 'dev', '--no-merges', '--pretty=format:%H|%h|%s|%ad|%an', '--date=short', '--reverse')
    commits = []
    for line in output.strip().split('\n'):
        if not line:
            continue
        parts = line.split('|', 4)
        if len(parts) == 5:
            commits.append({
                'sha': parts[0],
                'short_sha': parts[1],
                'message': parts[2],
                'date': parts[3],
                'author': parts[4],
            })
    return commits


def get_commit_diffs(sha: str) -> tuple[list[FileChange], dict]:
    """Get the file changes for a commit. Returns (files, statuses)."""
    # Check if this is the initial commit (no parent)
    has_parent = run_git('cat-file', '-t', sha + '^').strip() == 'commit'
    if not has_parent:
        # First commit - use diff against empty tree
        output = run_git('diff-tree', '-r', '--numstat', '--diff-filter=ADMR', '--root', sha)
    else:
        output = run_git('diff-tree', '--no-commit-id', '-r', '--numstat', '--diff-filter=ADMR', sha + '^..'+sha)
    files = []
    statuses = {}
    for line in output.strip().split('\n'):
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) == 3:
            additions, deletions, path = int(parts[0]) if parts[0] != '-' else 0, int(parts[1]) if parts[1] != '-' else 0, parts[2]
            files.append(FileChange(path=path, status='M', additions=additions, deletions=deletions))
            statuses[path] = 'M'
    return files, statuses


def parse_commits(commits_data: list[dict]) -> list[Commit]:
    """Parse all commits into Commit objects."""
    commits = []
    for i, cd in enumerate(commits_data):
        if i % 200 == 0:
            sys.stderr.write(f"\rParsing commit {i}/{len(commits_data)}...")
            sys.stderr.flush()
        try:
            files, statuses = get_commit_diffs(cd['sha'])
            commits.append(Commit(
                sha=cd['sha'],
                short_sha=cd['short_sha'],
                message=cd['message'],
                date=cd['date'],
                author=cd['author'],
                files=files,
            ))
        except Exception as e:
            sys.stderr.write(f"\nError parsing {cd['sha']}: {e}\n")
    sys.stderr.write("\n")
    return commits


# ---------------------------------------------------------------------------
# Analysis functions
# ---------------------------------------------------------------------------

def analyse_feature_commits(commits: list[Commit]) -> dict:
    """Primary analysis of feature commits."""
    feature_commits = [c for c in commits if is_feature_commit(c.files)]

    total_feature = len(feature_commits)
    commits_with_test_rewrites = []
    commits_with_new_tests = []
    commits_touching_test = []
    total_test_deletions = 0
    total_test_additions = 0

    # Per-area tracking
    area_stats = defaultdict(lambda: {
        'feature_commits': 0, 'rewrites': 0, 'new_files': 0,
        'total_deleted': 0, 'total_added': 0,
    })

    for fc in feature_commits:
        test_files = [f for f in fc.files if is_test_file(f.path)]
        if not test_files:
            continue

        fc.touched_test = True
        fc.src_changes = [f for f in fc.files if is_src_file(f.path)]

        rewrites = []
        additions = []
        modifications = []

        for tf in test_files:
            if tf.status == 'A':
                additions.append(tf)
            elif tf.status == 'M' and tf.additions > 0 and tf.deletions > 0:
                rewrites.append(tf)
                modifications.append(tf)
            elif tf.status == 'M' and tf.additions > 0:
                modifications.append(tf)

        fc.test_rewrites = rewrites
        fc.test_additions = additions
        fc.test_modifications = modifications

        if rewrites:
            commits_with_test_rewrites.append(fc)
        if additions:
            commits_with_new_tests.append(fc)
        if rewrites or additions or modifications:
            commits_touching_test.append(fc)

        total_test_deletions += sum(r.deletions for r in rewrites)
        total_test_additions += sum(r.additions for r in rewrites)
        total_test_additions += sum(a.additions for a in additions)

        # Per-area
        for tf in rewrites + additions:
            area = classify_test_area(tf.path)
            area_stats[area]['feature_commits'] += 1
            if tf.status == 'M':
                area_stats[area]['rewrites'] += 1
                area_stats[area]['total_deleted'] += tf.deletions
                area_stats[area]['total_added'] += tf.additions
            elif tf.status == 'A':
                area_stats[area]['new_files'] += 1

    # Rewrite ratio
    total_test_change = total_test_deletions + total_test_additions
    rewrite_ratio = total_test_deletions / total_test_change if total_test_change > 0 else 0

    return {
        'total_commits': len(commits),
        'total_feature': total_feature,
        'feature_pct': round(total_feature / len(commits) * 100, 1) if commits else 0,
        'commits_touching_test': len(commits_touching_test),
        'test_touch_pct': round(len(commits_touching_test) / total_feature * 100, 1) if total_feature else 0,
        'commits_with_rewrites': len(commits_with_test_rewrites),
        'rewrite_pct': round(len(commits_with_test_rewrites) / total_feature * 100, 1) if total_feature else 0,
        'commits_with_new_tests': len(commits_with_new_tests),
        'new_test_pct': round(len(commits_with_new_tests) / total_feature * 100, 1) if total_feature else 0,
        'total_test_deletions': total_test_deletions,
        'total_test_additions': total_test_additions,
        'rewrite_ratio': round(rewrite_ratio * 100, 1),
        'rewrite_lines_total': total_test_deletions + total_test_additions,
        'avg_rewrite_lines': round((total_test_deletions + total_test_additions) / len(commits_with_test_rewrites), 0) if commits_with_test_rewrites else 0,
        'area_stats': dict(area_stats),
    }


def analyse_temporal_trends(commits: list[Commit]) -> list[dict]:
    """Analyse rewrite trends by quarter."""
    quarterly = defaultdict(lambda: {
        'features': 0, 'rewrites': 0, 'total_deleted': 0, 'total_added': 0,
    })

    for c in commits:
        if not is_feature_commit(c.files):
            continue
        quarterly[c.date[:7]]['features'] += 1
        test_rewrites = [f for f in c.files if is_test_file(f.path) and f.status == 'M' and f.additions > 0 and f.deletions > 0]
        for tr in test_rewrites:
            quarterly[c.date[:7]]['rewrites'] += 1
            quarterly[c.date[:7]]['total_deleted'] += tr.deletions
            quarterly[c.date[:7]]['total_added'] += tr.additions

    result = []
    for quarter in sorted(quarterly.keys()):
        d = quarterly[quarter]
        result.append({
            'quarter': quarter,
            'feature_commits': d['features'],
            'feature_commits_with_rewrites': d['rewrites'],
            'rewrite_rate_pct': round(d['rewrites'] / d['features'] * 100, 1) if d['features'] else 0,
            'lines_deleted': d['total_deleted'],
            'lines_added': d['total_added'],
        })
    return result


def analyse_per_file_stability(commits: list[Commit]) -> dict:
    """Analyse which test files are most volatile (most commits modifying them)."""
    file_churn = defaultdict(lambda: {'commits': 0, 'total_additions': 0, 'total_deletions': 0})

    for c in commits:
        if not is_feature_commit(c.files):
            continue
        test_files = [f for f in c.files if is_test_file(f.path)]
        for tf in test_files:
            file_churn[tf.path]['commits'] += 1
            file_churn[tf.path]['total_additions'] += tf.additions
            file_churn[tf.path]['total_deletions'] += tf.deletions

    # Sort by commit count
    sorted_files = sorted(file_churn.items(), key=lambda x: x[1]['commits'], reverse=True)
    top_20 = [{'file': path, **stats, 'area': classify_test_area(path)} for path, stats in sorted_files[:20]]
    return {
        'total_test_files_modified': len(file_churn),
        'top_20_by_commits': top_20,
    }


def analyse_domain_churn(commits: list[Commit]) -> dict:
    """Analyse churn by domain/module area."""
    domain_stats = defaultdict(lambda: {
        'total_test_files': 0, 'total_src_files': 0,
        'rewrites': 0, 'new_tests': 0,
        'total_deletions': 0, 'total_additions': 0,
    })

    for c in commits:
        if not is_feature_commit(c.files):
            continue
        for f in c.files:
            if is_src_file(f.path):
                domain = 'src'
            elif is_test_file(f.path):
                domain = classify_test_area(f.path)
            else:
                continue
            domain_stats[domain]['total_src_files'] += len([ff for ff in c.files if is_src_file(ff.path)])
            if f.status == 'M' and is_test_file(f.path) and f.additions > 0 and f.deletions > 0:
                domain_stats[domain]['rewrites'] += 1
                domain_stats[domain]['total_deletions'] += f.deletions
                domain_stats[domain]['total_additions'] += f.additions
            elif f.status == 'A' and is_test_file(f.path):
                domain_stats[domain]['new_tests'] += 1

    return dict(domain_stats)


def analyse_test_first_signal(commits: list[Commit]) -> dict:
    """Analyse test-first vs retrofit patterns."""
    test_first = 0  # Test file added before/with source file in same commit
    retrofit = 0    # Test file modified on existing source
    test_first_lines = 0
    retrofit_lines = 0

    # Track source file creation dates
    src_files = set()
    for c in commits:
        src_added = [f.path for f in c.files if is_src_file(f.path) and f.status == 'A']
        test_added = [f.path for f in c.files if is_test_file(f.path) and f.status == 'A']
        test_modified = [f.path for f in c.files if is_test_file(f.path) and f.status == 'M']

        # New test files added with new source files = test-first
        if test_added and any(f.path.replace('.test.ts', '').replace('.spec.ts', '') in
                            [s.replace('.test.ts', '') for s in src_added] for f in c.files if is_test_file(f.path) and f.status == 'A'):
            test_first += 1
            test_first_lines += sum(f.additions for f in c.files if is_test_file(f.path) and f.status == 'A')

        # Test modifications on commits with source changes = potential test-first or retrofit
        if test_modified and any(is_src_file(f.path) for f in c.files if f.status == 'M'):
            test_first += 1
            test_first_lines += sum(f.additions for f in c.files if is_test_file(f.path) and f.status == 'M')
        elif test_modified and not any(is_src_file(f.path) for f in c.files):
            # Test modification without source change = retrofit or test maintenance
            retrofit += 1
            retrofit_lines += sum(f.additions for f in c.files if is_test_file(f.path) and f.status == 'M')

    total = test_first + retrofit
    return {
        'test_first_commits': test_first,
        'test_first_pct': round(test_first / total * 100, 1) if total else 0,
        'test_first_lines': test_first_lines,
        'retrofit_commits': retrofit,
        'retrofit_pct': round(retrofit / total * 100, 1) if total else 0,
        'retrofit_lines': retrofit_lines,
    }


def analyse_rewrite_intensity(commits: list[Commit]) -> dict:
    """Analyse the distribution of rewrite intensity (lines rewritten per commit)."""
    rewrite_sizes = []
    for c in commits:
        if not is_feature_commit(c.files):
            continue
        rewrites = [f for f in c.files if is_test_file(f.path) and f.status == 'M' and f.additions > 0 and f.deletions > 0]
        if rewrites:
            total_rewrite = sum(f.additions + f.deletions for f in rewrites)
            rewrite_sizes.append(total_rewrite)

    if not rewrite_sizes:
        return {'total_rewrite_commits': 0}

    rewrite_sizes_sorted = sorted(rewrite_sizes)
    n = len(rewrite_sizes_sorted)
    return {
        'total_rewrite_commits': n,
        'min': min(rewrite_sizes_sorted),
        'max': max(rewrite_sizes_sorted),
        'mean': round(sum(rewrite_sizes_sorted) / n),
        'median': rewrite_sizes_sorted[n // 2],
        'p95': rewrite_sizes_sorted[int(n * 0.95)] if n > 1 else rewrite_sizes_sorted[0],
        'p99': rewrite_sizes_sorted[int(n * 0.99)] if n > 1 else rewrite_sizes_sorted[0],
        'stddev': round((sum((x - sum(rewrite_sizes_sorted)/n)**2 for x in rewrite_sizes_sorted) / n) ** 0.5),
        'distribution': {
            '0-10_lines': len([x for x in rewrite_sizes_sorted if x <= 10]),
            '11-50_lines': len([x for x in rewrite_sizes_sorted if 11 <= x <= 50]),
            '51-100_lines': len([x for x in rewrite_sizes_sorted if 51 <= x <= 100]),
            '101-250_lines': len([x for x in rewrite_sizes_sorted if 101 <= x <= 250]),
            '251-500_lines': len([x for x in rewrite_sizes_sorted if 251 <= x <= 500]),
            '500+_lines': len([x for x in rewrite_sizes_sorted if x > 500]),
        },
    }


def analyse_source_volatility_correlation(commits: list[Commit]) -> dict:
    """Correlate source file churn with test rewrite churn."""
    data_points = []
    for c in commits:
        if not is_feature_commit(c.files):
            continue
        src_lines_changed = sum(f.additions + f.deletions for f in c.files if is_src_file(f.path))
        test_lines_rewritten = sum(f.additions + f.deletions for f in c.files if is_test_file(f.path) and f.status == 'M' and f.additions > 0 and f.deletions > 0)
        if src_lines_changed > 0:
            data_points.append((src_lines_changed, test_lines_rewritten))

    if len(data_points) < 2:
        return {'correlation': None, 'data_points': 0}

    # Pearson correlation
    n = len(data_points)
    x_mean = sum(p[0] for p in data_points) / n
    y_mean = sum(p[1] for p in data_points) / n

    numerator = sum((p[0] - x_mean) * (p[1] - y_mean) for p in data_points)
    denom_x = (sum((p[0] - x_mean)**2 for p in data_points)) ** 0.5
    denom_y = (sum((p[1] - y_mean)**2 for p in data_points)) ** 0.5

    if denom_x * denom_y == 0:
        correlation = None
    else:
        correlation = round(numerator / (denom_x * denom_y), 3)

    return {
        'correlation': correlation,
        'data_points': n,
        'avg_src_lines_per_feature': round(x_mean),
        'avg_test_rewrites_per_feature': round(y_mean),
    }


def analyse_efficiency_metrics(commits: list[Commit]) -> dict:
    """Efficiency metrics: lines of test code churned per line of source changed."""
    total_src_changed = 0
    total_test_churned = 0
    src_file_count = 0
    test_file_count = 0

    for c in commits:
        if not is_feature_commit(c.files):
            continue
        src = [f for f in c.files if is_src_file(f.path)]
        tests = [f for f in c.files if is_test_file(f.path)]
        for s in src:
            total_src_changed += s.additions + s.deletions
            src_file_count += 1
        for t in tests:
            if t.status == 'M':
                total_test_churned += t.additions + t.deletions
            test_file_count += 1

    return {
        'total_src_files_touched': src_file_count,
        'total_test_files_touched': test_file_count,
        'total_src_lines_changed': total_src_changed,
        'total_test_lines_churned': total_test_churned,
        'test_to_source_ratio': round(test_file_count / src_file_count, 2) if src_file_count else 0,
        'test_churn_per_source_line': round(total_test_churned / total_src_changed, 2) if total_src_changed else 0,
    }


def analyse_commit_patterns(commits: list[Commit]) -> dict:
    """Analyse patterns in commit types."""
    commit_types = defaultdict(int)
    for c in commits:
        if not is_feature_commit(c.files):
            continue
        test_files = [f for f in c.files if is_test_file(f.path)]
        rewrites = [f for f in test_files if f.status == 'M' and f.additions > 0 and f.deletions > 0]
        additions = [f for f in test_files if f.status == 'A']

        if rewrites and additions:
            commit_types['both_rewrite_and_new'] += 1
        elif rewrites:
            commit_types['rewrite_only'] += 1
        elif additions:
            commit_types['new_tests_only'] += 1
        else:
            commit_types['modify_only'] += 1

    return dict(commit_types)


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def generate_report(analysis: dict, temporal: list[dict], file_stability: dict,
                    domain_churn: dict, test_first: dict, intensity: dict,
                    correlation: dict, efficiency: dict, commit_patterns: dict) -> str:
    """Generate a comprehensive report."""
    report = []
    report.append("=" * 80)
    report.append("TEST CHURN ANALYSIS — TDD Value Assessment")
    report.append("=" * 80)
    report.append("")
    report.append(f"Generated: {analysis.get('generated_at', 'N/A')}")
    report.append("Scope: mainline (dev) only, non-merge commits")
    report.append("")

    # Methodology
    report.append("-" * 80)
    report.append("1. METHODOLOGY")
    report.append("-" * 80)
    report.append("")
    report.append("Definitions:")
    report.append("  • Rewrite: An existing test file (status=M) modified with both")
    report.append("    additions AND deletions — i.e., lines of existing test code")
    report.append("    removed and replaced.")
    report.append("  • New test: A test file added (status=A) in a feature commit.")
    report.append("  • Feature commit: A commit that touches at least one source file")
    report.append("    (in packages/herdr/src/, packages/shared/src/, packages/tui/, src/).")
    report.append("  • Test-first: A test is added in the same commit as its source.")
    report.append("  • Retrofit: A test file is modified without any source file changes.")
    report.append("")
    report.append("Limitations:")
    report.append("  • Branch-specific churn excluded (dev mainline only).")
    report.append("  • Rewrite rate may reflect legitimate API changes, not just TDD quality.")
    report.append("  • High rewrite rates could indicate either fragile design OR necessary")
    report.append("    adaptation to evolving interfaces.")
    report.append("")

    # Primary metric
    report.append("-" * 80)
    report.append("2. PRIMARY METRIC — Test Code Rewrite Ratio")
    report.append("-" * 80)
    report.append("")
    report.append(f"  Total commits analysed:          {analysis['total_commits']:,}")
    report.append(f"  Feature commits (touching src/): {analysis['total_feature']:,} ({analysis['feature_pct']}%)")
    report.append(f"  Commits touching test files:     {analysis['commits_touching_test']:,} ({analysis['test_touch_pct']}% of features)")
    report.append(f"  Feature commits with rewrites:   {analysis['commits_with_rewrites']:,} ({analysis['rewrite_pct']}%)")
    report.append(f"  Feature commits with new tests:  {analysis['commits_with_new_tests']:,} ({analysis['new_test_pct']}%)")
    report.append("")
    report.append(f"  Lines deleted from existing tests:  {analysis['total_test_deletions']:,}")
    report.append(f"  Lines added to tests:               {analysis['total_test_additions']:,}")
    report.append(f"  Total test lines changed:           {analysis['rewrite_lines_total']:,}")
    report.append("")
    report.append("  ════════════════════════════════════════════")
    report.append(f"  REWRITE RATIO: {analysis['rewrite_ratio']}%")
    report.append("  ════════════════════════════════════════════")
    report.append("  (Deleted / (Deleted + Added))")
    report.append("")

    # Temporal trends
    report.append("-" * 80)
    report.append("3. TEMPORAL TREND — Rewrite Activity by Quarter")
    report.append("-" * 80)
    report.append("")
    report.append(f"  {'Quarter':<12} {'Features':>10} {'With Rewrites':>14} {'Rate':>8} {'Deleted':>10} {'Added':>10}")
    report.append(f"  {'-'*12} {'-'*10} {'-'*14} {'-'*8} {'-'*10} {'-'*10}")
    for t in temporal:
        report.append(f"  {t['quarter']:<12} {t['feature_commits']:>10,} {t['feature_commits_with_rewrites']:>14,} {t['rewrite_rate_pct']:>7.1f}% {t['lines_deleted']:>10,} {t['lines_added']:>10,}")
    report.append("")

    # Test area breakdown
    report.append("-" * 80)
    report.append("4. TEST AREA BREAKDOWN — Churn by Category")
    report.append("-" * 80)
    report.append("")
    report.append(f"  {'Area':<20} {'Feature Commits':>16} {'Rewrites':>10} {'New Files':>10} {'Deleted':>10} {'Added':>10} {'Ratio':>8}")
    report.append(f"  {'-'*20} {'-'*16} {'-'*10} {'-'*10} {'-'*10} {'-'*10} {'-'*8}")
    for area, stats in sorted(analysis['area_stats'].items(), key=lambda x: x[1]['rewrites'], reverse=True):
        total_change = stats['total_deleted'] + stats['total_added']
        ratio = round(stats['total_deleted'] / total_change * 100, 1) if total_change else 0
        report.append(f"  {area:<20} {stats['feature_commits']:>16,} {stats['rewrites']:>10,} {stats['new_files']:>10,} {stats['total_deleted']:>10,} {stats['total_added']:>10,} {ratio:>7.1f}%")
    report.append("")

    # Per-file stability
    report.append("-" * 80)
    report.append("5. PER-FILE STABILITY — Most Volatile Test Files")
    report.append("-" * 80)
    report.append("")
    report.append(f"  Total test files modified: {file_stability['total_test_files_modified']:,}")
    report.append("")
    report.append(f"  {'Rank':<5} {'File':<55} {'Commits':>8} {'Added':>8} {'Deleted':>8}")
    report.append(f"  {'-'*5} {'-'*55} {'-'*8} {'-'*8} {'-'*8}")
    for i, f in enumerate(file_stability['top_20_by_commits'], 1):
        report.append(f"  {i:<5} {f['file']:<55} {f['commits']:>8,} {f['total_additions']:>8,} {f['total_deletions']:>8,}")
    report.append("")

    # Rewrite intensity distribution
    report.append("-" * 80)
    report.append("6. REWRITE INTENSITY DISTRIBUTION")
    report.append("-" * 80)
    report.append("")
    report.append(f"  Total rewrite commits: {intensity['total_rewrite_commits']:,}")
    report.append(f"  Min lines: {intensity['min']}")
    report.append(f"  Mean lines: {intensity['mean']}")
    report.append(f"  Median lines: {intensity['median']}")
    report.append(f"  P95 lines: {intensity['p95']}")
    report.append(f"  P99 lines: {intensity['p99']}")
    report.append(f"  Stddev: {intensity['stddev']}")
    report.append("")
    report.append(f"  {'Bucket':<15} {'Count':>8} {'% of Total':>12}")
    report.append(f"  {'-'*15} {'-'*8} {'-'*12}")
    for bucket, count in intensity['distribution'].items():
        pct = round(count / intensity['total_rewrite_commits'] * 100, 1) if intensity['total_rewrite_commits'] else 0
        report.append(f"  {bucket:<15} {count:>8,} {pct:>11.1f}%")
    report.append("")

    # Test-first signal
    report.append("-" * 80)
    report.append("7. TEST-FIRST SIGNAL — Test-First vs Retrofit")
    report.append("-" * 80)
    report.append("")
    report.append(f"  Test-first commits:    {test_first['test_first_commits']:,} ({test_first['test_first_pct']}%)")
    report.append(f"  Retrofit commits:      {test_first['retrofit_commits']:,} ({test_first['retrofit_pct']}%)")
    report.append(f"  Test-first lines:      {test_first['test_first_lines']:,}")
    report.append(f"  Retrofit lines:        {test_first['retrofit_lines']:,}")
    report.append("")

    # Source volatility correlation
    report.append("-" * 80)
    report.append("8. SOURCE VOLATILITY CORRELATION")
    report.append("-" * 80)
    report.append("")
    report.append(f"  Pearson correlation (source churn vs test rewrite): {correlation['correlation']}")
    report.append(f"  Data points: {correlation['data_points']:,}")
    report.append(f"  Avg source lines per feature: {correlation['avg_src_lines_per_feature']:,}")
    report.append(f"  Avg test rewrites per feature: {correlation['avg_test_rewrites_per_feature']:,}")
    if correlation['correlation'] is not None:
        if correlation['correlation'] > 0.5:
            report.append("  Interpretation: STRONG POSITIVE — More source churn correlates with more test rewrites.")
        elif correlation['correlation'] > 0.2:
            report.append("  Interpretation: MODERATE POSITIVE — Some correlation between source and test churn.")
        elif correlation['correlation'] > -0.2:
            report.append("  Interpretation: WEAK NEGLIGIBLE — Little relationship between source and test churn.")
        else:
            report.append("  Interpretation: NEGATIVE — Unusual inverse relationship.")
    report.append("")

    # Efficiency metrics
    report.append("-" * 80)
    report.append("9. EFFICIENCY METRICS")
    report.append("-" * 80)
    report.append("")
    report.append(f"  Source files touched:            {efficiency['total_src_files_touched']:,}")
    report.append(f"  Test files touched:              {efficiency['total_test_files_touched']:,}")
    report.append(f"  Test-to-source file ratio:       {efficiency['test_to_source_ratio']:.2%}")
    report.append(f"  Total source lines changed:      {efficiency['total_src_lines_changed']:,}")
    report.append(f"  Total test lines churned:        {efficiency['total_test_lines_churned']:,}")
    report.append(f"  Test churn per source line:      {efficiency['test_churn_per_source_line']:.2f}")
    report.append("")

    # Commit patterns
    report.append("-" * 80)
    report.append("10. COMMIT PATTERNS — Types of Test-Related Feature Commits")
    report.append("-" * 80)
    report.append("")
    for pattern, count in sorted(commit_patterns.items(), key=lambda x: x[1], reverse=True):
        report.append(f"  {pattern:<30} {count:>8,}")
    report.append("")

    # Domain churn
    report.append("-" * 80)
    report.append("11. DOMAIN-SPECIFIC CHURN SUMMARY")
    report.append("-" * 80)
    report.append("")
    for domain, stats in sorted(domain_churn.items(), key=lambda x: x[1].get('rewrites', 0), reverse=True):
        report.append(f"  {domain}:")
        report.append(f"    Rewrites: {stats['rewrites']:,}  |  New tests: {stats['new_tests']:,}  |  Churn: {stats['total_deletions'] + stats['total_additions']:,} lines")
    report.append("")

    # TDD Value Assessment
    report.append("=" * 80)
    report.append("12. TDD VALUE ASSESSMENT")
    report.append("=" * 80)
    report.append("")

    rewrite_ratio = analysis['rewrite_ratio']
    test_first_pct = test_first['test_first_pct']
    correlation_val = correlation['correlation']

    # Assessment
    report.append("  What the data suggests:")
    report.append("")

    if rewrite_ratio > 50:
        report.append(f"  ⚠  HIGH REWRITE RATE ({rewrite_ratio}%):")
        report.append("     Nearly half of all test code changes are rewrites of existing")
        report.append("     test code. This suggests that tests are frequently written in")
        report.append("     a form that doesn't survive subsequent feature development.")
    elif rewrite_ratio > 30:
        report.append(f"  ⚡ MODERATE REWRITE RATE ({rewrite_ratio}%):")
        report.append("     A significant portion of test code is being rewritten. This")
        report.append("     may indicate that test-writing discipline could be improved,")
        report.append("     or that the codebase architecture causes cascading test changes.")
    else:
        report.append(f"  ✓ LOW REWRITE RATE ({rewrite_ratio}%):")
        report.append("     Test code is relatively stable. This is a positive sign for")
        report.append("     test-driven development practices.")
    report.append("")

    if test_first_pct > 60:
        report.append(f"  ✓ TEST-FIRST DOMINANT ({test_first_pct}%):")
        report.append("     The majority of test additions occur alongside source code,")
        report.append("     suggesting test-first development is the dominant pattern.")
    else:
        report.append(f"  ⚠ TEST-FIRST RISES ({test_first_pct}%):")
        report.append("     While test-first is common, retrofitting tests represents")
        report.append("     a significant minority. This may indicate inconsistent")
        report.append("     test-writing discipline.")
    report.append("")

    if correlation_val is not None and correlation_val > 0.3:
        report.append(f"  ✓ CORRELATED EXPECTATION (r={correlation_val}):")
        report.append("     The positive correlation between source churn and test")
        report.append("     rewrites is expected — changes to code naturally require")
        report.append("     test updates. The key question is whether the rewrite")
        report.append("     rate is proportionally reasonable.")
    report.append("")

    report.append("  Conclusions:")
    report.append("")

    # Overall verdict
    score = 0
    if rewrite_ratio < 30:
        score += 2
    elif rewrite_ratio < 50:
        score += 1

    if test_first_pct > 60:
        score += 2
    elif test_first_pct > 40:
        score += 1

    if score >= 3:
        report.append("  ════════════════════════════════════════════════════")
        report.append("  OVERALL: TDD PRACTICE IS REASONABLY EFFECTIVE")
        report.append("  ════════════════════════════════════════════════════")
        report.append("  The rewrite rate and test-first dominance suggest that")
        report.append("  writing tests before implementation is delivering value.")
        report.append("  The test suite is a reliable regression guard.")
    elif score >= 2:
        report.append("  ════════════════════════════════════════════════════")
        report.append("  OVERALL: MIXED RESULTS — TDD HAS PARTIAL VALUE")
        report.append("  ════════════════════════════════════════════════════")
        report.append("  There is evidence of TDD value (test-first patterns) but")
        report.append("  the rewrite rate suggests tests are not fully insulated")
        report.append("  from implementation changes. Consider reviewing test")
        report.append("  architecture and mocking strategies.")
    else:
        report.append("  ════════════════════════════════════════════════════")
        report.append("  OVERALL: TDD VALUE IS QUESTIONABLE")
        report.append("  ════════════════════════════════════════════════════")
        report.append("  High rewrite rates and significant retrofitting suggest")
        report.append("  that tests are tightly coupled to implementation details")
        report.append("  rather than behaviour. Consider refactoring tests to")
        report.append("  focus on interfaces and contracts rather than internals.")
    report.append("")

    report.append("  Recommendations:")
    report.append("  1. If rewrite rate is high (>40%): review test architecture")
    report.append("     for over-specification of implementation details.")
    report.append("  2. Encourage test-first as the default discipline.")
    report.append("  3. Consider property-based testing for complex logic.")
    report.append("  4. Regularly audit the most volatile test files (see Section 5).")
    report.append("  5. Monitor rewrite ratio over time as a health metric.")
    report.append("")

    report.append("=" * 80)
    report.append("END OF REPORT")
    report.append("=" * 80)

    return '\n'.join(report)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    sys.stderr.write("Test Churn Analysis — Starting...\n")

    # Get commits
    sys.stderr.write("Fetching mainline commits...\n")
    commits_data = get_mainline_commits()
    sys.stderr.write(f"  Found {len(commits_data)} non-merge commits on dev\n")

    # Parse commits (in batches for performance)
    sys.stderr.write("Parsing commits...\n")
    commits = parse_commits(commits_data)

    # Run all analyses
    sys.stderr.write("Running analyses...\n")

    primary = analyse_feature_commits(commits)
    temporal = analyse_temporal_trends(commits)
    file_stability = analyse_per_file_stability(commits)
    domain_churn = analyse_domain_churn(commits)
    test_first = analyse_test_first_signal(commits)
    intensity = analyse_rewrite_intensity(commits)
    correlation = analyse_source_volatility_correlation(commits)
    efficiency = analyse_efficiency_metrics(commits)
    commit_patterns = analyse_commit_patterns(commits)

    # Generate report
    primary['generated_at'] = commits[0].date if commits else 'N/A'
    report = generate_report(primary, temporal, file_stability, domain_churn,
                            test_first, intensity, correlation, efficiency, commit_patterns)

    # Output report
    print(report)

    # Also output JSON for programmatic use
    json_output = {
        'generated_at': primary['generated_at'],
        'primary_metrics': {k: v for k, v in primary.items() if k != 'area_stats'},
        'area_stats': primary['area_stats'],
        'temporal_trends': temporal,
        'file_stability': file_stability,
        'domain_churn': domain_churn,
        'test_first_signal': test_first,
        'rewrite_intensity': intensity,
        'source_correlation': correlation,
        'efficiency_metrics': efficiency,
        'commit_patterns': commit_patterns,
    }

    # Save JSON
    json_path = os.path.join(os.path.dirname(__file__), 'test_churn_data.json')
    with open(json_path, 'w') as f:
        json.dump(json_output, f, indent=2)
    sys.stderr.write(f"\nJSON data saved to: {json_path}\n")

    return 0


if __name__ == '__main__':
    sys.exit(main())
