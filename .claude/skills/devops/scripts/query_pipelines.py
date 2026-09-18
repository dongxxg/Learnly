#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import json
import sys
import argparse

API_URL = "http://192.168.118.247:2011/api/devops/pipeline/list/query"

def query_pipelines(token, **kwargs):
    """Query DevOps pipeline list with filters"""

    # Build request body
    request_body = {
        "creator": kwargs.get("creator", ""),
        "groupId": kwargs.get("group_id", ""),
        "moduleId": kwargs.get("module_id", ""),
        "page": {
            "pageNum": kwargs.get("page_num", 1),
            "pageSize": kwargs.get("page_size", 10)
        },
        "pipelineName": kwargs.get("pipeline_name", ""),
        "productId": kwargs.get("product_id", ""),
        "projectId": kwargs.get("project_id", ""),
        "pipelineType": kwargs.get("pipeline_type", ""),
        "favorite": kwargs.get("favorite", True)
    }

    # Build request headers
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
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

def format_pipeline_type(pipeline_type):
    """Format pipeline type for display"""
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
        print("未找到符合条件的流水线")
        return

    # Print table header
    print("| 流水线ID | 流水线名称 | 所属组别 | 所属产品 | 所属模块 | 所属项目 | 流水线类型 | 仓库类型 | 最新操作 |")
    print("|---------|-----------|---------|---------|---------|---------|-----------|---------|----------|")

    # Print table rows
    for record in records:
        pipeline_id = record.get("id", "")
        pipeline_name = record.get("pipelineName", "")
        group_name = record.get("groupName", "")
        product_name = record.get("productName", "")
        module_name = record.get("moduleName", "")
        project_name = record.get("projectName", "")
        pipeline_type = format_pipeline_type(record.get("pipelineType", ""))
        repo_type = record.get("repoType", "")
        update_time = record.get("updateTime", "")

        print(f"| {pipeline_id} | {pipeline_name} | {group_name} | {product_name} | {module_name} | {project_name} | {pipeline_type} | {repo_type} | {update_time} |")

def main():
    # Disable SSL warnings
    requests.packages.urllib3.disable_warnings()

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Query DevOps pipeline list")
    parser.add_argument("token", help="Authorization token (without 'bearer ' prefix)")
    parser.add_argument("--page-num", type=int, default=1, help="Page number (default: 1)")
    parser.add_argument("--page-size", type=int, default=10, help="Items per page (default: 10)")
    parser.add_argument("--pipeline-name", default="", help="Filter by pipeline name")
    parser.add_argument("--creator", default="", help="Filter by creator")
    parser.add_argument("--favorite", type=lambda x: x.lower() == "true", default=True, help="Filter favorites (true/false)")
    parser.add_argument("--group-id", default="", help="Filter by group ID")
    parser.add_argument("--module-id", default="", help="Filter by module ID")
    parser.add_argument("--product-id", default="", help="Filter by product ID")
    parser.add_argument("--project-id", default="", help="Filter by project ID")
    parser.add_argument("--pipeline-type", default="", help="Filter by pipeline type")

    args = parser.parse_args()

    # Query pipelines
    result = query_pipelines(
        token=args.token,
        page_num=args.page_num,
        page_size=args.page_size,
        pipeline_name=args.pipeline_name,
        creator=args.creator,
        favorite=args.favorite,
        group_id=args.group_id,
        module_id=args.module_id,
        product_id=args.product_id,
        project_id=args.project_id,
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
