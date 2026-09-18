# ADR 触发与 Quick Dispatch

> 主会话在 propose 完成后评估 ADR 触发，或在简单意图时走 Quick Dispatch 短路。Read 本文件获取详细规则。

## ADR 自动触发

propose 阶段 DONE 后，主会话检查 design.md Decisions 章节，命中以下 trigger_conditions 时启动 ADR 流程（dispatch-adr.md）：

**触发条件**（任一命中即触发）：
- 跨模块接口变更
- AI 角色定义修改
- 安全策略调整
- 技术栈或依赖引入
- 难以回退的决策
- CLAUDE.md 修改
- 性能预算调整
- 数据 Schema 迁移

**不触发**：
- hotfix
- 纯文档变更
- 配置微调

## Quick Dispatch（意图快捷调度）

简单意图跳过完整 pipeline，直接调度到单个角色。

### 路由表

| 意图类别 | 目标角色 |
|----------|---------|
| bug_fix | Developer |
| explore_design | Architect |
| code_review | Reviewer |
| testing | Tester |
| quick_change (<=2 文件) | 主会话自处理 |
| quick_change (>=3 文件) | Developer |

### 命令

```bash
node $SCRIPT quick-dispatch --intent-json '{...}'
node $SCRIPT verify-quick <name>
node $SCRIPT upgrade-to-full <name>   # BLOCKED(task_too_large) 时升级到完整 pipeline
```

### Quick 流程（4 阶段）

`pending → intake → dispatch → verify → complete`

- `intake`：自动校验
- `dispatch`：派发单个角色
- `verify`：校验产物（cmdVerifyQuick）
- `complete`：标记完成

### 升级机制

Quick 流程中 sub-agent 返回 `BLOCKED(task_too_large)` → `upgrade-to-full` 升级到完整 development pipeline。
