---
name: rd:propose
description: 创建新变更并一步生成所有制品。用于快速描述需求并生成完整的提案、设计、规格和任务。
license: MIT
compatibility: 需要 rd CLI。
metadata:
  author: rd
  version: "1.0"
  generatedBy: "1.7.4"
---

创建新变更并生成所有制品。所有提示消息使用中文。

我将创建一个变更，包含以下制品：
- proposal.md（做什么 & 为什么）
- specs/（需求规格，每能力一个 .md 文件）
- design.md（怎么做）
- tasks.md（实施步骤）

准备实施时，运行 /rd:apply

---

## 前置协作

在创建制品前，使用 **Agent 工具**（subagent_type: "Architect"）发起协作：

> 请 Architect 审视用户的需求描述，提供以下视角：
> - 需求与现有架构的一致性和潜在冲突
> - 推荐的技术方案和设计模式
> - 需要关注的关键架构决策点
>
> 将 Architect 的输出作为制品创作的架构指导。

---

**输入**：用户的请求应包含变更名称（kebab-case 格式）或对要构建内容的描述。

**步骤**

1. **如果没有明确输入，询问用户要构建什么**

   使用 **AskUserQuestion 工具**（开放式，不提供预设选项）来询问：
   > "你想做什么变更？请描述你想构建或修复的内容。"

   根据用户的描述，推导出 kebab-case 格式的名称（例如，"添加用户认证" → `add-user-auth`）。

   **重要**：在理解用户想要构建什么之前，不要继续执行。

2. **创建变更目录**
   ```bash
   rd new change "<name>"
   ```
   这会在 `.harness/spec/changes/<name>/` 下创建变更脚手架（含元数据文件）。

3. **获取 artifact 构建顺序**
   ```bash
   rd status --change "<name>" --json
   ```
   解析 JSON 获取：
   - `applyRequires`：实施前所需的 artifact ID 数组（例如，`["tasks"]`）
   - `artifacts`：所有 artifact 的列表，包含其状态和依赖关系

4. **按顺序创建 artifact，直到可以实施**

   使用 **TodoWrite 工具** 来跟踪 artifact 进度。

   按依赖顺序遍历 artifact（没有待处理依赖的 artifact 优先）：

   a. **对于每个状态为 `ready` 的 artifact（依赖已满足）**：
      - 获取指令：
        ```bash
        rd instructions <artifact-id> --change "<name>" --json
        ```
      - 指令 JSON 包含：
        - `context`：项目背景（对你的约束 - 不要写入输出文件）
        - `rules`：artifact 特定规则（对你的约束 - 不要写入输出文件）
        - `template`：输出文件使用的结构模板
        - `instruction`：此 artifact 类型的 schema 特定指导
        - `outputPath`：artifact 的写入路径
        - `dependencies`：已完成的需要读取的依赖 artifact
      - 读取已完成的依赖文件以获取上下文
      - 使用 `template` 作为结构创建 artifact 文件
      - 将 `context` 和 `rules` 作为约束应用 - 但不要将它们复制到文件中
      - 显示简要进度："已创建 <artifact-id>"

   b. **继续直到所有 `applyRequires` artifact 完成**
      - 创建每个 artifact 后，重新运行 `rd status --change "<name>" --json`
      - 检查 `applyRequires` 中的每个 artifact ID 是否在 artifacts 数组中 `status: "done"`
      - 当所有 `applyRequires` artifact 都完成时停止

   c. **如果 artifact 需要用户输入**（上下文不明确）：
      - 使用 **AskUserQuestion 工具** 澄清
      - 然后继续创建

5. **显示最终状态**
   ```bash
   rd status --change "<name>"
   ```

**输出**

完成所有 artifact 后，总结：
- 变更名称和位置
- 已创建的 artifact 列表及简要描述
- 就绪状态："所有 artifact 已创建！可以开始实施。"
- 提示："运行 `/rd:apply` 或让我开始实施任务。"

**Artifact 创建指南**

- 遵循 `rd instructions` 中每种 artifact 类型的 `instruction` 字段
- schema 定义了每个 artifact 应包含的内容 - 遵循它
- 创建新 artifact 前先读取依赖 artifact 获取上下文
- 使用 `template` 作为输出文件的结构 - 填充其章节
- **重要**：`context` 和 `rules` 是对你的约束，不是文件的内容
  - 不要将 `<context>`、`<rules>`、`<project_context>` 块复制到 artifact 中
  - 这些指导你写什么，但不应出现在输出中

**边界约束**
- 创建实施所需的全部 artifact（由 schema 的 `apply.requires` 定义）
- 创建新 artifact 前务必读取依赖 artifact
- 如果上下文严重不明确，询问用户 - 但优先做出合理判断以保持推进
- 如果同名变更已存在，询问用户是继续该变更还是创建新变更
- 写入每个 artifact 文件后验证其存在，再继续下一步

---

---
