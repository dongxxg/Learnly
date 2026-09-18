#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import json
import sys
import argparse

API_URL = "http://192.168.118.247:2011/api/devops/pipeline/tarball/list/query"

def query_tarballs(token, **kwargs):
    """Query DevOps tarball binary version list"""

    # Build request body
    request_body = {
        "page": {
            "pageNum": kwargs.get("page_num", 1),
            "pageSize": kwargs.get("page_size", 10)
        },
        "pipelineId": kwargs.get("pipeline_id", ""),
        "packageVersion": kwargs.get("package_version", "")
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

def print_markdown_table(records, pagination, output_id=False):
    """Print results as markdown table"""

    if output_id:
        # Just output the first record's ID for scripting
        if records:
            print(records[0].get("id", ""))
        return

    print(f"\n## 查询结果")
    print(f"**分页信息**: 第 {pagination['pageNum']}/{pagination['pages']} 页，共 {pagination['total']} 条记录\n")

    if not records:
        print("未找到符合条件的二进制版本")
        return

    # Print table header
    print("| Package ID | 所属流水线 | 所属产品 | 所属模块 | 所属项目 | 制品版本 | 创建时间 | 制品大小 |")
    print("|-----------|-----------|---------|---------|---------|---------|---------|---------|")

    # Print table rows
    for record in records:
        package_id = record.get("id", "")
        pipeline_name = record.get("pipelineName", "")
        product_name = record.get("productName", "")
        module_name = record.get("moduleName", "")
        project_name = record.get("projectName", "")
        full_version = record.get("fullVersion", "")
        create_time = record.get("createTime", "")
        package_size = format_size(record.get("packageSize"))

        print(f"| {package_id} | {pipeline_name} | {product_name} | {module_name} | {project_name} | {full_version} | {create_time} | {package_size} |")

def main():
    # Disable SSL warnings
    requests.packages.urllib3.disable_warnings()

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Query DevOps tarball binary version list")
    parser.add_argument("token", help="Authorization token (without 'bearer ' prefix)")
    parser.add_argument("pipeline_id", help="Pipeline ID or name")
    parser.add_argument("--page-num", type=int, default=1, help="Page number (default: 1)")
    parser.add_argument("--page-size", type=int, default=10, help="Items per page (default: 10)")
    parser.add_argument("--package-version", default="", help="Filter by package version")
    parser.add_argument("--output-id", action="store_true", help="Output only the first package ID (for scripting)")

    args = parser.parse_args()

    # Query tarballs
    result = query_tarballs(
        token=args.token,
        pipeline_id=args.pipeline_id,
        page_num=args.page_num,
        page_size=args.page_size,
        package_version=args.package_version
    )

    # Display results
    if result["success"]:
        print_markdown_table(result["data"], result["pagination"], output_id=args.output_id)
    else:
        print(f"\n❌ 错误: {result['error']}", file=sys.stderr)
        if result.get("code"):
            print(f"错误代码: {result['code']}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
