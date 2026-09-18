#!/usr/bin/env python3
"""ci-architect — Issue 触发 Architect 通过 rd CLI 生成 SPEC 制品

用法:
  ci-architect.py run --issue-iid=<iid> [--model=<model>] [--max-turns=<n>] [--rework]

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
import urllib.error
import urllib.request

# ─── 常量 ───

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(SCRIPT_DIR, "..", "ci-bridge.sh")
BRIDGE_PY = os.path.join(SCRIPT_DIR, "ci", "bridge.py")
CI_RUN_AGENT = os.path.join(SCRIPT_DIR, "ci", "ci-run-agent.js")
GITLAB_URL = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
PROJECT_ID = os.environ.get("CI_PROJECT_ID", "")
TOKEN = os.environ.get("GITLAB_TOKEN", "")
DEFAULT_BRANCH = os.environ.get("CI_DEFAULT_BRANCH", "dev")


# ─── GitLab 轻量 API ───

def _api_request(path: str, method: str = "GET", data: dict | None = None,
                 timeout: int = 30, retries: int = 3) -> typing.Any:
    url = f"{GITLAB_URL}/projects/{PROJECT_ID}{path}"
    body = json.dumps(data).encode() if data else None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, data=body, method=method)
            req.add_header("PRIVATE-TOKEN", TOKEN)
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", "ci-architect/1.0")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode()
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    return raw
        except (urllib.error.HTTPError, OSError):
            if attempt >= retries:
                raise
            time.sleep(min(5 * attempt, 15))
    raise SystemExit(f"[ci-architect] Error: API request failed after {retries} retries")


def run_bridge(*args: str) -> str:
    result = subprocess.run(
        ["bash", BRIDGE, *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    return result.stdout.strip()


def run_bridge_ok(*args: str) -> bool:
    return subprocess.run(
        ["bash", BRIDGE, *args],
        capture_output=True, text=True).returncode == 0


def run_git(*args: str):
    return subprocess.run(["git", *args], capture_output=True, text=True)


def _emit_note(issue_iid: str, message: str, event: str, stage: str = "architect",
               metadata: dict | None = None):
    """写入结构化 Note（含 rd_harness:metadata HTML 注释）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("bridge", BRIDGE_PY)
    if spec is None or spec.loader is None:
        return
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    rd_meta = mod.build_metadata(event, stage, metadata)
    try:
        _api_request(f"/issues/{issue_iid}/notes", method="POST",
                     data={"body": f"{message}\n\n<!-- rd_harness:metadata\n{json.dumps(rd_meta, ensure_ascii=False, indent=2)}\n-->"})
    except Exception:
        pass


def on_failure(issue_iid: str, is_rework: bool, msg: str):
    print(f"[ci-architect] Error: {msg}", file=sys.stderr)
    if issue_iid and TOKEN:
        fallback = "ai-spec-rework" if is_rework else "ai-todo"
        run_bridge_ok("update-issue-label", issue_iid,
                      f"--add={fallback}", "--remove=ai-architect")
        _emit_note(issue_iid, f"⚠️ CI-AI-FAIL {msg}，已回退为 {fallback}",
                   event="error", metadata={"error_type": "architect_failure",
                                            "error_message": msg})


# ─── 主逻辑 ───

