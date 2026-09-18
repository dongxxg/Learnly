#!/usr/bin/env bash
# Tests for RuleConverter (Bug 1: yaml API 错配)
#
# 背景：[730] 实现用 yaml@1 API `import { load } from 'yaml'`，
# 但实际安装的是 yaml@2.9.0（只有 `parse`，没有 named export `load`）。
# import 失败导致 RuleConverter 整体不可用，toCodexPrompt() 无法产出。
#
# 本测试覆盖：
#   1) PASS: RuleConverter 能 import yaml 不抛 SyntaxError
#   2) PASS: loadRules() 能解析 harness-rules.yaml 返回对象
#   3) PASS: toCodexPrompt() 输出非空 Codex prompt（>= 100 字符）
#   4) PASS: toCodexPrompt() 包含期望的结构化段落（## 角色职责 / ## 任务完成标准 等）
#   5) PASS: getRoleConfig('developer') 返回非空且含 responsibilities 字段
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR"/../../../.. && pwd)"
RULE_CONVERTER="$PROJECT_ROOT/.claude/backends/utils/rule-converter.js"
RULES_YAML="$PROJECT_ROOT/.claude/reference/harness-rules.yaml"

PASS=0
FAIL=0

if [ ! -f "${RULE_CONVERTER}" ]; then
    echo "FAIL: rule-converter.js not found at ${RULE_CONVERTER}"
    exit 1
fi
if [ ! -f "${RULES_YAML}" ]; then
    echo "FAIL: harness-rules.yaml not found at ${RULES_YAML}"
    exit 1
fi

