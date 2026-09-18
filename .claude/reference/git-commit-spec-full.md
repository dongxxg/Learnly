# AI Git 提交规范 — 完整版（按需查阅）

> 本文件不自动注入会话，仅在被引用时查阅。自动注入的为 `.claude/rules/ai-git-commit-spec.md`（红线版）。
> commit-msg / git-guard hook 为最终执行者，冲突时以 hook 报错提示为准。

## 操作顺序（必读）

### 标准流程

```
1. git fetch <remote>                          # 拉取远端最新引用（不修改工作区）
2. git status -sb                              # 检查与远端的关系
3. 若 behind（远端有新提交）:
   git pull --rebase <remote> <branch>         # rebase 而非 merge，保持线性历史
   处理冲突 → git rebase --continue
4. git add <files> && git commit               # 提交本地变更
5. git fetch <remote>                          # 再次 fetch（commit 期间远端可能又有新提交）
6. git status -sb                              # 必须显示 "up to date" 或 "ahead"
7. git push <remote> <branch>                  # 走 Challenge-Response 审批
```

### 强制规则
- **commit 前必 fetch**。
- **push 前必 fetch**：若被拒，必须 `git pull --rebase`。
- **禁止 force push 到共享分支**：`main` / `master` / `release/*` / 团队开发分支永远禁用 force push。
- **个人 feature 分支推荐 `--force-with-lease`**：仅单人使用的非共享 feature 分支，允许 `git push --force-with-lease` 修复提交历史，无需 PM 额外授权。`--force-with-lease` 会自动校验远端无他人新提交后执行，防止意外覆盖。
- **禁止用 `git merge` 同步远端变更**：`git merge` 产生的 merge commit 会被服务端 pre-receive 拒绝。分支合并必须通过 GitLab Merge Request 流程，确保代码评审和 CI 门禁。
- **禁止裸 `git pull`（无 `--rebase`）同步远端**：裸 `git pull`（默认 merge 策略）在落后远端时会自动产生 merge commit，等同 `git merge`，会被服务端 pre-receive 拒绝（事后拦截，AI 已 push 失败需回退返工）。同步远端统一用 `git pull --rebase`（或 `git fetch` + `git rebase`）。PreToolUse `git-guard` 会当场拦截裸 `git pull`，提示改用 `git pull --rebase`。

### 冲突处理

执行 `git pull --rebase` 或 `git rebase` 遇到冲突时：

```
1. git status                                # 看 "Unmerged paths:" 列出冲突文件
2. 编辑冲突文件（标记 <<<<<<< / ======= / >>>>>>> 的部分）
3. git add <已解决的文件>                      # 标记冲突已解决（不要 commit！）
4. git rebase --continue                     # 可能连续多次重复 1-4
5. 确实无法解决时（如大面积重构冲突）：git rebase --abort → 向 PM 报告
```

**禁止** `--ours`/`--theirs` 自动选择——rebase 与 merge 中语义相反：

| 场景           | `--ours` 指     | `--theirs` 指    |
| ------------ | ------------- | --------------- |
| `git merge`  | 当前分支          | 被合并的分支          |
| `git rebase` | rebase 的基线（远端基线） | 你的工作 |

**多人同一 feature 分支**：`--force-with-lease` 被拒时（远端有新提交），`git fetch` → `git rebase` → 重新 `--force-with-lease`。

**代码合并分歧**：不确定如何解决冲突时，与相关开发者沟通确认，不擅自做破坏性选择。

## Revert 规范

**已 push 的 commit 只能用 `git revert <sha>` 撤销**（创建反向 commit）。
禁止 `reset --hard` / `rebase -i` / `commit --amend` 修改已 push 的历史。
个人 feature 分支需修复提交历史时，用 `git reset --hard <sha>` → `git push --force-with-lease`（生产/共享分支禁用）。

## 分支命名规范

> AI 创建分支（`checkout -b/-B`、`switch -c/-C`、`branch <name>`、`worktree add -b`）由 git-guard hook 拦截——分支名先校验（不合规直接拒绝），合规后仍需 PM Challenge-Response 审批（`批准 <挑战码>`）。特殊分支（`release/*` 等）请 PM 在终端自行创建。

```
<type>/<task-id>[-<short-desc>]
```

| type        | 用途          | 示例                                     |
| ----------- | ----------- | -------------------------------------- |
| `feature/`  | 新功能开发       | `feature/630`、`feature/630-user-login` |
| `fix/`      | Bug 修复（非紧急） | `fix/152-render-bug`                   |
| `hotfix/`   | 生产 P0 紧急    | `hotfix/payment-down`                  |
| `refactor/` | 重构（无行为变化）   | `refactor/collect-git`                 |
| `docs/`     | 文档          | `docs/api-spec`                        |
| `chore/`    | 配置/依赖/工具链   | `chore/bump-deps`                      |

**规则**：
- 任务号优先（如有）：`feature/630`
- 全小写、kebab-case，禁止下划线 / 空格 / 中文
- 短描述可选，若加必须有意义：`feature/630-user-login` ✅，`feature/630-misc` ❌

**禁止**：
- `dev`、`test`、`tmp`、`wip`、`xxx` 等无意义前缀
- 个人姓名前缀：`zhangsan/feature-630`
- 直接在 `main` / `master` 上开发

## 格式

```
[<任务号>] <阶段标识> <模块>[<操作者>]

<type>: <中文摘要>
- 变更点
```

