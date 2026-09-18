# 任务完成门禁 — AI 行为约束

> taskboard 服务端已实施**硬门禁**（done-evidence-gate）：任务从非完成态移到完成态时，若既无附件也无评论，服务端直接**拒绝移动**（`EVIDENCE_GATE_BLOCKED`）。门禁与分支无关（看板任务默认全在 Main workstream，按分支过滤门禁永不触发）。本规则不复述 server 判定逻辑，只规定 AI 遇到门禁后的处置行为。

## 双态兼容（双仓过渡期必读）

部署顺序为先 rd_harness 后 taskboard，AI 可能连到两种服务端，按响应分支处理：

| 响应 | 服务端版本 | AI 行为 |
| --- | --- | --- |
| 调用**失败**，错误含 `EVIDENCE_GATE_BLOCKED` | 新服务端（硬门禁） | 按下文「三选一处置」执行 |
| 调用**成功**，返回 `warnings`（`NO_ARTIFACTS_ON_DONE`） | 旧服务端（软提示） | 按下文「三选一处置」执行（行为等价，状态已移动，不得回滚） |
| 调用成功，`warnings` 为空 | 两种皆可 | 正常继续 |

禁止把门禁错误当作普通失败重试原调用——不改变前置条件的重试必然再次被拒。

## 三选一处置（A/B/C）

被拦（或收到旧软提示）时，AI 必须把三个选项呈现给用户，**不预设答案**：

- **A. 上传证据（推荐）**——spec / design / 测试报告等，走两阶段上传（见下节），完成后原样重试
- **B. 填豁免理由**——commit 已充分留痕、确属无需留痕等场景；新服务端携带 `completionOverride: {reason: "<一句话理由>"}` 重试，服务端会以操作者名义自动落一条 `[完成豁免]` 评论；**理由必填且真实**，禁止空串或占位符
- **C. 补评论**——`add-task-comment` 写一条完成说明后重试

网页端拖拽被拦会弹出完成对话框，同样三选一。

## 网页批量（batch-update-task-status）

批量移动部分被拦时，响应 `updated` / `failed` 分列；`failed[].error` 含 `EVIDENCE_GATE_BLOCKED`。AI 必须逐条告知用户哪些被拦及原因，只对被拦任务走三选一，不得静默丢弃 `failed` 列表。

## 上传机制（选项 A 触发时）

`create-attachment-upload-ticket` 是两阶段上传：

```
Step A: mcp__taskboard__create-attachment-upload-ticket({
          taskId, projectId,
          filename, mimeType, size
        })
        → 返回 { uploadUrl, ticketId, expiresAt }

Step B: curl -F 'file=@<path>' <uploadUrl>
        → 返回 { id: attachmentId }
```

约束：
- ticket 10 分钟一次性
- `filename` / `mimeType` / `size` 必须与 Step A 锁定的一致（否则 400）
- 不需要 PAT（ticket 本身是凭证）

## 选项 B（commit 已留痕）的判断标准

用户选 B 时，AI 应**验证**而非盲信。检查最近相关 commit 的 message：

| 充分 | 不充分 |
|------|-------|
| 含根因 + 方案 + 影响范围 | "fix bug" / "update code" |
| 引用了 task code（如 `[630]`） | 无 task code 关联 |
| 描述了测试/验证方法 | 仅一行标题 |

判断不确定时回到 A/C 选项让用户决定，不替用户做主。

## 与 daily-report 的关系

任务完成门禁与 daily-report **相互独立**：
- 任务移到完成态时按本规则处置门禁
- 每日按 daily-report skill 流程提交日报
- 一个任务完成可以不提交当日日报，反之亦然
