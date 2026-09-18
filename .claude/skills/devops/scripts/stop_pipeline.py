#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import json
import sys
import argparse

API_URL = "http://192.168.118.247:2011/api/devops/pipeline/stop"

def stop_pipeline(token, pipeline_id, build_number):
    """Stop a running DevOps pipeline"""

    # Build request body
    request_body = {
        "buildNumber": build_number,
        "pipelineId": pipeline_id
    }

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
                "message": result.get("tip") or result.get("msg") or "流水线已停止",
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
    parser = argparse.ArgumentParser(description="Stop DevOps pipeline")
    parser.add_argument("token", help="Authorization token (without 'bearer ' prefix)")
    parser.add_argument("pipeline_id", help="Pipeline ID")
    parser.add_argument("build_number", help="Build number to stop")

    args = parser.parse_args()

    # Stop pipeline
    result = stop_pipeline(args.token, args.pipeline_id, args.build_number)

    # Display results
    if result["success"]:
        print(f"\n✅ 成功: {result['message']}")
        print(f"流水线 ID: {args.pipeline_id}")
        print(f"构建编号: #{args.build_number}")
        if result.get("data"):
            print(f"\n响应数据: {json.dumps(result['data'], ensure_ascii=False, indent=2)}")
    else:
        print(f"\n❌ 错误: {result['error']}", file=sys.stderr)
        if result.get("code"):
            print(f"错误代码: {result['code']}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