def cmd_run(issue_iid: str, model: str, max_turns: str,
            is_rework: bool, feature_name: str = ""):
    if not issue_iid:
        print("[ci-architect] Error: --issue-iid is required", file=sys.stderr)
        raise SystemExit(1)
    if not TOKEN:
        print("[ci-architect] Error: GITLAB_TOKEN is required", file=sys.stderr)
        raise SystemExit(1)

    # ── 0. 更新 label ──
    run_bridge("update-issue-label", issue_iid,
               "--add=ai-architect", "--remove=ai-todo,ai-spec-rework")

    change_name = f"issue-{issue_iid}"
    if feature_name:
        change_name += f"-{feature_name}"
    spec_dir = f".harness/spec/changes/{change_name}"

    # ── 0.7 Emit stage_start ──
    start_time = time.time()
    _emit_note(issue_iid, "🏗 Architect 开始生成 SPEC" if not is_rework else "🔄 Architect 开始修改 SPEC",
               event="stage_start", metadata={"trigger_label": os.environ.get("TRIGGER_LABEL", ""),
                                               "rework_count": 1 if is_rework else 0,
                                               "model": model})

    # ── 0.5 Rework: 读取 Review 反馈 ──
    rework_context = ""
    if is_rework:
        print("[ci-architect] Rework mode: fetching review feedback...")
        try:
            notes = _api_request(f"/issues/{issue_iid}/notes?sort=desc&per_page=5")
            keywords = ['Review 评分', '评审摘要', 'REWORK']
            review_notes = [n['body'] for n in (notes if isinstance(notes, list) else [])
                            if any(k in n.get('body', '') for k in keywords)]
            if review_notes:
                rework_context = ("\n【上次 Review 反馈】\n" + review_notes[0] +
                                  "\n\n请根据以上反馈修改 SPEC 制品。")
                print("[ci-architect] Review feedback loaded")
        except Exception:
            pass

    # ── 1. 读取 Issue ──
    print(f"[ci-architect] Reading Issue !{issue_iid}...")
    try:
        issue_data = _api_request(f"/issues/{issue_iid}")
    except Exception as e:
        on_failure(issue_iid, is_rework, f"Failed to read issue: {e}")
        raise SystemExit(1)

    issue_title = issue_data.get("title", "Untitled")
    issue_desc = issue_data.get("description", "")
    if not issue_desc:
        on_failure(issue_iid, is_rework, f"Issue !{issue_iid} has no description")
        raise SystemExit(1)

    # ── 1.5 Rework: 检查 count + 关闭旧 MR ──
    if is_rework:
        mr_lines = run_bridge("list-issue-mrs", issue_iid, "--state=opened").splitlines()
        mr_count = len([l for l in mr_lines if l.strip()])
        print(f"[ci-architect] Rework: {mr_count} open MR(s) for Issue !{issue_iid}")
        for mr_line in mr_lines:
            if mr_line.strip():
                old_mr_iid = mr_line.split()[0]
                print(f"[ci-architect] Closing old MR !{old_mr_iid}")
                run_bridge_ok("close-mr", old_mr_iid)

        all_lines = run_bridge("list-issue-mrs", issue_iid).splitlines()
        total_mr = sum(1 for l in all_lines if "opened" in l)
        max_rework = 20
        if total_mr >= max_rework:
            print(f"[ci-architect] Rework limit reached ({total_mr} >= {max_rework}), blocking")
            run_bridge("update-issue-label", issue_iid,
                       "--add=ai-blocked", "--remove=ai-spec-rework,ai-architect")
            run_bridge("add-note", issue_iid,
                       f"--message=⚠️ SPEC rework 已达上限（{max_rework} 次），需要 PM 介入")
            _emit_note(issue_iid, f"⚠️ SPEC rework 已达上限（{max_rework} 次），需要 PM 介入",
                       event="error", metadata={"error_type": "rework_limit",
                                                "error_message": f"rework {max_rework} times exceeded"})
            raise SystemExit(1)

    # ── 2. 创建工作分支 ──
    branch = f"ci/ai-spec-{issue_iid}"
    if feature_name:
        branch += f"-{feature_name}"
    run_git("stash", "-u")
    run_git("checkout", "-B", branch)
    run_git("reset", "--hard", f"origin/{branch}")

    # ── 3. 创建变更目录 ──
    print(f"[ci-architect] Creating change: {change_name}...")
    if os.path.isdir(spec_dir):
        print("[ci-architect] Change directory already exists, reusing")
    else:
        subprocess.run(
            ["rd", "new", "change", change_name,
             "--description", f"Issue #{issue_iid}: {issue_title}",
             "--schema", "spec-driven"],
            check=True,
        )

    # ── 4. 逐制品生成 ──
    print("[ci-architect] Generating SPEC artifacts via rd CLI...")
    max_iterations = 10
    turns_per_artifact = max(int(max_turns) // 4, 8)

    for iteration in range(1, max_iterations + 1):
        # 获取当前状态
        status_result = subprocess.run(
            ["rd", "status", "--change", change_name, "--json"],
            capture_output=True, text=True,
        )
        if status_result.returncode != 0:
            on_failure(issue_iid, is_rework, f"rd status failed: {status_result.stderr}")
            raise SystemExit(1)

        status = json.loads(status_result.stdout)
        if status.get("isComplete"):
            print("[ci-architect] All artifacts complete")
            break

        # 找下一个未完成的制品
        artifacts = status.get("artifacts", [])
        next_artifact = next((a["id"] for a in artifacts if a.get("status") != "done"), "")
        if not next_artifact:
            print("[ci-architect] No more artifacts to generate")
            break

        print(f"[ci-architect] Generating artifact: {next_artifact} ({iteration}/{max_iterations})...")

        # 获取制品指令
        instr_result = subprocess.run(
            ["rd", "instructions", next_artifact, "--change", change_name, "--json"],
            capture_output=True, text=True,
        )
        if instr_result.returncode != 0:
            on_failure(issue_iid, is_rework, f"rd instructions {next_artifact} failed: {instr_result.stderr}")
            raise SystemExit(1)

        instr = json.loads(instr_result.stdout)
        template = instr.get("template", "")
        instruction = instr.get("instruction", "")
        output_path = instr.get("outputPath", "")

        # 读取依赖制品内容
        dep_context = ""
        for dep in instr.get("dependencies", []):
            if dep.get("status") == "done" and dep.get("outputPath"):
                dep_path = os.path.join(spec_dir, dep["outputPath"])
                if os.path.isfile(dep_path):
                    try:
                        with open(dep_path) as f:
                            dep_context += f"--- {dep['outputPath']} ---\n{f.read()}\n\n"
                    except OSError:
                        pass

        # specs 制品特殊处理
        if next_artifact == "specs":
            specs_dir = os.path.join(spec_dir, "specs")
            if os.path.isdir(specs_dir):
                for root, _, files in os.walk(specs_dir):
                    for fn in files:
                        if fn == "spec.md":
                            dep_context += f"--- 已有 spec: {os.path.relpath(os.path.join(root, fn), spec_dir)} ---\n"

        # 调用 claude
        prompt = f"""你是 Architect 角色。为 Issue #{issue_iid} 创建「{next_artifact}」制品。

【Issue 内容】
标题：{issue_title}
描述：
{issue_desc}
{rework_context}
【制品指令】
{instruction}

【模板】
{template}

【依赖制品】
{dep_context}

【约束】
- 只能在 {spec_dir}/ 目录下创建/修改文件
- 输出路径：{spec_dir}/{output_path}
- 严格遵循模板结构
- context 和 rules 是指导，不要写入输出文件
- 不得执行 git push"""

        subprocess.run(
            ["node", CI_RUN_AGENT,
             "--model", model,
             "--max-turns", str(turns_per_artifact),
             "--allowed-tools", "Bash(find*),Bash(ls*),Bash(cat*),Bash(grep*),Bash(mkdir*),Read,Write,Edit",
             "--output-format", "json"],
            input=prompt, text=True, check=False,
        )
        print(f"[ci-architect] Artifact {next_artifact} generated")

    # ── 5. 验证所有制品 ──
    final_result = subprocess.run(
        ["rd", "status", "--change", change_name, "--json"],
        capture_output=True, text=True,
    )
    final_status = json.loads(final_result.stdout)
    if not final_status.get("isComplete"):
        missing = ", ".join(a["id"] for a in final_status.get("artifacts", [])
                            if a.get("status") != "done")
        on_failure(issue_iid, is_rework, f"SPEC 制品未完成: {missing}")
        raise SystemExit(1)

    # ── 6. 提交并推送 ──
    run_git("add", f"{spec_dir}/")
    commit_result = run_git("commit", "-m",
                            f"ci-architect: SPEC for Issue #{issue_iid} — {issue_title}")
    if commit_result.returncode != 0:
        print("[ci-architect] No changes to commit (SPEC already up to date)")

    p = run_git("push", "--force-with-lease", "origin", branch)
    if p.returncode != 0:
        run_git("push", "origin", branch)

    # ── 7. 创建 SPEC MR ──
    print("[ci-architect] Creating SPEC MR...")
    mr_result = subprocess.run(
        ["bash", BRIDGE, "create-mr",
         f"--source={branch}",
         f"--target={DEFAULT_BRANCH}",
         f"--title=Architect: SPEC for Issue #{issue_iid}",
         "--labels=ci-ai,spec-review",
         f"--issue-iid={issue_iid}"],
        capture_output=True, text=True,
    )
    if mr_result.returncode != 0:
        on_failure(issue_iid, is_rework, "Failed to create MR")
        raise SystemExit(1)

    # ── 8. 更新 label → ai-spec-review ──
    run_bridge("update-issue-label", issue_iid,
               "--add=ai-spec-review", "--remove=ai-architect")

    # ── 9. Emit stage_complete + spec_transition ──
    elapsed = int(time.time() - start_time)
    _emit_note(issue_iid, f"✅ SPEC 已生成",
               event="stage_complete", metadata={"duration_seconds": elapsed, "model": model})
    _emit_note(issue_iid, f"📋 SPEC 状态变更: draft → review",
               event="spec_transition",
               metadata={"spec_status": "review", "change_name": change_name})

    print(f"[ci-architect] Complete: MR created, Issue !{issue_iid} → ai-spec-review")


# ─── CLI ───

def main():
    parser = argparse.ArgumentParser(
        description="ci-architect — rd CLI 驱动生成 SPEC 制品",
        prog="ci-architect.py",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run", help="生成 SPEC")
    p.add_argument("--issue-iid", default="")
    p.add_argument("--feature", default="")
    p.add_argument("--model", default=os.environ.get("CLAUDE_MODEL", "sonnet"))
    p.add_argument("--max-turns", default=os.environ.get("CLAUDE_MAX_TURNS", "20"))
    p.add_argument("--rework", action="store_true", default=False)

    args = parser.parse_args()
    if args.command == "run":
        cmd_run(
            issue_iid=args.issue_iid,
            model=args.model,
            max_turns=args.max_turns,
            is_rework=args.rework,
            feature_name=getattr(args, 'feature', ''),
        )


if __name__ == "__main__":
    main()
