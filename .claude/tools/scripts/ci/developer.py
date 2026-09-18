#!/usr/bin/env python3
"""ci-developer — rd instructions apply 驱动的代码实施

用法:
  ci-developer.py run --issue-iid=<iid> --change=<name> [--model=<model>] [--max-turns=<n>] [--rework]

仅依赖 Python stdlib + Node.js + rd CLI + CI run agent + git，无需外部包。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import typing

# ─── 常量 ───

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(SCRIPT_DIR, "..", "ci-bridge.sh")
BRIDGE_PY = os.path.join(SCRIPT_DIR, "ci", "bridge.py")
CI_RUN_AGENT = os.path.join(SCRIPT_DIR, "ci", "ci-run-agent.js")
GITLAB_URL = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
PROJECT_ID = os.environ.get("CI_PROJECT_ID", "")
TOKEN = os.environ.get("GITLAB_TOKEN", "")
DEFAULT_BRANCH = os.environ.get("CI_DEFAULT_BRANCH", "dev")


# ─── GitLab 轻量客户端（仅 ci-developer 需要的操作）──

def _api_get(path: str) -> typing.Any:
    import urllib.request
    url = f"{GITLAB_URL}/projects/{PROJECT_ID}{path}"
    req = urllib.request.Request(url)
    req.add_header("PRIVATE-TOKEN", TOKEN)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _api_post(path: str, data: dict) -> None:
    import urllib.request
    url = f"{GITLAB_URL}/projects/{PROJECT_ID}{path}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body)
    req.add_header("PRIVATE-TOKEN", TOKEN)
    req.add_header("Content-Type", "application/json")
    try:
        urllib.request.urlopen(req, timeout=30)
    except Exception as e:
        print(f"[ci-developer] Warning: API call failed: {e}", file=sys.stderr)


# ─── 辅助函数 ───

def run_bridge(*args: str) -> str:
    """调用 ci-bridge.sh，返回 stdout。"""
    result = subprocess.run(
        ["bash", BRIDGE, *args],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    return result.stdout.strip()


def run_bridge_ok(*args: str) -> bool:
    """调用 ci-bridge.sh，返回是否成功。"""
    result = subprocess.run(
        ["bash", BRIDGE, *args],
        capture_output=True, text=True,
    )
    return result.returncode == 0


def run_git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True)


def _emit_note(issue_iid: str, message: str, event: str, stage: str = "develop",
               metadata: dict | None = None):
    """写入结构化 Note（含 rd_harness:metadata HTML 注释）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("bridge", BRIDGE_PY)
    if spec is None or spec.loader is None:
        return
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    rd_meta = mod.build_metadata(event, stage, metadata)
    _api_post(f"/issues/{issue_iid}/notes",
              {"body": f"{message}\n\n<!-- rd_harness:metadata\n{json.dumps(rd_meta, ensure_ascii=False, indent=2)}\n-->"})


def fetch_issue_notes(issue_iid: str, limit: int = 5) -> list[dict]:
    """获取 Issue 的 notes。"""
    try:
        return _api_get(f"/issues/{issue_iid}/notes?sort=desc&per_page={limit}")
    except Exception:
        return []


# ─── on_failure ───

def on_failure(issue_iid: str, is_rework: bool, msg: str):
    print(f"[ci-developer] Error: {msg}", file=sys.stderr)
    if issue_iid:
        fallback = "ai-code-rework" if is_rework else "ai-develop"
        run_bridge_ok("update-issue-label", issue_iid,
                      f"--add={fallback}", "--remove=ai-develop")
        _emit_note(issue_iid, f"⚠️ CI-AI-FAIL {msg}",
                   event="error", metadata={"error_type": "developer_failure",
                                            "error_message": msg})


# ─── 主逻辑 ───

