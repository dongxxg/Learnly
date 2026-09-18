#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import json
import sys
import argparse

API_URL = "http://192.168.118.247:2011/api/devops/pipeline/package/list/query"

def query_packages(token, **kwargs):
    """Query DevOps package list with filters"""

    # Build request body
    request_body = {
        "packageName": kwargs.get("package_name", ""),
        "moduleId": kwargs.get("module_id", ""),
        "page": {
            "pageNum": kwargs.get("page_num", 1),
            "pageSize": kwargs.get("page_size", 10)
        },
        "packageStatus": kwargs.get("package_status", ""),
        "productId": kwargs.get("product_id", ""),
        "projectId": kwargs.get("project_id", ""),
        "pipelineId": kwargs.get("pipeline_id", ""),
        "packageVersion": kwargs.get("package_version", ""),
        "pipelineType": kwargs.get("pipeline_type", "")
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

def format_pipeline_type(pipeline_type):
    """Format pipeline type"""
    type_map = {
        "1": "标准流水线",
        "2": "自定义流水线",
        "3": "模板流水线"
    }
    return type_map.get(str(pipeline_type), str(pipeline_type))

def print_markdown_table(records, pagination):
    """Print results as markdown table"""

    print(f"\n## 查询结果")
    print(f"**分页信息**: 第 {pagination['pageNum']}/{pagination['pages']} 页，共 {pagination['total']} 条记录\n")

    if not records:
        print("未找到符合条件的制品")
        return

    # Print table header
    print("| 所属流水线 | 所属产品 | 所属模块 | 最新版本 | 类型 | 创建时间 | 制品大小 | 总空间占用 | 存在镜像 |")
    print("|-----------|---------|---------|---------|------|---------|---------|-----------|---------|")

    # Print table rows
    for record in records:
        pipeline_name = record.get("pipelineName", "")
        product_name = record.get("productName", "")
        module_name = record.get("moduleName", "")
        full_version = record.get("fullVersion", "")
        pipeline_type = format_pipeline_type(record.get("pipelineType", ""))
        create_time = record.get("createTime", "")
        package_size = format_size(record.get("packageSize"))
        total_space = record.get("totalSpaceSize", "")
        has_image = "✅ 是" if record.get("isBuildImage") == "Y" else "❌ 否"

        print(f"| {pipeline_name} | {product_name} | {module_name} | {full_version} | {pipeline_type} | {create_time} | {package_size} | {total_space} | {has_image} |")

def main():
    # Disable SSL warnings
    requests.packages.urllib3.disable_warnings()

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Query DevOps package list")
    parser.add_argument("token", help="Authorization token (without 'bearer ' prefix)")
    parser.add_argument("--page-num", type=int, default=1, help="Page number (default: 1)")
    parser.add_argument("--page-size", type=int, default=10, help="Items per page (default: 10)")
    parser.add_argument("--package-name", default="", help="Filter by package name")
    parser.add_argument("--pipeline-id", default="", help="Filter by pipeline ID")
    parser.add_argument("--module-id", default="", help="Filter by module ID")
    parser.add_argument("--product-id", default="", help="Filter by product ID")
    parser.add_argument("--project-id", default="", help="Filter by project ID")
    parser.add_argument("--package-version", default="", help="Filter by package version")
    parser.add_argument("--package-status", default="", help="Filter by package status")
    parser.add_argument("--pipeline-type", default="", help="Filter by pipeline type")

    args = parser.parse_args()

    # Query packages
    result = query_packages(
        token=args.token,
        page_num=args.page_num,
        page_size=args.page_size,
        package_name=args.package_name,
        pipeline_id=args.pipeline_id,
        module_id=args.module_id,
        product_id=args.product_id,
        project_id=args.project_id,
        package_version=args.package_version,
        package_status=args.package_status,
        pipeline_type=args.pipeline_type
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
