# 自动意图路由 — 明确调用触发

> rd-auto 为重量级流水线（explore→propose→apply→archive），**只在 PM 明确调用时触发**。
> 自然语言开发意图一律不自动路由，由当前 Agent 直接处理。

## 触发规则（唯一）

rd-auto **仅在以下明确调用时触发**：

| 用户输入 | 判定 | 动作 |
|---|---|---|
| `/rd-auto <任务描述>` | 明确调用 | 直接执行 |
| 消息含 "rd-auto"（"用 rd-auto 做 X"/"走 rd-auto 流程：X"） | 明确调用 | 直接执行 |
| "继续/推进/接着 <change>"，且该 change 已有 rd-auto pipeline 状态（`.harness/tasks/<change>/pipeline-state.json` 存在） | 明确调用 | 从当前阶段继续推进 |

## 不触发（一律直接处理，不路由）

以下自然语言意图**一律不触发** rd-auto，由当前 Agent 正常直接实现/回答：

- 功能开发：实现/做/开发/新增/添加 + 具体描述
- Bug 修复：修复/fix/解决 + 问题描述
- 热修复：热修复/紧急/hotfix/线上问题
- 重构：重构/优化结构/拆分/合并模块
- 补测试：补测试/加测试/测试覆盖
- 配置变更：改配置/环境变量/CI配置
- 写文档：写文档/ADR/补充说明/更新设计文档
- 继续任务：继续/接着/resume + 任务名（未引用具体 rd-auto change）
- 简单提问 / 代码探索 / Git 操作 / 项目管理 / 其他 `/` 命令 / 追问澄清

## 判断原则

- **宁可漏判，不可误触发**：未显式提及 rd-auto → 默认不路由、直接处理
- 误触发代价（重型流水线 + 文档制品）>> 漏判代价（PM 一句 "用 rd-auto 做 X" 即补齐）
- 拿不准是否算"明确调用"时，按**不触发**处理

## 执行方式

触发后：
1. **意图明确**：直接调用 `Skill(skill="rd-auto")`，无需确认
2. **意图模糊**（明确调用了但任务类别不清）：先调用 `/rd-auto parse "<PM 原话>"` 获取结构化意图-json，再按结果路由

## intent_category 与 flow-type 自动升级（bug_fix 必读）

`orchestrator init` 时若 `--intent-json` 含 `intent_category`，会**自动升级到 quick flow**（轻量 5 阶段，不经 propose/design-review，不强制 proposal/design/spec）：

- **触发条件**：`intent_category ∈ [bug_fix, quick_change, code_review, testing]` + `confidence ≥ 0.85` + `affected_files ≤ 3`
- **实现位置**：`cli-commands.js` auto-upgrade-to-quick（即便 `--flow-type development`，含合规 intent_category 也会自动升 quick）

**操作要点**：bug_fix / 根因明确的小修复，init 时务必在 `--intent-json` 传 `intent_category`，否则即便根因明确也会走 development 全套（产出冗余制品）：

```bash
node .claude/skills/rd-auto/scripts/orchestrator.js init <name> \
  --flow-type development \
  --intent-json '{"task_type":"...","intent_category":"bug_fix","confidence":0.9,"affected_files":["path"],"complexity_hint":"S"}' \
  --criteria "..."
```

> 实证：fix-push-cleanup-hook（30 行 hook 修复）因 init 未传 `intent_category` 走了 development 全套，产出 ~2400 行文档；若传 `bug_fix` 会自动升 quick。这是操作问题，非框架缺陷——无需新机制，传对字段即可。
