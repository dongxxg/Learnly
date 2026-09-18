#!/usr/bin/env python3
"""Tests for coverage gate.

After merging test+coverage into a single test job:
- base.yml: no 'coverage' stage, but still declares COVERAGE_CMD/COVERAGE_THRESHOLD.
- check-build.yml: no standalone 'coverage' job; coverage logic lives inside 'test' job.
"""

import os
import sys
import yaml

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))


def load_yaml(path):
    with open(path) as f:
        return yaml.safe_load(f)


def stringify_script(job):
    script = job.get("script", "")
    if isinstance(script, list):
        return "\n".join(script)
    return script


def test_base_no_coverage_stage():
    """base.yml must NOT have a separate 'coverage' stage (merged into 'test')."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "base.yml")
    doc = load_yaml(path)
    stages = doc.get("stages", [])
    assert "coverage" not in stages, (
        f"base.yml stages must NOT contain 'coverage' (merged into test), got: {stages}"
    )
    assert "test" in stages, "base.yml stages must contain 'test'"


def test_base_coverage_variables():
    """base.yml must still define COVERAGE_CMD and COVERAGE_THRESHOLD."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "base.yml")
    doc = load_yaml(path)
    variables = doc.get("variables", {})
    assert "COVERAGE_CMD" in variables, (
        f"base.yml variables must contain COVERAGE_CMD, got keys: {list(variables.keys())}"
    )
    assert "COVERAGE_THRESHOLD" in variables, (
        f"base.yml variables must contain COVERAGE_THRESHOLD, got keys: {list(variables.keys())}"
    )
    assert variables["COVERAGE_CMD"] == "" or variables["COVERAGE_CMD"] is None, (
        f"COVERAGE_CMD default must be empty string, got: {variables['COVERAGE_CMD']!r}"
    )
    assert variables["COVERAGE_THRESHOLD"] == 60, (
        f"COVERAGE_THRESHOLD default must be 60, got: {variables['COVERAGE_THRESHOLD']!r}"
    )


def test_check_build_no_standalone_coverage_job():
    """check-build.yml must NOT have a standalone 'coverage' job (merged into 'test')."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    assert "coverage" not in doc, (
        f"check-build.yml must NOT contain standalone 'coverage' job, got keys: {list(doc.keys())}"
    )


def test_test_job_includes_coverage_gate():
    """test job must include coverage parsing logic."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    test_job = doc.get("test", {})
    script = stringify_script(test_job)
    assert "COVERAGE_CMD" in script, "test job must reference COVERAGE_CMD"
    assert "COVERAGE_THRESHOLD" in script, "test job must reference COVERAGE_THRESHOLD"
    assert "COVERAGE_VALUE" in script, "test job must compute COVERAGE_VALUE"
    assert "Coverage PASS" in script or "Coverage FAIL" in script, (
        "test job must have coverage gate verdict (PASS/FAIL)"
    )


def test_test_job_skips_coverage_when_empty():
    """test job must skip coverage gate when COVERAGE_CMD is empty."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    test_job = doc.get("test", {})
    script = stringify_script(test_job)
    assert "COVERAGE_CMD is empty, skipping" in script, (
        "test job must skip coverage when COVERAGE_CMD is empty"
    )


def test_test_job_runs_coverage_after_test_cmd():
    """Coverage gate in test job must run AFTER ${TEST_CMD}."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    test_job = doc.get("test", {})
    script = stringify_script(test_job)
    test_cmd_idx = script.find("${TEST_CMD}")
    coverage_idx = script.find("COVERAGE_CMD is empty")
    assert test_cmd_idx >= 0 and coverage_idx >= 0, (
        "test job must reference both ${TEST_CMD} and COVERAGE_CMD"
    )
    assert test_cmd_idx < coverage_idx, (
        "Coverage gate must come AFTER ${TEST_CMD} in test job"
    )


def test_test_job_remains_hard_gate():
    """test job must keep allow_failure: false (failure on test or coverage fails pipeline)."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    test_job = doc.get("test", {})
    assert test_job.get("allow_failure") is False, (
        f"test job must keep allow_failure: false, got: {test_job.get('allow_failure')}"
    )


if __name__ == "__main__":
    results = {"passed": 0, "failed": 0}
    tests = [
        ("test_base_no_coverage_stage", test_base_no_coverage_stage),
        ("test_base_coverage_variables", test_base_coverage_variables),
        ("test_check_build_no_standalone_coverage_job", test_check_build_no_standalone_coverage_job),
        ("test_test_job_includes_coverage_gate", test_test_job_includes_coverage_gate),
        ("test_test_job_skips_coverage_when_empty", test_test_job_skips_coverage_when_empty),
        ("test_test_job_runs_coverage_after_test_cmd", test_test_job_runs_coverage_after_test_cmd),
        ("test_test_job_remains_hard_gate", test_test_job_remains_hard_gate),
    ]
    for name, fn in tests:
        try:
            fn()
            print(f"PASS: {name}")
            results["passed"] += 1
        except AssertionError as e:
            print(f"FAIL: {name} — {e}")
            results["failed"] += 1
        except Exception as e:
            print(f"ERROR: {name} — {e}")
            results["failed"] += 1

    print(f"\nResults: {results['passed']} passed, {results['failed']} failed")
    sys.exit(0 if results["failed"] == 0 else 1)
