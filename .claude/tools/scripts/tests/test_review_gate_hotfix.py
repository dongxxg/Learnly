#!/usr/bin/env python3
"""Tests for review-gate.py --hotfix flag (Task 4.1)."""

import json
import os
import sys
import tempfile
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REVIEW_GATE = os.path.join(SCRIPT_DIR, "..", "ci", "review-gate.py")


def run_review_gate(score, p0_count, hotfix=False, mr_iid="1", env_extra=None):
    """Run review-gate.py with given inputs and return parsed output."""
    with tempfile.TemporaryDirectory() as tmpdir:
        review_file = os.path.join(tmpdir, "review-result.json")
        output_file = os.path.join(tmpdir, "review-gate-result.txt")

        with open(review_file, "w") as f:
            json.dump({
                "score": score,
                "p0_count": p0_count,
                "problem_dimension": "code",
                "details": "test details"
            }, f)

        env = os.environ.copy()
        env["CI_MERGE_REQUEST_IID"] = mr_iid
        if env_extra:
            env.update(env_extra)

        cmd = [sys.executable, REVIEW_GATE, review_file, output_file]
        if hotfix:
            cmd.insert(2, "--hotfix")

        result = subprocess.run(cmd, capture_output=True, text=True, env=env)

        output = {}
        if os.path.exists(output_file):
            with open(output_file) as f:
                for line in f:
                    line = line.strip()
                    if "=" in line:
                        key, _, val = line.partition("=")
                        output[key] = val

        return result.returncode, output


def test_hotfix_p0_blocks():
    """P0 > 0 still blocks even with --hotfix."""
    rc, out = run_review_gate(score=90, p0_count=2, hotfix=True)
    assert out.get("ROUTE") == "block", f"P0 must block in hotfix mode, got ROUTE={out.get('ROUTE')}"
    assert out.get("SCORE") == "0", f"P0 must force score=0, got SCORE={out.get('SCORE')}"


def test_hotfix_score_75_passes_no_debate():
    """Score 75 with hotfix passes (70-79 skips debate)."""
    rc, out = run_review_gate(score=75, p0_count=0, hotfix=True)
    assert out.get("ROUTE") == "pass", f"hotfix score 75 must pass, got ROUTE={out.get('ROUTE')}"


def test_hotfix_score_70_passes():
    """Score 70 with hotfix passes."""
    rc, out = run_review_gate(score=70, p0_count=0, hotfix=True)
    assert out.get("ROUTE") == "pass", f"hotfix score 70 must pass, got ROUTE={out.get('ROUTE')}"


def test_hotfix_score_69_rework():
    """Score < 70 with hotfix routes to rework."""
    rc, out = run_review_gate(score=69, p0_count=0, hotfix=True)
    assert out.get("ROUTE") == "rework", f"hotfix score 69 must rework, got ROUTE={out.get('ROUTE')}"


def test_hotfix_score_65_rework():
    """Score 65 with hotfix routes to rework."""
    rc, out = run_review_gate(score=65, p0_count=0, hotfix=True)
    assert out.get("ROUTE") == "rework", f"hotfix score 65 must rework, got ROUTE={out.get('ROUTE')}"


def test_normal_score_75_debate():
    """Without hotfix, score 75 still triggers debate."""
    rc, out = run_review_gate(score=75, p0_count=0, hotfix=False)
    assert out.get("ROUTE") == "debate", f"normal score 75 must debate, got ROUTE={out.get('ROUTE')}"


def test_normal_score_85_passes():
    """Without hotfix, score 85 passes normally."""
    rc, out = run_review_gate(score=85, p0_count=0, hotfix=False)
    assert out.get("ROUTE") == "pass", f"normal score 85 must pass, got ROUTE={out.get('ROUTE')}"


def test_hotfix_accepts_flag():
    """review-gate.py accepts --hotfix without error."""
    with tempfile.TemporaryDirectory() as tmpdir:
        review_file = os.path.join(tmpdir, "review-result.json")
        output_file = os.path.join(tmpdir, "review-gate-result.txt")
        with open(review_file, "w") as f:
            json.dump({"score": 80, "p0_count": 0, "problem_dimension": "code", "details": ""}, f)

        result = subprocess.run(
            [sys.executable, REVIEW_GATE, "--hotfix", review_file, output_file],
            capture_output=True, text=True
        )
        assert result.returncode == 0, f"--hotfix should be accepted, got stderr: {result.stderr}"


def test_p0_default_no_auto_issue():
    """v1.23.0: P0 still blocks, but no GitLab issue is auto-created by default."""
    rc, out = run_review_gate(score=90, p0_count=2,
                              env_extra={"GITLAB_TOKEN": "dummy-token"})
    assert out.get("ROUTE") == "block", f"P0 must block, got ROUTE={out.get('ROUTE')}"
    assert out.get("SCORE") == "0", f"P0 must force score=0, got SCORE={out.get('SCORE')}"
    assert out.get("ISSUE_IID") == "", \
        f"default OFF: no auto-created issue, got ISSUE_IID={out.get('ISSUE_IID')!r}"


def test_p0_legacy_disable_still_off():
    """Legacy CI_DISABLE_ISSUE_CREATE=1 still forces issue creation off."""
    rc, out = run_review_gate(score=90, p0_count=1,
                              env_extra={"GITLAB_TOKEN": "dummy-token",
                                         "CI_DISABLE_ISSUE_CREATE": "1"})
    assert out.get("ROUTE") == "block"
    assert out.get("ISSUE_IID") == ""


if __name__ == "__main__":
    results = {"passed": 0, "failed": 0}
    tests = [
        ("test_hotfix_p0_blocks", test_hotfix_p0_blocks),
        ("test_hotfix_score_75_passes_no_debate", test_hotfix_score_75_passes_no_debate),
        ("test_hotfix_score_70_passes", test_hotfix_score_70_passes),
        ("test_hotfix_score_69_rework", test_hotfix_score_69_rework),
        ("test_hotfix_score_65_rework", test_hotfix_score_65_rework),
        ("test_normal_score_75_debate", test_normal_score_75_debate),
        ("test_normal_score_85_passes", test_normal_score_85_passes),
        ("test_hotfix_accepts_flag", test_hotfix_accepts_flag),
        ("test_p0_default_no_auto_issue", test_p0_default_no_auto_issue),
        ("test_p0_legacy_disable_still_off", test_p0_legacy_disable_still_off),
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
