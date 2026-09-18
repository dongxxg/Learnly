#!/usr/bin/env bash
# pre-commit-tdd-check.sh: TDD Iron Law 硬化检查
# 检测 staged 文件中有生产代码但无测试文件时阻断提交
# 兼容 Bash 3.2（macOS）
#
# ══════════════════════════════════════════════════════════════
# ⛔ 输出格式固化 — 禁止 LLM/任何人修改以下行为：
#    1. 通过场景（有测试文件）→ 静默 exit 0，不输出任何内容
#    2. 阻断场景（无测试文件）→ 输出文件列表 + 提示"请先编写测试文件，与代码一起提交。"
#    3. 禁止加表情、禁止改措辞、禁止增删输出行、禁止使用英文或专业术语
#    → 规范文档: .harness/memory/tdd-check-output-convention.md
# ══════════════════════════════════════════════════════════════
set -euo pipefail

# GATE_BYPASS 由 pre-commit-state-check.sh 统一校验
COMMIT_MSG=""
if [ -f "$REPO_ROOT/.git/COMMIT_EDITMSG" ]; then
    COMMIT_MSG=$(cat "$REPO_ROOT/.git/COMMIT_EDITMSG" 2>/dev/null || true)
fi
if echo "$COMMIT_MSG" | grep -qE 'GATE_BYPASS:'; then
    exit 0
fi

# 获取所有 staged 文件
STAGED=$(git diff --cached --name-only 2>/dev/null || true)
[ -z "$STAGED" ] && exit 0

# ── 分类函数 ──

# 是否为排除文件（不触发 TDD 检查）
is_excluded() {
    local f="$1"
    # 框架自身
    case "$f" in
        .claude/*|.harness/*) return 0 ;;
    esac
    # 按扩展名排除
    case "$f" in
        *.md|*.txt|*.rst) return 0 ;;                    # 文档
        *.sh|*.bash) return 0 ;;                          # Shell
        *.yml|*.yaml|*.json|*.xml|*.properties|*.toml|*.ini) return 0 ;; # 配置
        *.css|*.scss|*.html|*.svg|*.png|*.jpg|*.gif) return 0 ;;       # 静态资源
        Dockerfile*|docker-compose*) return 0 ;;          # Docker
    esac
    # 按路径排除
    case "$f" in
        .github/*|.gitlab-ci.yml|Jenkinsfile) return 0 ;; # CI/CD
        */migration*/*|*/db/migration*/*) return 0 ;;     # 数据库迁移
    esac
    # 构建配置文件名
    local basename="${f##*/}"
    case "$basename" in
        pom.xml|build.gradle|Makefile|CMakeLists.txt|package.json|go.mod|go.sum|requirements.txt|setup.py|setup.cfg|pyproject.toml|Gemfile|Rakefile|Cargo.toml|Cargo.lock)
            return 0 ;;
    esac
    return 1
}

# 是否为测试文件
is_test() {
    local f="$1"
    # Java: src/test/java/
    case "$f" in
        src/test/java/*.java|src/test/java/**/*.java) return 0 ;;
    esac
    # Go: *_test.go
    case "$f" in
        *_test.go) return 0 ;;
    esac
    # Python: test_*.py, *_test.py, conftest.py, __init__.py, tests/ 目录
    local basename="${f##*/}"
    case "$basename" in
        test_*.py|*_test.py|conftest.py|__init__.py) return 0 ;;
    esac
    case "$f" in
        tests/*|tests/**/*|test/*|test/**/*|*/tests/*|*/tests/**/*|*/test/*|*/test/**/*)
            case "$f" in
                *.py) return 0 ;;
                *.rs) return 0 ;;
            esac
            ;;
    esac
    # C/C++: test 目录或 *_test.c/cpp
    case "$f" in
        test/*|tests/*|*/test/*|*/tests/*) return 0 ;;
    esac
    case "$basename" in
        *_test.c|*_test.cpp|*_test.cc|test_*.c|test_*.cpp|test_*.cc) return 0 ;;
    esac
    # Rust: *_test.rs 或 tests/ 目录下的 .rs
    case "$basename" in
        *_test.rs) return 0 ;;
    esac
    return 1
}

# 是否为生产代码
is_production() {
    local f="$1"
    local basename="${f##*/}"
    # Java: src/main/java/
    case "$f" in
        src/main/java/*.java|src/main/java/**/*.java) return 0 ;;
    esac
    # Go: *.go (排除 _test.go，已在 is_test 中处理)
    case "$f" in
        *.go) return 0 ;;
    esac
    # Python: *.py (排除 test 模式，已在 is_test 中处理)
    case "$f" in
        *.py) return 0 ;;
    esac
    # C/C++
    case "$f" in
        *.c|*.cpp|*.cc|*.h|*.hpp) return 0 ;;
    esac
    # Rust: *.rs (排除 _test.rs 和 tests/，已在 is_test 中处理)
    case "$f" in
        *.rs) return 0 ;;
    esac
    return 1
}

# ── 主逻辑 ──

PROD_FILES=""
TEST_FILES=""

while IFS= read -r f; do
    [ -z "$f" ] && continue
    is_excluded "$f" && continue
    if is_test "$f"; then
        TEST_FILES="$TEST_FILES
$f"
    elif is_production "$f"; then
        PROD_FILES="$PROD_FILES
$f"
    fi
done <<< "$STAGED"

# 去掉前导空行
PROD_FILES=$(echo "$PROD_FILES" | sed '/^$/d')
TEST_FILES=$(echo "$TEST_FILES" | sed '/^$/d')

# 无生产代码 → 不触发检查
[ -z "$PROD_FILES" ] && exit 0

# 纯删除/裁剪豁免：生产代码零新增行 → 不引入新行为，存量测试仍覆盖。
# （输出约定：通过场景静默，本分支不输出任何内容）
_ADDED=0
while IFS= read -r f; do
    [ -z "$f" ] && continue
    _N=$(git diff --cached --numstat -- "$f" 2>/dev/null | awk '{s+=$1} END{print s+0}')
    _ADDED=$((_ADDED + ${_N:-0}))
done <<< "$PROD_FILES"
[ "$_ADDED" -eq 0 ] && exit 0

# 有生产代码且有测试 → 静默通过
if [ -n "$TEST_FILES" ]; then
    exit 0
fi

# 有生产代码但无测试 → 阻断
	echo ""
	echo "🚫 提交被拦截：以下文件缺少对应的测试"
	echo ""
	echo "$PROD_FILES" | while IFS= read -r f; do
	    echo "  $f"
	done
	echo ""
	echo "请先编写测试文件，与代码一起提交。"
	echo ""
	exit 1
