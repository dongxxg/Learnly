# Git Push 审批流程 — AI 执行 SOP

> **适用范围**：所有需要 `git push` 的 AI 员工
> **机制**：pre-push git hook 通过 Challenge-Response（编号菜单）确保推送需人类审批

## 标准操作流程

AI 执行 `git push` → hook 生成编号菜单 → PM 回复编号 → AI 解析挑战码写入 token 后重新推送

```
Step 1: AI 确认无未提交修改，执行 git push public <branch>
        → Hook 拒绝，输出编号菜单:

          推送需要审批: <commit msg>
          HEAD: a1b2c3d  挑战码: 9ae52674
          [1] 批准推送  [2] 拒绝推送
          PM 回复编号（1 或 2）

Step 2: AI 停止一切修改，等待 PM 审批（不得创建新 commit）

Step 3: PM 回复编号（1 或 2）
        - 回复 1 → 批准
        - 回复 2 → 拒绝，AI 停止推送并告知 PM

Step 4: AI 从菜单输出中提取挑战码（NONCE），分两步执行:
        步骤1: echo "9ae52674" > .harness/.push-approved
        步骤2: git push public <branch>
        → 校验 token==nonce 且 HEAD hash 未变 → 通过 → 删除状态文件 → 推送放行
```

## AI 必须遵守的规则

1. **永远不要**在 PM 批准前自行写入 `.harness/.push-approved` 文件
2. **收到批准（编号 1）后**，必须从 hook 菜单输出中提取挑战码，分两步执行：先 `echo "NONCE" > .harness/.push-approved`，再 `git push public <branch>`
3. **⚠️ 挑战码绑定 HEAD hash。挑战码生成后到 push 完成前，绝对禁止创建新 commit**——否则挑战码立即失效，必须重新触发
4. **挑战码有效期 6 小时**（21600 秒），超时需要重新触发
5. 如果在写入 token 前又一次执行了 `git push`，hook 会**保留**挑战码并提示补充 token（不会再覆盖）
6. **AI 无法读取 `.harness/.push-challenge` 文件**（被 pre-tool-use-git-guard 保护），必须从 hook 菜单输出去解析 NONCE

## Hook 错误消息速查

| 消息关键词 | 原因 | AI 动作 |
|-----------|------|--------|
| 编号菜单「[1] 批准推送」 | 首次触发或重试，新/已有挑战码 | 展示给 PM，等待编号选择 |
| 「已生成但尚未获得批准」 | 挑战码还在有效期内，但 token 未写入 | 展示菜单给 PM，等待编号选择 |
| 「令牌与挑战码不匹配」 | 写入的 token 与当前挑战码不一致 | 展示菜单给 PM，等待重新选择 |
| 「挑战码已过期」 | 超过 6 小时 | 重新 `git push` 触发新挑战码 |
| 「HEAD 已变更」 | 两次 push 之间产生了新 commit | 重新 `git push` 触发新挑战码 |

## 文件说明

| 文件 | 用途 | 生命周期 |
|------|------|---------|
| `.harness/.push-challenge` | 当前挑战码（格式: NONCE:HASH:TIMESTAMP） | 批准通过后自动删除 |
| `.harness/.push-approved` | PM 批准的 token | 批准通过后自动删除 |

**安全约束**：`.harness/.push-challenge` 被 `pre-tool-use-git-guard.sh` 的 `_BYPASS_FILES_RE` 正则保护，AI 无法读取。nonce 只能通过 hook 菜单输出（stderr）获取，确保人类必须参与审批。

**清理机制**：hook 在 source helper 后立即 `cd "$CLAUDE_PROJECT_DIR"`（兜底：`git rev-parse --show-toplevel`），确保 `.harness/.push-*` 相对路径可解析；清理失败降级为 stderr warning，不阻塞已通过 token 验证的 push。详见 ADR-007。

> Hook 脚本位置：`.claude/hooks/git/pre-push`
