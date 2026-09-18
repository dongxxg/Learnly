#!/usr/bin/env python3
"""ci-detect-changes — 从 git diff 检测变更类型，输出 detect-env.txt"""

import os
import re
import subprocess
import sys


def run_git(*args: str) -> str:
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else ""


def git_show(path: str) -> str:
    result = subprocess.run(["git", "show", f"HEAD:{path}"],
                            capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else ""


def main():
    output_file = sys.argv[1] if len(sys.argv) > 1 else "detect-env.txt"

    code_changed = 0
    spec_approved = 0
    daily_close = 0
    has_tests = 0
    ai_terminal = 0
    ai_archiving = 0
    change_name = ""
    spec_status = ""

    if os.environ.get("DAILY_CLOSE") == "1":
        daily_close = 1

    # 确定比较基准
    base = None
    if os.environ.get("CI_MERGE_REQUEST_DIFF_BASE_SHA"):
        base = os.environ["CI_MERGE_REQUEST_DIFF_BASE_SHA"]
    elif os.environ.get("CI_DEFAULT_BRANCH"):
        base = f"origin/{os.environ['CI_DEFAULT_BRANCH']}"
    else:
        base = "HEAD~1"

    changed_files = run_git("diff", "--name-only", base, "HEAD")
    if not changed_files.strip():
        changed_files = run_git("diff", "--name-only", "HEAD~1", "HEAD")

    # 代码变更检测
    code_pattern = re.compile(r"\.(go|py|ts|tsx|js|jsx|java|rs)$")
    for f in changed_files.splitlines():
        if code_pattern.search(f):
            code_changed = 1
            break

    # 测试文件检测
    test_pattern = re.compile(r"(_test\.go$|test_.*\.py$|.*\.test\.ts$|.*\.spec\.ts$|Test.*\.java$)")
    for f in changed_files.splitlines():
        if test_pattern.search(f):
            has_tests = 1
            break

    # CHANGE_NAME: 从 .openspec.yaml 路径提取
    for f in changed_files.splitlines():
        if ".openspec.yaml" in f:
            m = re.search(r"changes/([^/]+)", f)
            if m:
                change_name = m.group(1)
                break

    # AI_ARCHIVING: tasks.md 全部完成
    if change_name:
        tasks_path = f".harness/spec/changes/{change_name}/tasks.md"
        tasks_content = git_show(tasks_path)
        if tasks_content:
            if not re.search(r"- \[ \]", tasks_content):
                if re.search(r"- \[x\]", tasks_content):
                    ai_archiving = 1

    # SPEC_APPROVED: .spec-meta.yaml status
    for f in changed_files.splitlines():
        if ".spec-meta.yaml" in f:
            content = git_show(f)
            m = re.search(r"^status:\s*(.*)", content, re.MULTILINE)
            if m:
                s = m.group(1).strip()
                if s == "approved":
                    spec_approved = 1
                if s in ("archived", "implemented"):
                    ai_terminal = 1
                    spec_status = s

    # SPEC_APPROVED 备选路径: proposal + design + tasks 都存在
    if not spec_approved and change_name:
        cd = f".harness/spec/changes/{change_name}"
        if git_show(f"{cd}/proposal.md") and git_show(f"{cd}/design.md") and git_show(f"{cd}/tasks.md"):
            spec_approved = 1

    with open(output_file, "w") as f:
        f.write(f"CODE_CHANGED={code_changed}\n")
        f.write(f"SPEC_APPROVED={spec_approved}\n")
        f.write(f"DAILY_CLOSE={daily_close}\n")
        f.write(f"HAS_TESTS={has_tests}\n")
        f.write(f"AI_TERMINAL={ai_terminal}\n")
        f.write(f"AI_ARCHIVING={ai_archiving}\n")
        f.write(f"CHANGE_NAME={change_name}\n")
        f.write(f"SPEC_STATUS={spec_status}\n")

    print(f"[ci-detect] CODE_CHANGED={code_changed} SPEC_APPROVED={spec_approved} "
          f"DAILY_CLOSE={daily_close} HAS_TESTS={has_tests} "
          f"AI_TERMINAL={ai_terminal} AI_ARCHIVING={ai_archiving} "
          f"CHANGE_NAME={change_name}")


if __name__ == "__main__":
    main()
