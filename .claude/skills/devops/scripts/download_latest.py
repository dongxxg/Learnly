#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Convenience script to download the latest package for a pipeline with proper filename
"""

import sys
import subprocess
import json
import argparse

def get_latest_package_info(token, pipeline_id):
    """Get latest package info from tarball list"""
    cmd = [
        "python3", "scripts/get_tarballs.py",
        token, pipeline_id,
        "--page-size", "1"
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        output = result.stdout

        # Parse the markdown table to extract info
        lines = output.strip().split('\n')
        for i, line in enumerate(lines):
            if line.startswith('| Package ID |'):
                # Found header, data is in next line after separator
                if i + 2 < len(lines):
                    data_line = lines[i + 2]
                    parts = [p.strip() for p in data_line.split('|')]
                    if len(parts) >= 8:
                        return {
                            'package_id': parts[1],
                            'pipeline_name': parts[2],
                            'full_version': parts[6],
                            'pipeline_id': pipeline_id
                        }
        return None
    except subprocess.CalledProcessError as e:
        print(f"Error getting package info: {e}", file=sys.stderr)
        return None

def download_with_metadata(token, pipeline_id, output_dir=None):
    """Download package with proper filename"""

    # Get package metadata
    print("正在获取最新制品信息...")
    info = get_latest_package_info(token, pipeline_id)

    if not info:
        print("❌ 无法获取制品信息", file=sys.stderr)
        return False

    print(f"找到制品: {info['pipeline_name']} {info['full_version']}")
    print(f"Package ID: {info['package_id']}")

    # Download with metadata
    cmd = [
        "python3", "scripts/download_package.py",
        token, info['package_id'],
        "--pipeline-name", info['pipeline_name'],
        "--full-version", info['full_version'],
        "--pipeline-id", info['pipeline_id']
    ]

    if output_dir:
        cmd.extend(["--output-dir", output_dir])

    try:
        subprocess.run(cmd, check=True)
        return True
    except subprocess.CalledProcessError:
        return False

def main():
    parser = argparse.ArgumentParser(description="Download latest package for a pipeline")
    parser.add_argument("token", help="Authorization token")
    parser.add_argument("pipeline_id", help="Pipeline ID or name")
    parser.add_argument("--output-dir", default=None, help="Output directory")

    args = parser.parse_args()

    success = download_with_metadata(args.token, args.pipeline_id, args.output_dir)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()
