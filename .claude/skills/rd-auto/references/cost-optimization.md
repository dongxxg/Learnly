# Token 成本优化最佳实践

> rd-auto 在多智能体协作时的 token 经济性权威参考。本文件系统性说明已落地的 4 处优化机制的工作原理、调优参数与维护方式，所有内容基于实际代码（`scripts/lib/context-pack.js` / `templates/dispatch-with-skill.md`）。

## 概述

一个 change 通常 4-8 次 dispatch，每次 prompt 5-15K tokens。token 消耗来自 `context_pack`（acceptance_criteria / git_diff / spec_docs / agent_history / harness_rules 等），随 SPEC 制品增长、git diff 累积、agent_history 延伸线性放大。优化方向：**裁掉无关 source、用结构化模板避免重复 IO、用 shared-state 替代全文 re-Read、在输入侧提前识别高 token change**。

---

## 1. Per-phase 上下文裁剪

### 机制

`context-pack.js:274` 的 `PHASE_CONTEXT_SKIP` 表为每个 phase 声明"跳过的 context source"，被跳过的 source 直接不 exec/read，省 IO 与 token：

```js
// context-pack.js:274
const PHASE_CONTEXT_SKIP = {
  explore:         new Set(['git_diff', 'error_log', 'agent_history']),
  propose:         new Set(['git_diff', 'error_log', 'agent_history']),
  'design-review': new Set(['git_diff', 'error_log']),
  implement:       new Set(['error_log']),
  test:            new Set(['error_log', 'harness_rules']),
  'code-review':   new Set([]),  // needs everything
  debate:          new Set(['git_diff', 'error_log']),
  archive:         new Set(['git_diff', 'error_log', 'spec_docs', 'agent_history']),
};
```

`context-pack.js:287` 的 `PHASE_RULES_ANCHORS` 进一步裁剪 harness_rules 切片锚点（每片 2000 chars）：

```js
// context-pack.js:287
const PHASE_RULES_ANCHORS = {
  explore:         'constraints:',
  propose:         'constraints:',
  'design-review': 'scoring:',
  implement:       'scoring:',
  // test: harness_rules is skipped entirely (see PHASE_CONTEXT_SKIP)
  'code-review':   'scoring:',
  debate:          'scoring:',
  archive:         'shared_state:',
};
```

### 8 phase 各自的语义

- `explore` / `propose` — 探索/提案阶段无需 git_diff（还没动代码），也不需要 error_log/agent_history（前期阶段）
- `implement` — 仅跳 error_log（运行时日志），保留 git_diff 与 agent_history 以理解上下文
- `test` — 跳 harness_rules（不需要打分规则），仅靠 acceptance_criteria 即可
- `code-review` — 啥都不跳，需要完整 context 做评分
- `archive` — 跳 spec_docs/agent_history（已合并到主线），也跳 git_diff

### 维护 checklist（新增 phase 时）

1. 在 `PHASE_CONTEXT_SKIP` 加新条目，列出可跳过的 source
2. 在 `PHASE_RULES_ANCHORS` 加锚点（除非该 phase 完全跳过 harness_rules，如 test）
3. 同步本文表（更新上面两段代码块）
4. 在 `assembleContextPack` 的 phase 参数 JSDoc 注释中追加新值

---

## 2. 模板结构化（XML tag + 注释）

### 机制

`templates/dispatch-with-skill.md` 用 XML tag 把 prompt 切分为结构化段落，每个 tag 配注释说明"来源已就绪、不要重复 Read"：

```md
<!-- templates/dispatch-with-skill.md:15-19 -->
<agent_definition>
你的角色定义（已通过 dispatch-prompt validation.agent_file_content 提供，**禁止再 Read {agent_path}**）：
{validation.agent_file_content}
</agent_definition>
```

```md
<!-- templates/dispatch-with-skill.md:30-38 -->
<project_context>
<!-- 背景信息，不要包含在你的输出里。已按当前 phase 裁剪。 -->
{context_pack.spec_docs.content}
</project_context>

<relevant_rules>
<!-- 当前阶段相关 harness_rules 切片。约束，不要包含在你的输出里。 -->
{context_pack.harness_rules.content}
</relevant_rules>
```

`<rules>` 段强制条款第 5 条进一步兜底：

```
5. **禁止**重复 Read {agent_path}，角色定义已在 <agent_definition> 提供
```

### 效果

- 4 个 XML tag（task / agent_definition / project_context / relevant_rules）让 sub-agent 一眼定位所需信息，不再 grep prompt
- 注释明确"已就绪"，避免 sub-agent 重新 Read agent_path（典型省 1-3K tokens）
- 占位符 `{context_pack.xxx.content}` 由主会话在组装 prompt 时按 phase 裁剪后填充，sub-agent 端不需要再判断"哪些 source 该读"

