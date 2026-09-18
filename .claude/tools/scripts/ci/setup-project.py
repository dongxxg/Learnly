#!/usr/bin/env python3
"""ci-setup-project — 为子项目生成 .gitlab-ci.yml

用法: python3 ci-setup-project.py [--dry-run] [--force]
"""

import argparse
import os
import sys


def _force_utf8_stdout():
    """Issue !188: Windows GBK 终端默认 stdout 编码非 UTF-8，
    print 含 Emoji（❌✅⚠️📦🎉）的字符串触发 UnicodeEncodeError。
    强制 stdout/stderr 重配置为 UTF-8，errors='replace' 容错处理无法编码字符。
    Python 3.7+ 才有 reconfigure；老版本忽略（保持原行为）。
    """
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (TypeError, ValueError, OSError):
            pass


def detect_language() -> str:
    """Detect project language from build files."""
    if os.path.isfile("pom.xml"):
        return "java"
    if os.path.isfile("go.mod"):
        return "go"
    if os.path.isfile("package.json") and not os.path.isfile("pom.xml"):
        return "ts"
    if os.path.isfile("pyproject.toml") or os.path.isfile("setup.py"):
        return "python"
    if os.path.isfile("build.sbt"):
        return "scala"
    return ""


def generate_ci_yml(lang: str) -> str:
    return f"""# 由 Uni-AURI 自动生成 | 语言：{lang}
#
# 可覆盖变量（在下方 variables 中添加，覆盖语言模板默认值）:
#   BUILD_IMAGE         构建镜像
#   CHECK_CMD           静态检查命令（空则跳过）
#   TEST_CMD            测试命令
#   COVERAGE_CMD        覆盖率命令（输出最后一行须为纯数字百分比，如 80.5）
#   COVERAGE_THRESHOLD  覆盖率阈值，默认 60
#
# 示例 — 覆盖阈值并启用覆盖率:
#   variables:
#     COVERAGE_THRESHOLD: "80"

# CI 模板从 Uni-AURI 仓库远程引用（.claude/ 在目标仓库 .gitignore 中）
include:
  - project: 'public_group/rd_harness'
    ref: 'main'
    file: '.claude/ci-templates/base.yml'
  - project: 'public_group/rd_harness'
    ref: 'main'
    file: '.claude/ci-templates/languages/{lang}.yml'
  - project: 'public_group/rd_harness'
    ref: 'main'
    file: '.claude/ci-templates/check-build.yml'
  - project: 'public_group/rd_harness'
    ref: 'main'
    file: '.claude/ci-templates/push-pipeline.yml'

# CI 运行时拉取 Uni-AURI 脚本（.claude/ 未提交到本仓库）
before_script:
  - |
    if [ ! -f .claude/tools/scripts/ci-detect-changes.sh ]; then
      echo "[harness] Fetching Uni-AURI scripts..."
      git clone --depth 1 --single-branch --branch main \\
        "http://gitlab-ci-token:${{CI_JOB_TOKEN}}@${{CI_SERVER_HOST}}/public_group/rd_harness.git" \\
        /tmp/rd_harness 2>/dev/null && \\
      mkdir -p .claude/tools/ && \\
      cp -r /tmp/rd_harness/.claude/tools/scripts .claude/tools/ && \\
      rm -rf /tmp/rd_harness && \\
      echo "[harness] Scripts ready"
    fi
"""


def main():
    _force_utf8_stdout()
    parser = argparse.ArgumentParser(
        description="ci-setup-project — 生成 .gitlab-ci.yml（远程 include，兼容 .gitignore）",
        prog="ci-setup-project.py",
    )
    parser.add_argument("--dry-run", action="store_true", default=False)
    parser.add_argument("--force", action="store_true", default=False)
    args = parser.parse_args()

    lang = detect_language()
    if not lang:
        print("❌ 无法检测仓库语言。请确保项目根目录包含以下文件之一：")
        print("   pom.xml / go.mod / package.json / pyproject.toml / setup.py / build.sbt")
        raise SystemExit(1)

    print(f"✅ 检测到语言：{lang}")

    ci_yml = generate_ci_yml(lang)

    if args.dry_run:
        print()
        print("===== .gitlab-ci.yml (dry-run) =====")
        print(ci_yml)
        print("=====================================")
        return

    if os.path.isfile(".gitlab-ci.yml") and not args.force:
        print()
        print("⚠️  已存在 .gitlab-ci.yml")
        try:
            confirm = input("是否覆盖？备份原文件为 .gitlab-ci.yml.bak [y/N] ")
        except EOFError:
            confirm = "n"
        if confirm.lower() not in ("y", "yes"):
            print("已取消")
            return

    if os.path.isfile(".gitlab-ci.yml"):
        os.rename(".gitlab-ci.yml", ".gitlab-ci.yml.bak")
        print("📦 原文件已备份到 .gitlab-ci.yml.bak")

    with open(".gitlab-ci.yml", "w", encoding="utf-8") as f:
        f.write(ci_yml)
    print("✅ .gitlab-ci.yml 已生成（本地 include）")

    print()
    print("🎉 完成！CI 配置已生成。")
    print("   下一步：")
    print("   1. 提交 .gitlab-ci.yml 到仓库")
    print("   2. 提交 MR 或 push 触发 Pipeline 验证")


if __name__ == "__main__":
    main()
