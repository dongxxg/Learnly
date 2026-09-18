#!/usr/bin/env python3
"""Tests for check-build.yml hard block changes (Tasks 1.1, 1.2)."""

import os
import sys
import yaml

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "..", ".."))


def load_yaml(path):
    with open(path) as f:
        return yaml.safe_load(f)


def test_check_job_allow_failure_false():
    """Task 1.1: check job must have allow_failure: false (hard block)."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    assert "check" in doc, "check job must exist"
    check_job = doc["check"]
    actual = check_job.get("allow_failure", None)
    assert actual is False, (
        f"check job allow_failure must be false (hard block), got: {actual}"
    )


def test_test_job_allow_failure_false():
    """Task 1.2: test job must have allow_failure: false (hard block)."""
    path = os.path.join(REPO_ROOT, ".claude", "ci-templates", "check-build.yml")
    doc = load_yaml(path)
    assert "test" in doc, "test job must exist"
    test_job = doc["test"]
    actual = test_job.get("allow_failure", None)
    assert actual is False, (
        f"test job allow_failure must be false (hard block), got: {actual}"
    )


if __name__ == "__main__":
    results = {"passed": 0, "failed": 0}
    for name, fn in [
        ("test_check_job_allow_failure_false", test_check_job_allow_failure_false),
        ("test_test_job_allow_failure_false", test_test_job_allow_failure_false),
    ]:
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
