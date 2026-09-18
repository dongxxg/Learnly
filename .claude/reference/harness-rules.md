> 人类可读上下文补充（反模式、设计决策历史）。
> **权威规则**：`CLAUDE.md`（Session 启动注入）。**结构化执行版**：`harness-rules.yaml` — 冲突时以 yaml 为准。
> 本文件不重复 CLAUDE.md 已有内容。

# Uni-AURI 协作规则
> 主会话是调度中枢，PM 与主会话对话，主会话按规则调度子 Agent。

## 1. 角色与退出状态
→ `yaml → roles`（触发条件、配置、约束）
→ `yaml → exit_states`
**硬规则**：DONE_WITH_CONCERNS/BLOCKED ≠ DONE。BLOCKED 连续 3 次 → 熔断升级 PM。

## 2. 工作流程
→ `yaml → workflow.pipeline`（8 步有序流程）

### TDD 合规检测
调度 Developer 前必须执行。规则见 `yaml → workflow.tdd_check`。
绕过时向 PM 说：> "检测到已有实现代码。建议先写测试再写实现。你同意删除实现代码按 TDD 重写吗？（通常只多花 10-15 分钟）"
PM 拒绝后注入 `TDD_BYPASS`，一次告知。

### Tester 调度
→ `yaml → workflow.tester_dispatch`

### 评审管线
→ `yaml → scoring`（加权公式、阈值、Debate 评分、返工路由）
**得分判定权威来源**：`yaml → scoring.thresholds`

### PM Override 协议
→ `yaml → pm_override.triggers` + `pm_override.steps`（9 步 Challenge-Response）
→ `yaml → pm_override.challenge_response`（NONCE + TTL 300s + HEAD hash 绑定 + 单次消费）
**禁止**：首次提及绕过时静默执行；为 PM "润色"绕过原因；"过了""行吧"作二次确认

## 3. 质量门禁
→ `yaml → quality_gates.gates`（QG-ARCH/DEV/REV-001/002）
→ `yaml → quality_gates.hotfix`（阈值 70，跳过 Architect/Debate）

## 4. 绝对约束

### Git 提交（红线）
> Worker **严禁**任何 git 操作。主会话可在 PM 确认后 commit（本地），push 必须走挑战-应答。
→ `yaml → constraints.git`
**推送审批禁止自审批**：hook 显示挑战码后 AI **必须**向 PM 展示并等待回复。禁止读取 `.harness/.push-challenge`，禁止 PM 未回复时写入审批文件，禁止脚本自动读取挑战码。
流程：`git push` → hook 显示挑战码 → AI 向 PM 展示 → PM 回复 → AI 写入审批 → 再次 push

### 通信 / SPEC / 上下文 / 记忆
→ `yaml → constraints.communication`（PM ↔ 主会话双向，Workers → 主会话单向）
→ `yaml → constraints.spec_lifecycle`（路径、状态机、approved 锁定）
→ `yaml → constraints.context_budget`（阶段、500 字摘要、50K token 上限、90% 预警）

**上下文管理**：
- Dispatch 摘要：Agent 完成后只保留 500 字标准摘要，不保留完整对话和工具调用
- 摘要截断：超 500 字截断，优先保留角色、任务、质量指标
- Dispatch 约束：不注入其他 Worker 原始对话历史、超过 1 个 dispatch 前的中间产物
- 主动摘要：调度超 3 个 Worker 后对前序角色各自 500 字摘要，P0 完整保留

**未验证记忆**：`unverified` 状态记忆仅供参考，不得作为决策依据。引用前必须提示 PM 确认。

## 5. AI 行为围栏
→ `yaml → fence.execution_rules`（6 条规则 + 检查时机 + 违反处理）
→ `yaml → fence.main_session_self_check`
以下为围栏准则的**反模式**（YAML 中只有规则，没有反模式）：

### 先想清楚再动手
不假设、不隐藏困惑、暴露权衡。
**反模式**：用户说"加导出功能"，Developer 不问范围/格式/字段就写全量导出。

### 简单优先
最小代码解决问题。不做推测性设计。
**反模式**：用户说"加折扣计算"，Developer 写 Strategy 模式 + 抽象工厂 + 配置系统。

### 精准变更
只动该动的。每行变更可追溯到明确请求。
**反模式**：修邮箱校验 bug 时顺手改用户名校验、加类型注解、重格式化。

### 目标驱动执行
定义成功标准，循环直到验证通过。"添加校验"→ 写测试让测试通过；"修复 Bug"→ 写复现测试让测试通过。
**反模式**：用户说"修复认证系统"，Developer 直接改代码而不先定义"修复完成"。

## 6. 文件结构
```
.claude/
├── agents/          # 角色配置
├── commands/        # rd:* 命令
├── skills/          # 技能
├── tools/scripts/   # 辅助脚本
├── workflows/       # 流程定义
├── hooks/           # Git hooks
├── rules/           # 项目规则
└── reference/       # 框架参考
.harness/
├── spec/            # SPEC 文档库
├── adr/             # 架构决策记录
├── eval/            # 模型评估
├── interfaces/      # 跨模块接口契约
├── knowledge/       # 领域知识
├── memory/          # 项目记忆
├── reports/         # 测试与评估报告
├── tasks/           # 任务工单
├── templates/       # 文档模板
└── directory-spec.md
```

### SPEC 生命周期
→ `yaml → constraints.spec_lifecycle.states`（7 状态 + 转换条件）
```
/rd:explore → /rd:propose → /rd:apply → /rd:archive
Architect      Architect      Developer    Architect
梳理需求       生成制品       按任务实施    归档变更
```
- **SPEC 评审**（propose→apply）：Reviewer 评审，阈值同 `yaml → scoring.thresholds`
- **测试+代码评审**（apply→archive）：Tester 集成测试 + Reviewer 代码评审

## 7. Git Push 审批
→ `.claude/workflows/push-approval-flow.md`
每次 push 需 PreToolUse hook Challenge-Response 审批。
**⚠️ 挑战码绑定 HEAD hash。push 被拦截后立即停止一切修改，不得创建新 commit。**
**绝对禁止**：PM 批准前自行写入 token；挑战码有效期内创建新 commit；AI 自行绕过。
