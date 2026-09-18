#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import json
import sys
import argparse
import os
import re
from pathlib import Path

API_URL = "http://192.168.118.247:2011/api/devops/pipeline/package/release/download"

def extract_net_user_id(token):
    """Extract netUserId from JWT token"""
    try:
        # JWT token format: header.payload.signature
        parts = token.split('.')
        if len(parts) != 3:
            return None

        # Decode payload (base64)
        import base64
        payload = parts[1]
        # Add padding if needed
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += '=' * padding

        decoded = base64.b64decode(payload)
        payload_data = json.loads(decoded)
        return payload_data.get('netuserId') or payload_data.get('netuserid') or payload_data.get('user_name')
    except Exception as e:
        print(f"警告: 无法从token提取netUserId: {e}", file=sys.stderr)
        return None

def download_package(token, package_id, net_user_id=None, output_dir=None, pipeline_name=None, full_version=None, build_number=None, pipeline_id=None):
    """Download package binary"""

    # Extract netUserId from token if not provided
    if not net_user_id:
        net_user_id = extract_net_user_id(token)
        if not net_user_id:
            return {
                "success": False,
                "error": "无法从token提取netUserId，请手动指定"
            }

    # Build request body
    request_body = {
        "packageId": package_id,
        "netUserId": net_user_id
    }

    # Build request headers
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Authorization": f"bearer {token}",
        "Content-Type": "application/json;charset=UTF-8"
    }

    try:
        # Make HTTP request (ignore SSL verification)
        response = requests.post(
            API_URL,
            json=request_body,
            headers=headers,
            verify=False,
            timeout=300,  # 5 minutes timeout for download
            stream=True
        )

        # Check if response is successful
        if response.status_code != 200:
            try:
                error_data = response.json()
                error_msg = error_data.get("tip") or error_data.get("msg") or f"HTTP {response.status_code}"
                return {
                    "success": False,
                    "error": error_msg
                }
            except:
                return {
                    "success": False,
                    "error": f"下载失败: HTTP {response.status_code}"
                }

        # Extract filename from Content-Disposition header
        filename = None

        # Construct filename from metadata if provided
        if pipeline_name and full_version and pipeline_id:
            # Format: pipelineName_fullVersion_buildNumber@pipelineId.tar.gz
            if build_number:
                filename = f"{pipeline_name}_{full_version}_{build_number}@{pipeline_id}.tar.gz"
            else:
                filename = f"{pipeline_name}_{full_version}@{pipeline_id}.tar.gz"

        # Try Content-Disposition header if no metadata provided
        if not filename:
            content_disposition = response.headers.get('Content-Disposition', '')
            if content_disposition:
                # Try to extract filename from Content-Disposition
                match = re.search(r'filename[^;=\n]*=(([\'"]).*?\2|[^;\n]*)', content_disposition)
                if match:
                    filename = match.group(1).strip('\'"')

        # If no filename found, use package_id
        if not filename:
            filename = f"package_{package_id}.tar.gz"

        # Determine output directory
        if not output_dir:
            output_dir = str(Path.home() / "Downloads")

        # Create output directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)

        # Full output path
        output_path = os.path.join(output_dir, filename)

        # Download file
        with open(output_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)

        # Get file size
        file_size = os.path.getsize(output_path)

        return {
            "success": True,
            "filename": filename,
            "output_path": output_path,
            "file_size": file_size
        }

    except requests.exceptions.RequestException as e:
        return {
            "success": False,
            "error": f"连接目标服务失败: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"下载失败: {str(e)}"
        }

def format_size(size_bytes):
    """Format size in bytes to human readable format"""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.2f}{unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.2f}TB"

def main():
    # Disable SSL warnings
    requests.packages.urllib3.disable_warnings()

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="Download DevOps package binary")
    parser.add_argument("token", help="Authorization token (without 'bearer ' prefix)")
    parser.add_argument("package_id", help="Package ID to download")
    parser.add_argument("--net-user-id", default=None, help="Net user ID (auto-extracted from token if not provided)")
    parser.add_argument("--output-dir", default=None, help="Output directory (default: ~/Downloads)")
    parser.add_argument("--pipeline-name", default=None, help="Pipeline name for filename")
    parser.add_argument("--full-version", default=None, help="Full version for filename")
    parser.add_argument("--build-number", default=None, help="Build number for filename")
    parser.add_argument("--pipeline-id", default=None, help="Pipeline ID for filename")

    args = parser.parse_args()

    # Download package
    result = download_package(
        token=args.token,
        package_id=args.package_id,
        net_user_id=args.net_user_id,
        output_dir=args.output_dir,
        pipeline_name=args.pipeline_name,
        full_version=args.full_version,
        build_number=args.build_number,
        pipeline_id=args.pipeline_id
    )

    # Display results
    if result["success"]:
        print(f"\n✅ 下载成功!")
        print(f"文件名: {result['filename']}")
        print(f"保存路径: {result['output_path']}")
        print(f"文件大小: {format_size(result['file_size'])}")
    else:
        print(f"\n❌ 错误: {result['error']}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
