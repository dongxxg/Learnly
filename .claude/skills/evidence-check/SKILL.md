---
name: evidence-check
version: 1.0.0
description: 检查 AI MR 合规证据链完整性。扫描 pipeline-state.json，逐条验证 6 字段（触发来源/意图门禁/变更摘要/测试报告/Review评分/Token消费）是否齐全。支持单仓和多仓扫描。Triggers: evidence check, 证据链审计, 合规检查, evidence-check, /evidence-check
---
# Evidence Check 证据链审计

## Overview

对 AI MR 的 pipeline-state.json 进行 6 字段合规证据链检查。

**审计标准**：触发来源 → 意图门禁 → 变更摘要 → 测试报告 → Review 评分 → Token 消费。

## When to Use

- 检查当前仓库 AI MR 合规状态
- 多仓库合并审计
- 商用审计前证据链确认

## 执行流程

### 1. 确定扫描范围和模式

解析用户输入中的参数：


| 参数                   | 说明                                    | 默认                      |
| -------------------- | ------------------------------------- | ----------------------- |
| `--all`              | 扫描全部 change（不过滤日期）                    | 不传则默认 `--since <today>` |
| `--since YYYY-MM-DD` | 只扫描该日期及之后的 change                     | 今天                      |
| `--repos /a,/b,/c`   | 指定仓库路径列表（逗号分隔）                        | 当前仓库                    |
| `--discover`         | 从当前目录的上级目录自动发现含 `.harness/tasks/` 的项目 | —                       |


**模式判定**：

- 有 `--repos` → 多仓模式
- 有 `--discover` → 自动发现模式（从 `$PWD` 向上两级查找含 `.harness/tasks/` 的目录）
- 默认 → 单仓模式（当前仓库）

### 2. 执行扫描

```bash
python3 ${HARNESS_ROOT:-.claude}/skills/evidence-check/scripts/check.py [args...]
```

对于多仓模式，对每个仓库逐次调用 `--repo <path>`，最后合并输出。

### 3. 展示结果

- 主会话 Read 并输出 Markdown 报告全文
- 标注合规率、阻塞项、待补齐项
- 多仓模式先展示汇总表，再逐仓明细

## 输出位置

```
<repo>/.harness/audit/
  <repo-name>.json          # 结构化数据
  <repo-name>.md            # 人读报告

（多仓） <current-repo>/.harness/audit/
  merged-<ts>.json
  merged-<ts>.md
```

## 6 字段 vs flow type


| flow_type                   | Tester/Reviewer 期望               |
| --------------------------- | -------------------------------- |
| `development`               | 全部 6 字段应齐全                       |
| `quick` / `hotfix` / `docs` | Tester/Reviewer 不强制，缺失标 N/A（非缺陷） |


## 审计结论


| 结论                 | 条件                  |
| ------------------ | ------------------- |
| `pass`             | 6/6 齐全              |
| `conditional_pass` | 缺字段但均在 N/A 允许范围     |
| `block`            | 缺字段超出允许范围           |
| `na`               | 非业务 MR（CI 驱动 / 未启动） |


