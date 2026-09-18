# Git 分支创建审批流程 — AI 执行 SOP

> **适用范围**：所有需要创建分支的 AI 员工
> **机制**：git-guard PreToolUse hook 通过名校验 + Challenge-Response 确保建分支需人类审批
> **拦截范围**：`git checkout -b/-B`、`git switch -c/-C`、`git branch <name>`、`git worktree add -b`。切换/删除已有分支不受限。

## 标准操作流程

```
Step 1: AI 执行 git checkout -b feature/630
        → Hook 先校验分支名：
          不合规 → 直接拒绝（不走审批），提示合法格式
          合规 → 拒绝并输出:

          分支创建需要 PM 审批（首次触发）。
          分支名：feature/630  挑战码: 9ae52674
          PM 审批方式：回复 AI「批准 9ae52674」…

Step 2: AI 将分支名 + 挑战码原样展示给 PM，等待审批

Step 3: PM 回复「批准 9ae52674」（或拒绝）
        - 批准 → 进入 Step 4
        - 拒绝 → AI 停止建分支，按 PM 指示改用合规分支名重新触发

Step 4: AI 分两步执行:
        步骤1: echo "9ae52674" > .harness/.branch-approved
        步骤2: git checkout -b feature/630
        → 校验 token==nonce 且分支名一致且未过期 → 放行 → 删除状态文件
```

## AI 必须遵守的规则

1. **永远不要**在 PM 批准前自行写入 `.harness/.branch-approved` 文件
2. **收到批准后**，必须从 hook deny 输出中提取挑战码，分两步执行：先写 token，再重新执行**同一条**建分支命令
3. **⚠️ 挑战码绑定分支名**。挑战码生成后不得换分支名——换名即失效，需重新触发
4. **挑战码有效期 5 分钟**（300 秒），超时需重新触发
5. 分支名不合规（无 type 前缀 / 大写 / 下划线 / 非白名单 type）会被直接拒绝，**没有审批通道**——改名重来
6. **AI 无法读取 `.harness/.branch-challenge` 文件**（被 pre-tool-use-git-guard 保护），必须从 hook deny 输出解析挑战码
7. 特殊分支（`release/*` 等）：type 不在白名单，请 PM 在终端自行创建

## Hook 错误消息速查

| 消息关键词 | 原因 | AI 动作 |
|-----------|------|--------|
| 「禁止创建不符合命名规范」 | 分支名无 type 前缀/大写/下划线/type 不合法 | 改用合规名重新执行（不展示给 PM 审批） |
| 「首次触发」 | 首次请求，挑战码已生成 | 展示分支名+挑战码给 PM，等待批准 |
| 「等待批准」 | 挑战码有效期内重试，token 未写入 | 同上 |
| 「令牌无效（不匹配或分支名不一致）」 | token 错或换了分支名 | 重新执行建分支命令触发新挑战码 |
| 「挑战码已过期」 | 超过 5 分钟 | 重新执行建分支命令触发新挑战码 |
| 「无对应挑战码文件」 | 残留 token（无 challenge） | 重新执行建分支命令触发新挑战码 |

## 文件说明

| 文件 | 用途 | 生命周期 |
|------|------|---------|
| `.harness/.branch-challenge` | 当前挑战码（格式: NONCE:BRANCH:TIMESTAMP） | 批准通过后自动删除；AI 不可读 |
| `.harness/.branch-approved` | PM 批准的 token | 批准通过后自动删除；AI 可写（写入 PM 批准的挑战码） |

**CI 豁免**：`CLAUDE_BRANCH_AUTO_APPROVE=1` 时跳过审批（对齐 push 审批的 `CLAUDE_PUSH_AUTO_APPROVE`）。

> Hook 脚本位置：`.claude/hooks/shared/pre-tool-use-git-guard.sh` 第 4 段
> 权威配置：`.claude/reference/harness-rules.yaml` → `constraints.git.branch_creation`
