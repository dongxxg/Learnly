---
name: rd:archive
description: 归档已完成的变更。用于在实施完成后归档和同步规格。
license: MIT
compatibility: 需要 rd CLI。
metadata:
  author: rd
  version: "1.0"
  generatedBy: "1.7.4"
---

归档已完成的变更。所有提示消息使用中文。

**输入**：可选择指定变更名称。如果未提供，检查是否可以从对话上下文中推断。如果模糊或有歧义，必须提示用户从可用变更中选择。

---

**步骤**

1. **如果未提供变更名称，提示选择**

   运行 `rd list --json` 获取可用变更。使用 **AskUserQuestion 工具** 让用户选择。

   仅显示活跃变更（不包括已归档的）。
   如果可用，包含每个变更使用的 schema。

   **重要提示**：不要猜测或自动选择变更。始终让用户选择。

2. **检查制品完成状态**

   运行 `rd status --change "<name>" --json` 检查制品完成情况。

   解析 JSON 以了解：
   - `schemaName`：正在使用的工作流
   - `artifacts`：制品列表及其状态（`done` 或其他）

   **如果有任何制品未完成（不是 `done`）：**
   - 显示警告，列出未完成的制品
   - 使用 **AskUserQuestion 工具** 确认用户是否要继续
   - 如果用户确认则继续

3. **检查任务完成状态**

   读取任务文件（通常是 `tasks.md`）以检查未完成的任务。

   统计标记为 `- [ ]`（未完成）和 `- [x]`（已完成）的任务数量。

   **如果发现未完成的任务：**
   - 显示警告，展示未完成任务的计数
   - 使用 **AskUserQuestion 工具** 确认用户是否要继续
   - 如果用户确认则继续

   **如果不存在任务文件**：无需任务相关警告，直接继续。

4. **评估增量规格同步状态**

   检查 `.harness/spec/changes/<name>/specs/` 处的增量规格。如果不存在，直接继续，无需同步提示。

   **如果存在增量规格：**
   - 将每个增量规格与 `.harness/spec/specs/<capability>/spec.md` 处对应的主规格进行比较
   - 确定将应用的变更（新增、修改、删除、重命名）
   - 在提示前显示合并摘要

   **提示选项：**
   - 如果需要变更："立即同步（推荐）"、"不同步直接归档"
   - 如果已同步："立即归档"、"仍然同步"、"取消"

   如果用户选择同步，使用 Task 工具（subagent_type: "general-purpose", prompt: "使用 Skill 工具调用 rd-sync-specs 来处理变更 '<name>'。增量规格分析：<包含分析的增量规格摘要>"）。无论选择如何，都继续归档。

5. **执行归档**

   合规归档目录为 `.harness/spec/archive/`（与 `specs/`、`changes/` 平级，遵循 `.harness/directory-spec.md`）。

   如果合规归档目录不存在则创建：
   ```bash
   mkdir -p .harness/spec/archive
   ```

   使用当前日期生成目标名称：`YYYY-MM-DD-<change-name>`

   **检查目标是否已存在：**
   - 如果是：报错，建议重命名现有归档或使用不同日期
   - 如果否：将变更目录移动到合规归档目录

   ```bash
   mv .harness/spec/changes/<name> .harness/spec/archive/YYYY-MM-DD-<name>
   ```

6. **显示摘要**

   显示归档完成摘要，包括：
   - 变更名称
   - 使用的 schema
   - 归档位置
   - 规格是否已同步（如适用）
   - 关于任何警告的说明（未完成的制品/任务）

**成功时的输出**

```
## 归档完成

**变更：** <change-name>
**Schema：** <schema-name>
**归档至：** .harness/spec/archive/YYYY-MM-DD-<name>/
**规格：** ✓ 已同步到主规格（或 "无增量规格" 或 "同步已跳过"）

所有制品已完成。所有任务已完成。
```

**注意事项**
- 如果未提供变更名称，始终提示选择
- 使用 artifact graph（rd status --json）检查完成状态
- 不要因警告阻止归档 - 仅通知并确认
- 移动到归档时保留变更元数据文件（随目录一起移动）
- 显示清晰的操作摘要
- 如果请求同步，使用 rd-sync-specs 方式（代理驱动）
- 如果存在增量规格，始终运行同步评估并在提示前显示合并摘要
