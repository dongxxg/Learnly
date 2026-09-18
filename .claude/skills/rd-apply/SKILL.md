---
name: rd:apply
description: 实施变更中的任务。用于启动实施、继续实施或逐项完成任务。
license: MIT
compatibility: 需要 rd CLI。
metadata:
  author: rd
  version: "1.0"
  generatedBy: "1.7.4"
---

实施变更中的任务。所有提示消息使用中文。

**输入**：可选指定变更名称。如果未指定，检查是否可以从对话上下文中推断。如果模糊或存在歧义，你必须提示用户选择可用的变更。

---

## 前置协作

在开始实施前，使用 **Agent 工具**（subagent_type: "Developer"）发起协作：

> 请 Developer 阅读变更的 proposal、design 和 tasks，规划实施策略：
> - 任务的推荐实施顺序和依赖关系
> - 需要优先编写的测试用例（TDD 红灯阶段）
> - 潜在的技术难点和应对方案
>
> 将 Developer 的输出作为实施计划的参考。

---

**步骤**

1. **选择变更**

   如果提供了名称，直接使用。否则：
   - 如果用户提到了某个变更，从对话上下文中推断
   - 如果只有一个活跃变更，自动选择
   - 如果存在歧义，运行 `rd list --json` 获取可用变更，使用 **AskUserQuestion 工具** 让用户选择

   始终宣布："正在使用变更：<name>"，以及如何覆盖（例如 `/rd:apply <other>`）。

2. **检查状态以了解 schema**
   ```bash
   rd status --change "<name>" --json
   ```
   解析 JSON 以了解：
   - `schemaName`：正在使用的工作流（例如 "spec-driven"）
   - 哪个 artifact 包含任务（通常是 spec-driven 中的 "tasks"，其他 schema 请查看状态输出）

3. **获取实施指令**

   ```bash
   rd instructions apply --change "<name>" --json
   ```

   返回内容：
   - `contextFiles`：artifact ID -> 具体文件路径数组（因 schema 而异 - 可能是 proposal/specs/design/tasks 或 spec/tests/implementation/docs）
   - 进度（总数、已完成、剩余）
   - 带状态的任务列表
   - 基于当前状态的动态指令

   **处理状态：**
   - 如果 `state: "blocked"`（缺少 artifact）：显示提示信息，建议使用 rd-continue-change
   - 如果 `state: "all_done"`：表示祝贺，建议归档
   - 否则：继续实施

4. **读取上下文文件**

   读取实施指令输出中 `contextFiles` 列出的所有文件路径。
   文件取决于所使用的 schema：
   - **spec-driven**：proposal、specs、design、tasks
   - 其他 schema：按照 CLI 输出的 contextFiles

5. **显示当前进度**

   显示：
   - 正在使用的 schema
   - 进度："已完成 N/M 个任务"
   - 剩余任务概览
   - CLI 的动态指令

6. **实施任务（TDD 循环，直到完成或阻塞）**

   对每个待处理任务，严格按 TDD 顺序执行：

   1. **RED** — 先写失败测试，验证测试确实失败（证明测试有效）
   2. **GREEN** — 写最小实现使测试通过，验证测试通过
   3. **REFACTOR** — 在测试保护下重构，保持测试通过
   4. 在任务文件中标记任务完成：`- [ ]` → `- [x]`
   5. 继续下一个任务

   **TDD 门禁（强制）：**
   - 未写失败测试前，禁止编写任何生产代码
   - RED 阶段测试未失败，禁止跳到 GREEN（测试本身无效）
   - GREEN 阶段测试未通过，禁止跳到 REFACTOR
   - 违反门禁时暂停，向用户报告并等待指导

   **暂停条件：**
   - 任务不明确 → 请求澄清
   - 实施中发现设计问题 → 建议更新 artifact
   - 遇到错误或阻塞 → 报告并等待指导
   - 用户中断

7. **完成或暂停时，显示状态**

   显示：
   - 本次会话完成的任务
   - 整体进度："已完成 N/M 个任务"
   - 如果全部完成：建议归档
   - 如果暂停：说明原因并等待指导

**实施过程中的输出**

```
## 正在实施：<change-name>（schema: <schema-name>）

正在处理任务 3/7：<task description>
[...正在实施...]
✓ 任务完成

正在处理任务 4/7：<task description>
[...正在实施...]
✓ 任务完成
```

**完成时的输出**

```
## 实施完成

**变更：**<change-name>
**Schema：**<schema-name>
**进度：**已完成 7/7 个任务 ✓

### 本次会话完成
- [x] 任务 1
- [x] 任务 2
...

所有任务已完成！可以归档此变更。
```

**暂停时的输出（遇到问题）**

```
## 实施已暂停

**变更：**<change-name>
**Schema：**<schema-name>
**进度：**已完成 4/7 个任务

### 遇到的问题
<问题描述>

**选项：**
1. <选项 1>
2. <选项 2>
3. 其他方案

您希望如何处理？
```

**注意事项**
- 严格遵循 TDD RED→GREEN→REFACTOR 门禁，无例外
- 持续推进任务直到完成或阻塞
- 开始前务必读取上下文文件（来自实施指令输出）
- 如果任务含糊不清，先暂停询问再实施
- 如果实施中发现问题，暂停并建议更新 artifact
- 保持代码更改最小且限定在每个任务范围内
- 完成每个任务后立即更新任务复选框
- 遇到错误、阻塞或需求不明确时暂停 - 不要猜测
- 使用 CLI 输出的 contextFiles，不要假定特定文件名

**灵活工作流集成**

此 skill 支持"对变更执行操作"模型：

- **可随时调用**：在所有 artifact 完成之前（如果任务已存在）、部分实施之后、与其他操作穿插使用
- **允许更新 artifact**：如果实施中发现设计问题，建议更新 artifact - 不受阶段锁定，灵活工作

---

## 后置验证

完成所有任务后，依次使用 **Agent 工具** 调度以下 agent 验证：

1. **Tester**（subagent_type: "Tester"）：
   > 请 Tester 独立验证实施结果：
   > - 运行全部测试并报告实际输出（不要依赖 Developer 的测试报告）
   > - 检查是否有遗漏的边界条件或集成测试
   > - 验证测试覆盖的完整性

2. **Reviewer**（subagent_type: "Reviewer"）：
   > 请 Reviewer 审查已实施的代码变更：
   > - 代码质量和规范合规性
   > - 安全性和性能问题
   > - 与 design.md 的一致性
   > - 是否存在未授权的变更（超出 tasks 范围）

根据验证结果修正问题，然后向用户报告最终状态。
