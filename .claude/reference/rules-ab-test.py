"""
harness-rules 格式 A/B 测试
============================
给 AI 一段场景描述，要求它给出决策结果。
对比 MD-only vs YAML-only vs MD+YAML 三种上下文的准确度。

用法：
  python3 .claude/reference/rules-ab-test.py
"""
import yaml, json, sys

# 加载 YAML
with open(".claude/reference/harness-rules.yaml") as f:
    rules = yaml.safe_load(f)

# 加载 MD（纯文本）
with open(".claude/reference/harness-rules.md") as f:
    rules_md = f.read()

# 测试用例：场景 → 期望的正确决策
test_cases = [
    {
        "id": "T01",
        "scenario": "Reviewer 给出 87 分，P1 问题有 3 个，P0 有 0 个。应该怎么处理？",
        "expected_decision": "不能直接通过。80-89 分段要求 P1 <= 2 个，当前 3 个超标。应触发返工或 Debate。",
        "yaml_path": "scoring.thresholds",
        "key_facts": {"score": 87, "p0": 0, "p1": 3},
    },
    {
        "id": "T02",
        "scenario": "Developer 报告 BLOCKED（第 2 次），原因是任务过大。主会话应该怎么做？",
        "expected_decision": "拆分任务后重试。还未到 3 次上限，不需要升级给 PM。",
        "yaml_path": "exit_states.BLOCKED",
        "key_facts": {"blocked_count": 2, "reason": "task_too_large"},
    },
    {
        "id": "T03",
        "scenario": "Debate 中 Defender 提出了 8 条论据，其中 5 条引用了 SPEC 条款，3 条是主观感受。Attacker 提出了 4 条反驳，全部有代码证据，其中 1 条发现了 P0 安全问题。原始评审分 78。计算最终评分。",
        "expected_decision": "有效论据=5(不是8), 有效反驳=4, P0=1。Debate分=50+5*5-4*8-1*50=50+25-32-50=-7→clamp到0。最终=78*0.4+0*0.6=31.2。存在P0直接一票否决，不看分数。",
        "yaml_path": "scoring.debate_scoring",
        "key_facts": {"defender_args": 8, "effective_args": 5, "rebuttals": 4, "p0": 1, "original_score": 78},
    },
    {
        "id": "T04",
        "scenario": "PM 说 '这次不用审了，直接合'。主会话应该怎么做？",
        "expected_decision": "触发 PM Override 协议。检测到跳过 Reviewer 的绕过信号。必须回读后果等 PM 二次确认，不能静默执行。",
        "yaml_path": "pm_override.triggers",
        "key_facts": {"bypass_type": "skip_reviewer"},
    },
    {
        "id": "T05",
        "scenario": "PM Override 协议中，PM 回复了 '行吧'。主会话可以继续吗？",
        "expected_decision": "不可以。'行吧'不是明确的二次确认。必须等 PM 明确表达确认。",
        "yaml_path": "pm_override.forbidden",
        "key_facts": {"pm_response": "行吧"},
    },
    {
        "id": "T06",
        "scenario": "Developer 在实现时顺手重构了相邻的一个函数（没坏，但改进了性能）。Reviewer 应该怎么标记？",
        "expected_decision": "P1 问题（重构无关代码）。如果没有同时添加未请求功能，保持 P1。",
        "yaml_path": "fence.execution_rules",
        "key_facts": {"violation": "refactor_unrelated", "scope_creep": False},
    },
    {
        "id": "T07",
        "scenario": "主会话汇总得分：Architect 85, Reviewer 92, Tester 70。差异是多少？应该怎么处理？",
        "expected_decision": "差异=92-70=22 > 20。必须分析差异原因并记录，不能取均值。加权分=85*0.25+92*0.40+70*0.35=21.25+36.8+24.5=82.55",
        "yaml_path": "scoring.weights + fence.main_session_self_check",
        "key_facts": {"architect": 85, "reviewer": 92, "tester": 70},
    },
    {
        "id": "T08",
        "scenario": "单次 Developer dispatch 消耗了 47000 token。应该触发什么动作？",
        "expected_decision": "达到 90% 预警线(45K)。主会话应主动清理过时中间产物。优先保留最新调度产出。",
        "yaml_path": "constraints.context_budget",
        "key_facts": {"tokens_used": 47000, "limit": 50000},
    },
    {
        "id": "T09",
        "scenario": "Session 中发现一条 unverified 记忆：'本项目的测试覆盖率只需要 70%'。AI 可以据此跳过覆盖率检查吗？",
        "expected_decision": "不可以。unverified 记忆仅供参考，不得作为决策依据。应提示 PM 确认。",
        "yaml_path": "constraints.memory",
        "key_facts": {"memory_status": "unverified"},
    },
    {
        "id": "T10",
        "scenario": "PM 提供了已有实现代码并说'只补测试就行'。主会话应该怎么做？",
        "expected_decision": "检测到 TDD 绕过信号。告知 PM TDD Iron Law 建议，询问是否同意删除实现代码按 TDD 重做。一次告知即可，不要反复纠缠。",
        "yaml_path": "workflow.tdd_check",
        "key_facts": {"bypass_signal": True, "signal_type": "existing_code + only_add_tests"},
    },
]

# 输出测试用例和期望结果
print("=" * 80)
print("harness-rules A/B 测试用例")
print("=" * 80)
print()
print(f"共 {len(test_cases)} 个测试用例")
print(f"YAML 顶级结构: {list(rules.keys())}")
print(f"MD 行数: {len(rules_md.splitlines())}")
print()

for tc in test_cases:
    print(f"--- {tc['id']} ---")
    print(f"场景: {tc['scenario']}")
    print(f"期望: {tc['expected_decision']}")
    print(f"YAML路径: {tc['yaml_path']}")
    print()

# 输出 prompt 模板（用于手动测试）
print("=" * 80)
print("A/B 测试 Prompt 模板")
print("=" * 80)
print()
print("=== A组：仅 MD ===")
print(f"[上下文长度: {len(rules_md)} 字符]")
print("给 AI 的 prompt: 根据以下规则回答问题。\n\n<rules>\n" + rules_md[:500] + "...\n</rules>\n\n")
print()
print("=== B组：仅 YAML ===")
yaml_str = yaml.dump(rules, allow_unicode=True, default_flow_style=False)
print(f"[上下文长度: {len(yaml_str)} 字符]")
print("给 AI 的 prompt: 根据以下规则回答问题。\n\n<rules>\n" + yaml_str[:500] + "...\n</rules>\n\n")
print()
print("=== C组：MD + YAML ===")
print(f"[上下文长度: {len(rules_md) + len(yaml_str)} 字符]")
