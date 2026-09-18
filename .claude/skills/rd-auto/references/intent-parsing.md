# Intent Parsing — 详细意图解析规则

> 主会话在 PM 输入解析阶段，需要详细规则时 Read 本文件。
> 主 SKILL.md 已含核心 task_type 关键词映射和 change-name 推导，本文件覆盖**推断细节**。

## task_type 判断（关键词→类型）

| PM 说的 | task_type |
|---------|-----------|
| "实现/开发/新增/添加功能" | development |
| "写文档/ADR" | docs |
| "热修复/hotfix" | hotfix |
| "重构/拆分/合并模块" | refactor |
| "补测试/测试覆盖" | test-only |
| "改配置/CI配置" | config-change |

## Flow Type 推断

| 意图特征 | flow_type |
|---------|-----------|
| confidence >= 0.85, affected_files <= 3 | **quick** |
| affected_files >= 5, complexity >= L | **development** |
| hotfix | **hotfix** |
| 其他不确定 | **development**（保守回退） |

flow_type 决定 transitions 表（harness-rules.yaml 中 `transitions` / `hotfix_transitions` / `docs_transitions` / `quick_transitions`）。

## Context Mode 推断

根据 PM 输入语义推断初始 context_mode（sub-agent 通过 NEEDS_CONTEXT 触发自动升级）：

| 模式 | 关键词 | Token 预算 |
|------|--------|-----------|
| `minimal` | 探索、查看、排查、调用链、定位 | ~100-200 |
| `read_only` | 评审、审核、检查、验证 | ~4500 |
| `full` | 其他（实现、修复、重构） | ~5000 |

## 置信度检查

- confidence >= 0.7: 直接执行
- confidence < 0.7: 向 PM 展示解析结果确认

## 多意图检测

PM 输入含 "同时" "另外" "还有" → 拆分为多个独立意图，各自走独立 pipeline。

## 特殊意图（无新需求，对已有任务操作）

| PM 说的 | 动作 |
|---------|------|
| "继续/resume" + 名称 | dashboard 找到任务 → advance |
| "评审/review" + 名称 | set-phase code-review → advance |
| "测试/test" + 名称 | set-phase test → advance |
| "归档/archive" + 名称 | set-phase archive → advance |
| 无参数 | dashboard → 有活跃任务继续，否则提示 PM |

## change-name 推导

- "实现用户登录功能" → `user-login`
- "修复权限绕过漏洞" → `fix-permission-bypass`
- 简短、描述性强、kebab-case

## 模式推荐

主会话在意图解析后调用 `node $SCRIPT recommend-mode --intent-json '{...}'`，team 模式向 PM 建议（适合并行 work_items 多的变更）。