**任务号必填**：首行方括号中的任务号不能省略，无具体任务时用 `[0000]`。任务号为纯数字（`[630]`、`[12345]`）或字母/字母数字前缀+数字（`[abc-123]`、`[PRJ96199-7]`）。

### 阶段标识 → Body type

| 阶段标识       | 含义                      | 对应 body type     |
| ---------- | ----------------------- | ---------------- |
| `DEV`      | 功能开发                    | `feat`           |
| `BUG`      | Bug 修复                  | `fix`            |
| `CM`       | 配置管理（CI/CD、hooks、构建、依赖） | `chore`          |
| `TEST`     | 测试                      | `test`           |
| `DOCS`     | 文档                      | `docs`           |
| `REFACTOR` | 重构                      | `refactor`       |
| `PERF`     | 性能优化                    | `perf`           |
| `SEC`      | 安全修复                    | `fix`            |
| `CI`       | CI 专有变更                 | `ci`（禁止 AI 独立提交，须用 `[H-{git用户名}]` 或 `[AI-{git用户名}.{角色}]` 格式） |
| `REL`      | 发布/版本                   | `chore`          |
| `HOTFIX`   | 生产 P0 紧急修复              | `fix`            |
| `MIGRATE`  | 数据/Schema 迁移            | `chore`          |
| `WIP`      | 进行中暂存（跨 Session）        | `chore`          |

跨多个标识时，选最能说明**本次提交意图**的标识。

### 操作者

| 格式                  | 场景                                                     |
| ------------------- | ------------------------------------------------------ |
| `[AI-{git用户名}.{角色}]` | Claude Code 会话提交（默认，含真实 git 用户名）                       |
| `[AI·{角色}]`         | 简写形式（中点分隔，省略用户名；无法获取 git 用户名时） |
| `[H-{git用户名}]`       | 人在终端手动提交                                               |

角色：`Developer` / `Architect` / `Tester` / `Reviewer` / `Debate`

> **注意**：用户名必须与 `git config user.name` 一致，hook 会校验以防 AI 编造他人名字。无法获取用户名时改用简写 `[AI·{角色}]`。

### 模块名规则

**模块名必须反映本次提交实际变更的模块/功能域**，禁止直接复用 change 名/任务名——必须从 git diff --name-only 提取公共路径作为模块名。同一 change 下不同模块的提交，模块名应有区分。

| 变更涉及          | 模块名示例                                        | 禁止              |
| ------------- | -------------------------------------------- | --------------- |
| hook 脚本       | `git-guard` / `pre-commit` / `session-start` | `与变更无关的通用名` |
| 版本号           | `harness-version`                            | `与变更无关的通用名`          |
| 框架安全          | `框架安全` / `bypass 治理`                         | `与变更无关的通用名`          |
| settings.json | `框架配置`                                       | `与变更无关的通用名`          |
| 测试文件          | `kanban 测试` / `commit 测试`                    | `与变更无关的通用名`          |

**判定标准**：看 `git diff --name-only` 的变更路径，提取首个公共目录/文件名作为模块。

### 摘要规则

≤ 72 字符，动宾结构中文摘要（如"新增xx功能"/"修复xx问题"/"重构xx模块"/"移除xx代码"），不以句号结尾。禁止模糊词（`修改`、`优化`、`update code`）。禁止用模块名代替 type（如 `git-guard: 修复xxx` ❌，应写 `fix: 修复xxx`）。

## Commit 粒度规范

**原则**：一个 commit 一个原子逻辑变更（atomic commit）。能独立通过测试、独立 revert、独立 review。

| 场景                | 应该           | 禁止           |
| ----------------- | ------------ | ------------ |
| 修 bug + 加测试       | 一个 commit    | 拆 2 个 commit |
| 重构 + 修 bug（不相关）   | 拆 2 个 commit | 揉一个          |
| 多文件实现同一功能         | 一个 commit    | 按文件拆 N 个     |
| 同功能 + 顺带改的无关 typo | 拆 2 个 commit | 揉一个          |

**判定标准**：
- message 能用一行动宾结构说清楚 → 粒度合适
- message 出现"和" / "同时" / "另外" / "以及" → 应该拆
- diff 超 500 行（除自动生成代码 / 锁文件 / vendor）→ 检查是否应该拆
- 一个 commit 不能独立通过测试 → 粒度太小（半成品）

**反模式**：
- ❌ **巨型 commit**：「实现登录 + 修密码 bug + 改 UI」（3 件不相关的事揉一起）
- ❌ **碎颗粒**：「修 typo」「再修 typo」「还是 typo」（应揉成一个）
- ❌ **半成品**：「先提交一半，下次接着写」（破坏当前分支的可构建性；若必须，用 `[WIP]` 标识且明确告知 PM）

## 示例

三种合法首行格式（任务号必填，无任务用 `[0000]`）：

```
[56616] DEV 融合引擎[AI-{git用户名}.Developer]      （标准格式：含 git 用户名）

feat: 新增多源数据融合执行引擎
- 实现 FusionExecutor 核心逻辑
- 支持并行数据源路由与结果合并
```

```
[56083] DEV 融合引擎[AI·Developer]             （简写格式：省略 git 用户名）

feat: 新增多源数据融合执行引擎
- 实现 FusionExecutor 核心逻辑
```

```
[0000] BUG git-guard[AI-{git用户名}.Developer]       （无具体任务，任务号用 [0000]）

fix: 修复 commit-msg 错误提示不含合法示例
- 规则1 失败时展示 3 种合法示例
```
