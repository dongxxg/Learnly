# Uni-AURI 协作规则

> **协作规范**。Session 启动注入，项目**不得修改**。冲突时以 `harness-rules.yaml` 为准。
> 项目自生长规则从 `.harness/ai-rules/*.md` 自动加载（无文件则跳过）。
> ZCode 通过生成的 `.zcode/` 本地插件分发 Hooks、Skills 与角色；项目指令同步到工作区根 `AGENTS.md`。

## 1. AI 行为围栏

- **先想清楚再动手**：不假设、不隐藏困惑、暴露权衡。不确定时主动问 PM
- **简单优先**：最小代码解决问题，不做推测性设计
- **精准变更**：只动该动的，不改相邻代码/格式/无关逻辑
- **目标驱动执行**：先定义成功标准，循环直到验证通过
→ `.claude/reference/harness-rules.yaml` → `fence`

## 2. Git 红线

- **禁止 `--amend`**：commit-msg hook 不兼容，100% 拒绝
- **禁止 `--no-verify`**：不得跳过 hook 校验
- **禁止 force push 到共享分支**：`main` / `master` / `release/*` / 团队开发分支永远禁用 force push；non-fast-forward 必须用 `git pull --rebase` 解决
- **个人 feature 分支推荐 `--force-with-lease`**：仅单人使用的非共享 feature 分支，允许 `git push --force-with-lease` 修复提交历史，无需 PM 额外授权。`--force-with-lease` 自动校验远端无他人新提交后执行，防止意外覆盖。
- **commit / push 前必 fetch**：避免本地基线落后、push 被拒后误操作。详见 `.claude/rules/ai-git-commit-spec.md` 「操作顺序」一节
- **Push 需 PM 审批**：Challenge-Response 流程 → `.claude/reference/harness-rules.yaml` → `constraints.git.push_approval`
- **建分支需名校验 + PM 审批**：AI 创建分支（`checkout -b` / `switch -c` / `branch <name>` / `worktree add -b`）由 git-guard 拦截——分支名须符合 `<type>/<task-id>` 规范，合规后仍需 PM Challenge-Response 批准。切换/删除已有分支不受限。SOP → `.claude/workflows/branch-approval-flow.md`
- **rebase 冲突处理**：`git rebase` 遇到冲突 → 编辑解决 → `git add` → `git rebase --continue`。禁止 `--abort` 绕过或冲突时 commit。
- Commit 格式 → `.claude/rules/ai-git-commit-spec.md`

## 3. 多智能体协作


| 角色                                                                                                                     | 职责                    |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Architect                                                                                                              | 设计、SPEC、ADR           |
| Developer                                                                                                              | 实现、单测                 |
| Tester                                                                                                                 | 集成/E2E 测试             |
| Reviewer                                                                                                               | 评审、质量、UX              |
| Debate                                                                                                                 | 对抗审计，评分 75-79 或 PM 触发 |
| **硬规则**：禁止 Worker 间直接通信（hub-and-spoke）；BLOCKED 连续 3 次 → 熔断升级 PM。                                                       |                       |
| **状态共享**：`concerns.json`（`.harness/shared-state/<change>/`）—— Reviewer 写入 P0/P1，advance() code-review 自动读取 open P0 否决。 |                       |
| → `.claude/reference/harness-rules.yaml` → `roles, exit_states`                                                        |                       |


## 4. 工作流程

**SPEC 生命周期**：`explore`(Architect) → `propose`(Architect+评审) → `apply`(Developer+Tester+Reviewer) → `archive`(Architect)

- **TDD Iron Law**：调度 Developer 前检测已有实现代码。绕过时提示 PM，PM 拒绝后注入 `TDD_BYPASS`
- **评审管线**：≥80 通过 → 75-79 Debate → &lt;75 返工。P0 一票否决
- **PM Override**：9 步 Challenge-Response，禁止静默执行/润色绕过原因/接受模糊确认
→ `./harness-rules.yaml` → `workflow, scoring, pm_override, constraints.spec_lifecycle`

## 5. 质量门禁

QG-ARCH-001（SPEC 完整性）、QG-DEV-001（覆盖率≥80%+linter 零 error）、QG-REV-001（评分≥80）、QG-REV-002（P0 清零）。Hotfix 阈值 70，跳过 Architect/Debate。
→ `./harness-rules.yaml` → `quality_gates`

## 6. 上下文管理

- Agent 子会话完成后只保留摘要（文件路径、关键决策、测试结果）
- 调度 Worker 不注入其他 Worker 原始对话历史、超过 1 个 dispatch 前的中间产物
- 调度超过 3 个 Worker 后主动摘要前序角色，P0 完整保留
- 优先丢弃：调试过程、已关闭阻塞项、Agent 完整记录
→ `./harness-rules.yaml` → `constraints.context_budget`

## 7. 文件删除红线

- **禁止对 untracked 文件直接 `rm`**：未纳入 git 的文件删除后无法恢复，必须先问 PM
- **优先移动而非删除**：不确定时先移到 `docs/` 等归档目录，让 PM 决定

## 8. 记忆写入


| 类型                    | 存储                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `user`/`feedback`     | `$HARNESS_PROJECTS_DIR` 指向的用户目录（跟人走，不进 git；由各 backend 的 hook 注入） |
| `project`/`reference` | `.harness/memory/`（跟项目走，git 跟踪）                                                                                                    |


## 9. Dispatch 上下文模式

rd-auto dispatch 自动选择：


| 模式                                                                       | Token    | 适用    |
| ------------------------------------------------------------------------ | -------- | ----- |
| `minimal`                                                                | ~100-200 | 探索、定位 |
| `read_only`                                                              | ~4500    | 评审、检查 |
| `full`                                                                   | ~5000    | 实现、修复 |
| 自动升级：`NEEDS_CONTEXT` 时升档（minimal→read_only→full），最多 2 次后 escalate_to_pm。 |          |       |


## 10. 反馈建议

发现 Uni-AURI bug 或优化建议时，提交 issue 到 Uni-AURI 仓库。**必须提供完整上下文**（复现步骤、错误日志、版本、涉及文件）。

```bash
export CLAUDE_MODEL="glm-5.2"  # 当前会话所用模型，便于开发侧定位 token/上下文/格式问题
bash .claude/tools/scripts/submit-harness-issue.sh "标题" "问题摘要" "stderr日志文件路径(可选)"
```

脚本自动收集环境信息并提交，issue 带 `ai-detected` 标签。

**主动触发**：问题根因在 `.claude/` 或 `.harness/` 下的仓库文件（非业务代码）时，主动提示用户调用上述脚本——脚本/命令非预期报错、规则冲突需绕行、CI 步骤反复失败、用户对行为困惑。

**禁止触发**：MR Review / Code Review / Debate 等评审场景中，不得提交 issue。评审发现的问题通过 concerns.json / review 报告流转，不走 issue 渠道。
