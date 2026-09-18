#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import json
import sys
import argparse

API_URL = "http://192.168.118.247:2011/api/devops/pipeline/log/logstages_describe_list/query"

def get_build_logs(token, pipeline_id):
    """Get build logs information for a pipeline"""

    # Build request headers
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Authorization": f"bearer {token}"
    }

    # Build query parameters
    params = {
        "pipelineId": pipeline_id
    }

    try:
        # Make HTTP request (ignore SSL verification)
        response = requests.get(
            API_URL,
            params=params,
            headers=headers,
            verify=False,
            timeout=30
        )

        # Parse response
        result = response.json()

        # Check response code
        if result.get("code") == "0000":
            # Success
            builds = result.get("data", [])

            if not builds:
                return {
                    "success": True,
                    "builds": [],
                    "latest_build_number": None,
                    "message": "没有找到构建记录"
                }

            # Get latest build number (first item in the list)
            latest_build_number = builds[0].get("id") if builds else None

            return {
                "success": True,
                "builds": builds,
                "latest_build_number": latest_build_number,
                "log_url": f"http://192.168.118.247:2011/pipeline/log/console_text/{pipeline_id}/{latest_build_number}" if latest_build_number else None
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

def format_duration(millis):
    """Format duration in milliseconds to human readable format"""
    if millis is None:
        return "N/A"
    seconds = millis / 1000
    if seconds < 60:
        return f"{seconds:.1f}秒"
    minutes = seconds / 60
    if minutes < 60:
        return f"{minutes:.1f}分钟"
    hours = minutes / 60
    return f"{hours:.1f}小时"

def format_status(status):
    """Format build status"""
    status_map = {
        "SUCCESS": "✅ 成功",
        "FAILURE": "❌ 失败",
        "ABORTED": "⚠️ 已中止",
        "UNSTABLE": "⚠️ 不稳定",
        "IN_PROGRESS": "🔄 进行中"
    }
    return status_map.get(status, status)

def print_build_info(builds, pipeline_id):
    """Print build information"""

    if not builds:
        print("\n没有找到构建记录")
        return

    latest = builds[0]
    build_number = latest.get("id")

    print(f"\n## 最新构建信息")
    print(f"**构建编号**: #{build_number}")
    print(f"**状态**: {format_status(latest.get('status'))}")
    print(f"**持续时间**: {format_duration(latest.get('durationMillis'))}")
    print(f"**日志地址**: http://192.168.118.247:2011/pipeline/log/console_text/{pipeline_id}/{build_number}\n")

    # Print stages
    stages = latest.get("stages", [])
    if stages:
        print("### 构建阶段")
        print("| 阶段名称 | 状态 | 持续时间 |")
        print("|---------|------|---------|")
        for stage in stages:
            stage_name = stage.get("name", "")
            stage_status = format_status(stage.get("status", ""))
            stage_duration = format_duration(stage.get("durationMillis"))
            print(f"| {stage_name} | {stage_status} | {stage_duration} |")

    # Print recent builds summary
    if len(builds) > 1:
        print(f"\n### 最近构建历史 (共 {len(builds)} 次)")
        print("| 构建编号 | 状态 | 持续时间 |")
        print("|---------|------|---------|")
        for build in builds[:5]:  # Show top 5
            build_num = build.get("id", "")
            build_status = format_status(build.get("status", ""))
            build_duration = format_duration(build.get("durationMillis"))
            print(f"| #{build_num} | {build_status} | {build_duration} |")

def main():
    # Disable SSL warnings
    requests.packages.urllib3.disable_warnings()

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Get DevOps pipeline build logs")
    parser.add_argument("token", help="Authorization token (without 'bearer ' prefix)")
    parser.add_argument("pipeline_id", help="Pipeline ID")

    args = parser.parse_args()

    # Get build logs
    result = get_build_logs(args.token, args.pipeline_id)

    # Display results
    if result["success"]:
        print_build_info(result["builds"], args.pipeline_id)
        if result.get("latest_build_number"):
            print(f"\n💡 提示: 最新构建编号为 {result['latest_build_number']}")
    else:
        print(f"\n❌ 错误: {result['error']}", file=sys.stderr)
        if result.get("code"):
            print(f"错误代码: {result['code']}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