def cmd_run(issue_iid: str, change_name: str, model: str,
            max_turns: str, is_rework: bool, feature_name: str = ""):
    if not change_name:
        print("[ci-developer] Error: --change is required", file=sys.stderr)
        raise SystemExit(1)

    # ── 0. 更新 label ──
    if issue_iid:
        run_bridge("update-issue-label", issue_iid,
                   "--add=ai-develop", "--remove=ai-develop,ai-code-rework")

    # ── 0.1 Emit stage_start ──
    start_time = time.time()
    if issue_iid:
        _emit_note(issue_iid,
                   "🔧 Developer 修复代码评审问题..." if is_rework else f"💻 Developer 开始实现 SPEC: {change_name}",
                   event="stage_start",
                   metadata={"trigger_label": os.environ.get("TRIGGER_LABEL", ""),
                             "rework_count": 1 if is_rework else 0,
                             "model": model})

    # ── 0.5 Rework: 读取 Review 反馈 ──
    rework_context = ""
    if is_rework and issue_iid:
        print("[ci-developer] Rework mode: fetching review feedback...")
        notes = fetch_issue_notes(issue_iid, limit=5)
        keywords = ['代码评审', 'BLOCKED', 'REWORK', 'P0']
        review_notes = [n['body'] for n in notes
                        if any(k in n.get('body', '') for k in keywords)]
        if review_notes:
            rework_context = (
                "\n【上次 Code Review 反馈】\n" +
                review_notes[0] +
                "\n\n请根据以上反馈修改代码。"
            )
            print("[ci-developer] Review feedback loaded")

    # ── 0.7 Rework: 检查 rework 计数，关闭旧 MR ──
    if is_rework and issue_iid:
        mr_lines = run_bridge("list-issue-mrs", issue_iid, "--state=opened").splitlines()
        mr_count = len([l for l in mr_lines if l.strip()])
        print(f"[ci-developer] Rework: {mr_count} open MR(s) for Issue !{issue_iid}")

        for mr_line in mr_lines:
            if mr_line.strip():
                old_mr_iid = mr_line.split()[0]
                print(f"[ci-developer] Closing old MR !{old_mr_iid}")
                run_bridge_ok("close-mr", old_mr_iid)

        all_mr_lines = run_bridge("list-issue-mrs", issue_iid).splitlines()
        total_mr_count = sum(1 for l in all_mr_lines if "opened" in l)
        max_rework = 20
        if total_mr_count >= max_rework:
            print(f"[ci-developer] Rework limit reached ({total_mr_count} >= {max_rework}), blocking")
            run_bridge("update-issue-label", issue_iid,
                       "--add=ai-blocked", "--remove=ai-code-rework,ai-develop")
            _api_post(f"/issues/{issue_iid}/notes",
                      {"body": f"⚠️ Code rework 已达上限（{max_rework} 次），需要 PM 介入"})
            _emit_note(issue_iid, f"⚠️ Code rework 已达上限（{max_rework} 次），需要 PM 介入",
                       event="error", metadata={"error_type": "rework_limit",
                                                "error_message": f"rework {max_rework} times exceeded"})
            raise SystemExit(1)

    change_dir = f".harness/spec/changes/{change_name}"

    # ── 获取 SPEC（如果本地没有，从 spec branch 拉取）──
    if not os.path.isdir(change_dir) and issue_iid:
        spec_branch = f"ci/ai-spec-{issue_iid}"
        print(f"[ci-developer] SPEC not found locally, fetching from {spec_branch}...")
        run_git("fetch", "origin", spec_branch)
        run_git("checkout", "-f", f"origin/{spec_branch}", "--", f"{change_dir}/")
    if not os.path.isdir(change_dir):
        on_failure(issue_iid, is_rework, f"Change '{change_name}' not found")
        raise SystemExit(1)

    # ── 1. 获取 apply 指令 ──
    print(f"[ci-developer] Reading apply instructions for {change_name}...")
    rd_result = subprocess.run(
        ["rd", "instructions", "apply", "--change", change_name, "--json"],
        capture_output=True, text=True,
    )
    if rd_result.returncode != 0:
        on_failure(issue_iid, is_rework, f"rd instructions apply failed: {rd_result.stderr}")
        raise SystemExit(1)

    apply_json = json.loads(rd_result.stdout)
    progress = apply_json.get("progress", {})
    progress_total = progress.get("total", 0)
    progress_complete = progress.get("complete", 0)
    progress_remaining = progress.get("remaining", 0)

    print(f"[ci-developer] Progress: {progress_complete}/{progress_total} done, {progress_remaining} remaining")

    if progress_remaining == 0:
        print("[ci-developer] All tasks already complete")
        return

    # ── 2. 读取上下文文件 ──
    context_files = apply_json.get("contextFiles", {})
    context_content = ""
    seen_files = set()
    for files in context_files.values():
        for f in files:
            if f and f not in seen_files and os.path.isfile(f):
                seen_files.add(f)
                try:
                    with open(f) as fh:
                        content = "".join(fh.readline() for _ in range(200))
                    context_content += f"--- {os.path.basename(f)} ---\n{content}\n\n"
                except OSError:
                    pass

    # ── 3. 获取待实施任务列表 ──
    pending_lines = []
    for t in apply_json.get("tasks", []):
        if not t.get("done", True):
            pending_lines.append(f"- [{t['id']}] {t['description']}")
    pending_tasks = "\n".join(pending_lines)

    if not pending_tasks:
        print("[ci-developer] No pending tasks found in instructions")
        return

    # ── 4. 创建工作分支 ──
    branch = f"ci/ai-spec-{issue_iid}"
    if feature_name:
        branch += f"-{feature_name}"
    run_git("stash", "-u")
    run_git("checkout", "-B", branch)
    run_git("reset", "--hard", f"origin/{branch}")

    # ── 5. 调用 claude 实施 ──
    if is_rework:
        print("[ci-developer] Starting rework (fixing review issues)...")
        prompt = f"""你是 Developer 角色。代码评审未通过，需要根据评审意见修复代码。

【代码评审反馈】
{rework_context}

【当前代码在分支: {branch}】

【权限约束】
- 只修复评审指出的问题，不要重新实现或添加新功能
- 不得修改 .harness/spec/ 中的 SPEC 工作区
- 不得执行 git push --force、git reset --hard 等破坏性操作
- 不得修改 CI 配置文件（.gitlab-ci.yml）

执行步骤：
1. 阅读评审反馈，理解需要修复的问题
2. 定位问题代码（使用 git diff、grep 等工具）
3. 逐一修复评审指出的每个问题
4. 确认修复后测试通过
5. git commit + git push

commit 格式：[CI-AI][{change_name}][AI.Developer] 修复 Issue #{issue_iid} 代码评审问题"""
    else:
        print(f"[ci-developer] Starting implementation ({progress_remaining} tasks)...")
        prompt = f"""你是 Developer 角色。实施变更「{change_name}」的剩余任务。

【上下文文件】
{context_content}

【待实施任务 ({progress_remaining}/{progress_total} 剩余)】
{pending_tasks}

【权限约束】
- 不得修改 .harness/spec/ 中的 SPEC 工作区
- 不得执行 git push --force、git reset --hard 等破坏性操作
- 不得修改 CI 配置文件（.gitlab-ci.yml）

执行步骤：
1. 阅读上述上下文文件理解需求和设计
2. 按任务顺序逐个实施
3. 每个任务：写测试（如适用）→ 实现 → 验证通过
4. 完成一个任务后，在 {change_dir}/tasks.md 中将 `- [ ]` 改为 `- [x]`
5. 确保所有测试通过
6. 提交代码

commit 格式：[CI-AI][{change_name}][AI.Developer] 实施 Issue #{issue_iid}"""

    subprocess.run(
        ["node", CI_RUN_AGENT,
         "--model", model,
         "--max-turns", max_turns,
         "--allowed-tools", "Bash(*),Read,Write,Edit,LSP,NotebookEdit",
         "--output-format", "json"],
        input=prompt, text=True, check=False,
    )

    # ── 6. 验证实施结果 ──
    tasks_file = os.path.join(change_dir, "tasks.md")
    if os.path.isfile(tasks_file):
        try:
            with open(tasks_file) as f:
                remaining = sum(1 for line in f if line.startswith("- [ ]"))
        except OSError:
            remaining = 0
        print(f"[ci-developer] Tasks remaining: {remaining}")
        if remaining > 0:
            print(f"[ci-developer] Warning: {remaining} tasks still pending")

    # ── 7. 推送并创建 MR ──
    run_git("pull", "--rebase", "origin", branch)
    p = run_git("push", "--force-with-lease", "origin", branch)
    if p.returncode != 0:
        run_git("push", "origin", branch)

    print("[ci-developer] Creating code MR...")
    mr_result = subprocess.run(
        ["bash", BRIDGE, "create-mr",
         f"--source={branch}",
         f"--target={DEFAULT_BRANCH}",
         f"--title=Developer: Implementation for Issue #{issue_iid}",
         "--labels=ci-ai,code-review",
         f"--issue-iid={issue_iid}"],
        capture_output=True, text=True,
    )
    if mr_result.returncode != 0:
        on_failure(issue_iid, is_rework, "Failed to create MR")
        raise SystemExit(1)

    # ── 8. 触发 P2 ──
    if issue_iid:
        elapsed = int(time.time() - start_time)
        _emit_note(issue_iid,
                   "✅ 代码评审问题修复完成" if is_rework else "📝 SPEC 实现完成",
                   event="stage_complete",
                   metadata={"duration_seconds": elapsed, "model": model})
        ok = run_bridge_ok("update-issue-label", issue_iid,
                           "--trigger-next", "--add=ai-code-review",
                           "--remove=ai-develop",
                           f"--extra-vars=FEATURE_BRANCH={branch}")
        if ok:
            print(f"[ci-developer] Complete: MR created, Issue !{issue_iid} → ai-code-review")
        else:
            print(f"[ci-developer] WARNING: MR created but pipeline trigger FAILED for Issue !{issue_iid}",
                  file=sys.stderr)
            print("[ci-developer] Label ai-code-review is set. Verify P2 pipeline was triggered.",
                  file=sys.stderr)
    else:
        print("[ci-developer] Complete: MR created")


# ─── CLI ───

def main():
    parser = argparse.ArgumentParser(
        description="ci-developer — rd instructions apply 驱动的代码实施",
        prog="ci-developer.py",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run", help="执行代码实施")
    p.add_argument("--issue-iid", default="")
    p.add_argument("--change", default="")
    p.add_argument("--model", default=os.environ.get("CLAUDE_MODEL", "sonnet"))
    p.add_argument("--max-turns", default=os.environ.get("CLAUDE_MAX_TURNS", "20"))
    p.add_argument("--feature", default="")
    p.add_argument("--rework", action="store_true", default=False)

    args = parser.parse_args()

    if args.command == "run":
        cmd_run(
            issue_iid=args.issue_iid,
            change_name=args.change,
            model=args.model,
            max_turns=args.max_turns,
            is_rework=args.rework,
            feature_name=getattr(args, 'feature', ''),
        )


if __name__ == "__main__":
    main()