### 维护 checklist（修改模板时）

1. 占位符必须与 `orchestrator.js dispatch-prompt` output 字段名对齐
2. 新增 source 占位符时，同步在 `assembleContextPack` 中输出该字段，并决定它是否进 `PHASE_CONTEXT_SKIP`
3. XML tag 名应语义化（避免 `<x>` / `<data>` 等无意义标签）
4. 注释保持简洁，仅说明"来源/裁剪状态/是否包含在输出"

---

## 3. Shared-State 跨角色共享

### 机制

`.harness/shared-state/<change>/` 提供三份结构化 JSON/YAML，跨角色用 `node $SCRIPT read-shared-state` 增量读取，替代"全文 re-Read 制品"模式：

| 文件 | 写入者 | 读取者 | 替代行为 |
|------|--------|--------|---------|
| `concerns.json` | Reviewer | Developer（rework） | 替代"re-Read design.md + 解析问题列表" |
| `interface-changes.yaml` | Architect | Developer | 替代"re-Read design.md 全文找接口" |
| `task-status.json` | Developer | Reviewer | 替代"re-Read 所有任务文件确认完成度" |

### 经济性

- `concerns.json` 平均 200-500 chars vs 完整 design.md 5-10K chars → rework dispatch 省 90%+ context
- 读取命令支持 `--key` / `--status` 过滤（如 `--status open` 仅取未关闭 concerns），进一步减少返回体积
- P0 Veto 机制（见 `shared-state.md:48`）依赖 concerns.json 而非 re-Read 全文 review 报告

### 维护 checklist（扩展 shared-state 时）

1. 新文件必须支持 `read-shared-state --key <file>` 读取
2. 在 `shared-state.md` 文档表格追加新文件说明（写入者 / 读取者 / 用途）
3. 写入时机必须在 dispatch 边界（不能 dispatch 中途写，避免读到半成品）
4. 结构化字段（id / severity / status）必须稳定，避免下游解析失败

---

## 4. 高 token change 识别

### 机制

`context-pack.js:61-94` 的 `recommendMode()` 用 OR-based 阈值判断是否触发 team mode（team mode 会 fanout 多角色，token 翻倍）：

```js
// context-pack.js:79-87
if (complexityScore >= 70) {
  reasons.push('complexity_score >= 70');
}
if (affectedFiles.length >= 5) {
  reasons.push('affected_files >= 5');
}
if (modules.length >= 3) {
  reasons.push('modules >= 3');
}

if (reasons.length > 0) {
  return { recommended: 'team', reasons, blocked: false };
}
```

任一条件满足即触发 team mode：complexity_score >= 70 / affected_files >= 5 / modules >= 3。另有 `MODE_BLOCKLIST`（如某些 flow_type）强制 legacy。

### PM 输入侧如何识别

PM 描述 change 时，以下特征会推上 team mode：

- 显式列举 5+ 个文件路径 → affected_files >= 5
- 跨 3+ 个模块（如"同时改 fusion / ingestion / api"）→ modules >= 3
- 复杂度描述含多分支逻辑、并行编排、外部系统集成 → complexity_score 易上 70

### PM 输入侧如何避免误触

- 拆分大 change 为多个小 change（每个 affected_files < 5），分批 propose/apply
- 模块名归并（同一领域多文件归 1 个 module 名）
- 复杂度评估时聚焦核心 acceptance_criteria，避免堆叠边缘场景

### 维护 checklist（阈值变更时）

1. 修改 `context-pack.js:79-87` 任一阈值时，同步本文表
2. 新增 BLOCKLIST 条目（`MODE_BLOCKLIST`）时，在本文补充说明
3. team mode fanout 内部细节不在本文范围（由 `agent-teams-fanout` change 负责）

---

## 引用代码索引

| 锚点 | 含义 |
|------|------|
| `context-pack.js:61-94` | `recommendMode()` 阈值逻辑 |
| `context-pack.js:274` | `PHASE_CONTEXT_SKIP` 全表 |
| `context-pack.js:287` | `PHASE_RULES_ANCHORS` 全表 |
| `context-pack.js:316` | `assembleContextPack` 中应用 skip 的代码行 |
| `templates/dispatch-with-skill.md:15-19` | `<agent_definition>` + 禁止重复 Read 注释 |
| `templates/dispatch-with-skill.md:30-38` | `<project_context>` / `<relevant_rules>` + 裁剪注释 |
| `.harness/shared-state/<change>/` | 三文件共享状态目录 |
