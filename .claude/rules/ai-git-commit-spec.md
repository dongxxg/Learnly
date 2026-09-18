# AI Git 提交规范（红线版）

> 完整表格/示例按需查阅 `.claude/reference/git-commit-spec-full.md`；commit-msg / git-guard hook 为最终执行者，冲突时以 hook 报错提示为准。

## 操作顺序

commit 前 fetch；push 前 fetch。若 behind → `git pull --rebase`（**禁止** 裸 `git pull` / `git merge` 同步远端，merge commit 被 pre-receive 拒绝）。push 走 Challenge-Response 审批。

## 红线（100% 拒绝）

- 禁止 `commit --amend`、`--no-verify`、force push 到共享分支（`main`/`master`/`release/*`/团队分支）
- 个人 feature 分支允许 `git push --force-with-lease`（远端有新提交时：fetch → rebase → 重推）
- rebase 冲突：编辑 → `git add` → `git rebase --continue`；**禁止** `--abort` 绕过、禁止 `--ours`/`--theirs` 自动选（rebase 语义与 merge 相反）
- 已 push 的 commit 只能 `git revert <sha>`；个人分支修历史：`reset --hard <sha>` + `--force-with-lease`

## 分支命名

`<type>/<task-id>[-<desc>]`；type ∈ `feature|fix|hotfix|refactor|docs|chore`。小写 kebab-case；禁 `dev`/`test`/`tmp`/`wip`/姓名前缀/直接在 main 开发。AI 建分支经 git-guard 校验后仍需 PM 审批；切换/删除已有分支不受限。

## Commit 格式

```
[<任务号>] <阶段标识> <模块>[<操作者>]

<type>: <中文摘要>
- 变更点
```

- **任务号必填**：无任务用 `[0000]`；纯数字（`[630]`）或字母数字前缀+数字（`[abc-123]`、`[PRJ96199-7]`）
- **阶段标识 → type**：DEV→feat、BUG→fix、CM/REL/MIGRATE→chore、TEST→test、DOCS→docs、REFACTOR→refactor、PERF→perf、SEC/HOTFIX→fix、CI→ci（CI 禁 AI 独立提交，须 `[H-*]` 或 `[AI-*]` 用户名格式）、WIP→chore
- **操作者**：`[AI-{git用户名}.{角色}]`（用户名须与 `git config user.name` 一致，hook 校验）；无法获取时 `[AI·{角色}]`；人提交 `[H-{git用户名}]`
- **模块名**：从 `git diff --name-only` 提取真实变更域（如 `git-guard`、`框架配置`）；禁止复用 change 名或与变更无关的通用名
- **摘要**：≤72 字符、动宾结构、不以句号结尾；禁模糊词（`修改`/`优化`/`update code`）、禁用模块名代替 type

## 粒度（原子提交）

一 commit 一逻辑变更，可独立通过测试/revert/review：

- 修 bug + 对应测试 → 同一个 commit；不相关变更 → 拆分
- message 出现「和/同时/另外/以及」→ 应拆；diff 超 500 行 → 检查是否该拆
- 禁巨型 commit、碎颗粒（连发 typo 修复应合并）、半成品（必须时 `[WIP]` 标识并告知 PM）
