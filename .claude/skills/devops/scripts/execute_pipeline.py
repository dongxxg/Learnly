#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import json
import sys
import argparse

API_URL = "http://192.168.118.247:2011/api/devops/pipeline/excute"
REFS_LIST_URL = "http://192.168.118.247:2011/api/devops/pipeline/repo/refs/list"

def check_repo_refs(token, pipeline_id):
    """构建前置检查：查询流水线关联仓库的 refs（branches/tags）。

    POST /api/devops/pipeline/repo/refs/list，body {"id": pipeline_id}。
    成功（code==0000 且 data 含非空 branches）返回分支/标签供展示；
    无可用分支、code!=0000 或请求异常均返回 success=False（阻断构建）。
    """

    request_body = {"id": pipeline_id}
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Authorization": f"bearer {token}",
        "Content-Type": "application/json; charset=UTF-8"
    }

    try:
        response = requests.post(
            REFS_LIST_URL,
            json=request_body,
            headers=headers,
            verify=False,
            timeout=30
        )
        result = response.json()

        if result.get("code") == "0000" and isinstance(result.get("data"), dict):
            data = result["data"]
            branches = data.get("branches") or []
            tags = data.get("tags") or []
            repo_url = data.get("repoUrl") or ""
            if not branches:
                return {
                    "success": False,
                    "error": f"仓库 {repo_url or pipeline_id} 无可用分支，阻断构建"
                }
            return {
                "success": True,
                "repo_url": repo_url,
                "branches": branches,
                "tags": tags,
            }
        else:
            return {
                "success": False,
                "error": result.get("tip") or result.get("msg") or "refs 检查失败",
                "code": result.get("code")
            }

    except requests.exceptions.RequestException as e:
        return {"success": False, "error": f"refs 检查连接失败: {str(e)}"}
    except json.JSONDecodeError as e:
        return {"success": False, "error": f"refs 检查响应格式错误: {str(e)}"}
    except Exception as e:
        return {"success": False, "error": f"refs 检查未知错误: {str(e)}"}

def execute_pipeline(token, pipeline_id, branch=None):
    """Execute a DevOps pipeline by ID. Optional branch selects the ref to build."""

    # Build request body
    request_body = {
        "id": pipeline_id
    }
    if branch:
        request_body["branch"] = branch

    # Build request headers
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Authorization": f"bearer {token}",
        "Content-Type": "application/json; charset=UTF-8"
    }

    try:
        # Make HTTP request (ignore SSL verification)
        response = requests.post(
            API_URL,
            json=request_body,
            headers=headers,
            verify=False,
            timeout=30
        )

        # Parse response
        result = response.json()

        # Check response code
        if result.get("code") == "0000":
            # Success
            return {
                "success": True,
                "message": result.get("tip") or result.get("msg") or "流水线执行成功",
                "data": result.get("data")
            }
        else:
            # Error
            error_msg = result.get("tip") or result.get("msg") or "未知错误"
            return {
                "success": False,
                "error": error_msg,
                "code": result.get("code")
            }

    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "error": f"连接目标服务失败: {str(e)}"
        }
    except json.JSONDecodeError as e:
        return {
            "success": False,
            "error": f"响应数据格式错误: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"未知错误: {str(e)}"
        }

def main():
    # Disable SSL warnings
    requests.packages.urllib3.disable_warnings()

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Execute DevOps pipeline")
    parser.add_argument("token", help="Authorization token (without 'bearer ' prefix)")
    parser.add_argument("pipeline_id", help="Pipeline ID to execute")
    parser.add_argument("--branch", help="Build ref/branch (e.g. master). Omit to pick interactively from refs/list.")

    args = parser.parse_args()

    # 构建前置检查：查询仓库 refs（分支/标签）。失败或无可用分支则阻断，不触发构建。
    refs_result = check_repo_refs(args.token, args.pipeline_id)
    if not refs_result["success"]:
        print(f"\n❌ 构建前检查失败: {refs_result['error']}", file=sys.stderr)
        if refs_result.get("code"):
            print(f"错误代码: {refs_result['code']}", file=sys.stderr)
        sys.exit(1)
    branches = refs_result["branches"]
    print(f"\n📦 仓库: {refs_result['repo_url'] or '未知'}")
    print(f"  可用分支: {', '.join(branches)}")
    if refs_result["tags"]:
        print(f"  标签: {', '.join(refs_result['tags'])}")

    # 选择构建分支：--branch 指定则校验存在性；未指定则交互式展示选择。
    chosen_branch = args.branch
    if chosen_branch:
        if chosen_branch not in branches:
            print(f"\n❌ 分支 {chosen_branch} 不在可用分支列表中: {', '.join(branches)}", file=sys.stderr)
            sys.exit(1)
    else:
        print("\n请选择构建分支：")
        for i, b in enumerate(branches, 1):
            print(f"  [{i}] {b}")
        while True:
            try:
                choice = input(f"输入编号 (1-{len(branches)}) 或分支名: ").strip()
            except EOFError:
                print("无输入，已取消构建", file=sys.stderr)
                sys.exit(1)
            if choice.isdigit() and 1 <= int(choice) <= len(branches):
                chosen_branch = branches[int(choice) - 1]
                break
            elif choice in branches:
                chosen_branch = choice
                break
            print("无效选择，请重试")
    print(f"\n🚀 使用分支 [{chosen_branch}] 构建...")

    # Execute pipeline（带选中分支）
    result = execute_pipeline(args.token, args.pipeline_id, chosen_branch)

    # Display results
    if result["success"]:
        print(f"\n✅ 成功: {result['message']}")
        if result.get("data"):
            print(f"\n响应数据: {json.dumps(result['data'], ensure_ascii=False, indent=2)}")
    else:
        print(f"\n❌ 错误: {result['error']}", file=sys.stderr)
        if result.get("code"):
            print(f"错误代码: {result['code']}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