# 测试用 node ESM 调 RuleConverter
run_case() {
    local name="$1"
    local expected="$2"   # 'pass' or 'fail'
    local node_script="$3"

    local actual_out
    local actual_exit
    actual_out=$(node --input-type=module -e "$node_script" 2>&1) || actual_exit=$?
    actual_exit=${actual_exit:-0}

    local result
    if [ "$expected" = "pass" ]; then
        if [ "$actual_exit" -eq 0 ]; then
            result="PASS"
        else
            result="FAIL"
        fi
    else
        if [ "$actual_exit" -ne 0 ]; then
            result="PASS"
        else
            result="FAIL"
        fi
    fi

    if [ "$result" = "PASS" ]; then
        echo "  [PASS] $name"
        PASS=$((PASS + 1))
    else
        echo "  [FAIL] $name"
        echo "        exit=$actual_exit"
        echo "        output: $(echo "$actual_out" | head -5 | sed 's/^/        /')"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== RuleConverter Tests (Bug 1: yaml API 错配) ==="
echo ""

# Case 1: import 不抛 SyntaxError
run_case "RuleConverter import 不抛错" pass "
import { RuleConverter } from '${RULE_CONVERTER}';
console.log('imported');
"

# Case 2: loadRules 返回对象（含 roles 键）
run_case "loadRules 解析 harness-rules.yaml 成功" pass "
import { RuleConverter } from '${RULE_CONVERTER}';
const rc = new RuleConverter('${RULES_YAML}');
const rules = rc.loadRules();
if (!rules || typeof rules !== 'object') {
  console.error('rules is not an object:', rules);
  process.exit(1);
}
if (!Array.isArray(rules.roles?.developer?.responsibilities)) {
  console.error('developer.responsibilities missing');
  process.exit(1);
}
console.log('roles keys:', Object.keys(rules.roles).join(','));
"

# Case 3: toCodexPrompt 输出非空（>= 100 字符）
run_case "toCodexPrompt 产出非空 Codex prompt" pass "
import { RuleConverter } from '${RULE_CONVERTER}';
const rc = new RuleConverter('${RULES_YAML}');
const prompt = rc.toCodexPrompt();
if (typeof prompt !== 'string' || prompt.length < 100) {
  console.error('prompt too short or not string:', prompt?.length, 'chars');
  process.exit(1);
}
console.log('prompt length:', prompt.length);
"

# Case 4: toCodexPrompt 含关键段落
run_case "toCodexPrompt 含结构化段落标记" pass "
import { RuleConverter } from '${RULE_CONVERTER}';
const rc = new RuleConverter('${RULES_YAML}');
const prompt = rc.toCodexPrompt();
const mustContain = ['# Uni-AURI 框架规则', '## 角色职责'];
for (const marker of mustContain) {
  if (!prompt.includes(marker)) {
    console.error('missing marker:', marker);
    process.exit(1);
  }
}
console.log('all markers found');
"

# Case 5: getRoleConfig('developer') 返回正确结构
run_case "getRoleConfig('developer') 返回 responsibilities" pass "
import { RuleConverter } from '${RULE_CONVERTER}';
const rc = new RuleConverter('${RULES_YAML}');
const dev = rc.getRoleConfig('developer');
if (!dev || !Array.isArray(dev.responsibilities) || !dev.responsibilities.includes('implementation')) {
  console.error('developer config wrong:', JSON.stringify(dev));
  process.exit(1);
}
console.log('developer responsibilities:', dev.responsibilities.join(','));
"

# Case 6: toCodexPrompt 输出不得含 [object Object]（Bug 3: workflow 字段对象化）
run_case "toCodexPrompt 不含 [object Object]" pass "
import { RuleConverter } from '${RULE_CONVERTER}';
const rc = new RuleConverter('${RULES_YAML}');
const prompt = rc.toCodexPrompt();
if (typeof prompt !== 'string' || prompt.length === 0) {
  console.error('prompt empty or not string');
  process.exit(1);
}
if (prompt.includes('[object Object]')) {
  console.error('prompt contains [object Object]:');
  // 输出上下文便于定位
  const idx = prompt.indexOf('[object Object]');
  console.error(prompt.substring(Math.max(0, idx - 80), idx + 80));
  process.exit(1);
}
console.log('no [object Object] found, prompt length:', prompt.length);
"

# Case 7: workflow 段渲染含 ## 工作流程 标题与 step / executor 关键信息
run_case "toCodexPrompt workflow 段渲染 step/executor 等关键信息" pass "
import { RuleConverter } from '${RULE_CONVERTER}';
const rc = new RuleConverter('${RULES_YAML}');
const prompt = rc.toCodexPrompt();

// 1) 必须有 ## 工作流程 段
if (!prompt.includes('## 工作流程')) {
  console.error('missing section: ## 工作流程');
  process.exit(1);
}

// 2) 必须包含 pipeline 步骤标识 Step
if (!/Step\\s/.test(prompt)) {
  console.error('missing step marker: Step');
  process.exit(1);
}

// 3) 必须包含 executor 关键字（步骤的执行者字段）
if (!/executor:/.test(prompt)) {
  console.error('missing executor field');
  process.exit(1);
}

// 4) 必须包含至少一个已知 executor（pm / main_session）
if (!/executor:\\s*(pm|main_session)\\b/.test(prompt)) {
  console.error('missing known executor value (pm or main_session)');
  process.exit(1);
}

// 5) 必须包含 precondition 关键字
if (!/precondition:/.test(prompt)) {
  console.error('missing precondition field');
  process.exit(1);
}

// 6) 抽取 workflow 段，确认不再退化成单行 [object Object]
//    使用 split 切片避免 regex 末尾锚点在 bash heredoc 中的转义问题
const sections = prompt.split(/\\n(?=## )/);
const section = sections.find(s => s.startsWith('## 工作流程'));
if (!section) {
  console.error('cannot extract workflow section');
  process.exit(1);
}
if (section.includes('[object Object]')) {
  console.error('workflow section still contains [object Object]');
  process.exit(1);
}
// 7) workflow 段必须至少渲染出 5 个 Step（pipeline 有 8 个）
const stepCount = (section.match(/^Step\\s/mg) || []).length;
if (stepCount < 5) {
  console.error('expected >=5 step lines, got', stepCount);
  process.exit(1);
}
console.log('workflow section ok, length:', section.length, 'steps:', stepCount);
"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -eq 0 ] || exit 1
