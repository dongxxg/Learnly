#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import json
import sys
import argparse

API_URL = "http://192.168.118.247:2011/api/devops/pipeline/image/list/query"

def query_images(token, **kwargs):
    """Query DevOps image version list"""

    # Build request body
    request_body = {
        "page": {
            "pageNum": kwargs.get("page_num", 1),
            "pageSize": kwargs.get("page_size", 10)
        },
        "pipelineId": kwargs.get("pipeline_id", ""),
        "groupId": kwargs.get("group_id", ""),
        "imageName": kwargs.get("image_name", ""),
        "projectId": kwargs.get("project_id", "")
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
            data = result.get("data", {})
            records = data.get("records", [])
            pagination = {
                "pageNum": data.get("pageNum", 1),
                "pageSize": data.get("pageSize", 10),
                "pages": data.get("pages", 1),
                "total": data.get("total", 0)
            }

            return {
                "success": True,
                "data": records,
                "pagination": pagination
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

def format_size(size_bytes):
    """Format size in bytes to human readable format"""
    if size_bytes is None:
        return "N/A"

    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.2f}{unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.2f}TB"

def print_markdown_table(records, pagination):
    """Print results as markdown table"""

    print(f"\n## 查询结果")
    print(f"**分页信息**: 第 {pagination['pageNum']}/{pagination['pages']} 页，共 {pagination['total']} 条记录\n")

    if not records:
        print("未找到符合条件的镜像版本")
        return

    # Print table header
    print("| 镜像名称 | 镜像大小 | docker版本 | cpu架构 | 维护人 | 推送时间 |")
    print("|---------|---------|-----------|--------|-------|---------|")

    # Print table rows
    for record in records:
        pull_command = record.get("pullCommand", "")
        size = format_size(record.get("size"))
        docker_version = record.get("dockerVersion", "")
        if not docker_version or docker_version == "null":
            docker_version = "20.10.10"
        architecture = record.get("architecture", "")
        author = record.get("author", "")
        if not author or author == "null":
            author = "-"
        push_time = record.get("pushTime", "")

        print(f"| {pull_command} | {size} | {docker_version} | {architecture} | {author} | {push_time} |")

def main():
    # Disable SSL warnings
    requests.packages.urllib3.disable_warnings()

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Query DevOps image version list")
    parser.add_argument("token", help="Authorization token (without 'bearer ' prefix)")
    parser.add_argument("pipeline_id", help="Pipeline ID or name")
    parser.add_argument("--page-num", type=int, default=1, help="Page number (default: 1)")
    parser.add_argument("--page-size", type=int, default=10, help="Items per page (default: 10)")
    parser.add_argument("--group-id", default="", help="Group ID")
    parser.add_argument("--image-name", default="", help="Image name")
    parser.add_argument("--project-id", default="", help="Project ID")

    args = parser.parse_args()

    # Query images
    result = query_images(
        token=args.token,
        pipeline_id=args.pipeline_id,
        page_num=args.page_num,
        page_size=args.page_size,
        group_id=args.group_id,
        image_name=args.image_name,
        project_id=args.project_id
    )

    # Display results
    if result["success"]:
        print_markdown_table(result["data"], result["pagination"])
    else:
        print(f"\n❌ 错误: {result['error']}", file=sys.stderr)
        if result.get("code"):
            print(f"错误代码: {result['code']}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
