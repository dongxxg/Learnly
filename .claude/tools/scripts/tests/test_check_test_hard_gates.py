#!/usr/bin/env python3
"""Tests for check/test CI gates.

check job: skips when CHECK_CMD is empty (lint is opt-in per language).
test job:  hard-fails when TEST_CMD is empty (tests are mandatory).
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


def test_base_declares_check_and_test_variables():
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "base.yml")
    doc = load_yaml(path)
    variables = doc.get("variables", {})
    assert "CHECK_CMD" in variables, "base.yml must declare CHECK_CMD"
    assert "TEST_CMD" in variables, "base.yml must declare TEST_CMD"


def test_check_job_skips_when_check_cmd_empty():
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    check_job = doc.get("check", {})
    script = stringify_script(check_job)
    assert "CHECK_CMD" in script, "check job must reference CHECK_CMD"
    assert "skipping" in script.lower(), (
        "check job must skip (not fail) when CHECK_CMD is empty"
    )
    assert "exit 0" in script, "check job must exit 0 when CHECK_CMD is empty"


def test_test_job_requires_test_cmd_without_skip():
    """test job must hard-fail when TEST_CMD is empty (not skip)."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    test_job = doc.get("test", {})
    script = stringify_script(test_job)
    assert "TEST_CMD" in script, "test job must reference TEST_CMD"
    assert 'echo "[test] ERROR: TEST_CMD is required' in script, (
        "test job must declare TEST_CMD as required"
    )
    assert "TEST_CMD is empty, skipping" not in script, (
        "test job must NOT skip when TEST_CMD is empty (must hard-fail)"
    )
    # Locate the TEST_CMD-empty guard block and verify it contains exit 1.
    # Use regex to skip past the `-z "${TEST_CMD}"` string-interpolation occurrence.
    import re
    m = re.search(
        r'if\s+\[\s*-z\s+"\$\{TEST_CMD\}"\s*\];\s*then.*?fi',
        script,
        re.DOTALL,
    )
    assert m is not None, "TEST_CMD-empty guard block not found"
    assert "exit 1" in m.group(0), (
        "TEST_CMD-empty branch must hard-fail with exit 1"
    )


def test_check_and_test_jobs_remain_hard_gates():
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    for job_name in ("check", "test"):
        job = doc.get(job_name, {})
        assert job.get("allow_failure") is False, f"{job_name} job must keep allow_failure: false"


if __name__ == "__main__":
    results = {"passed": 0, "failed": 0}
    tests = [
        ("test_base_declares_check_and_test_variables", test_base_declares_check_and_test_variables),
        ("test_check_job_skips_when_check_cmd_empty", test_check_job_skips_when_check_cmd_empty),
        ("test_test_job_requires_test_cmd_without_skip", test_test_job_requires_test_cmd_without_skip),
        ("test_check_and_test_jobs_remain_hard_gates", test_check_and_test_jobs_remain_hard_gates),
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
