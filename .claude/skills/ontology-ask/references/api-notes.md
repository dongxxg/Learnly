# api-notes — 本体服务端点契约与实测尖刺

> 源：2026-09-07/08 实测（30002 生产环境）+ ontology-gen-validator 验证记录。端点无公开契约，行为以本文件为准，变更时先实测再改脚本。

## 环境与认证

- 地址：`http://192.168.201.129:30002/agent-onto-harness`（env `ONTO_BASE`）
- 认证头：`x-sys-code: DEP001`（租户）+ `currentnetuserid: <邮箱>`（无 token）

## 端点契约

| # | 端点 | 方法 | 说明 |
|---|------|------|------|
| ① | `/api/ontologies` | GET | 全量本体元数据索引：`file/situation/domain/anchor/version/object_types/properties/links/draft` |
| ② | `/api/ontologies/{file}/yaml` | GET | `{"content":"<YAML 全文>"}`；**键是 ① 的 `file` 字段**（带 `.yml`） |
| ③ | `/api/ontology/domain-query` | POST | body `{ontologyId, queryName, parameters}`（引擎只认 parameters，写 params 会被静默忽略按空参数执行）；`ontologyId` == situation（无 `.yml`）；响应 `{"data":{"result":[...]}}` |
| ④ | `/api/agent/sessions` → `/api/agent/sessions/{sid}/chat` | POST | 建会话 body `{"dslFile":"<file>"}` → `{"sessionId"}`；对话 body `{"message"}` → `{"answer","thinking"}` |

## 实测尖刺（实现已内化，改动前重读）

1. **② 依赖 ①**：yaml 端点认 `file`（`network-resource-ops.yml`），传 situation 名报 404 "文件不存在"
2. **③ 冷启动**：首调可 >15s 无响应，重试 ~2s → 脚本 30s 超时 + 1 次重试
3. **③ 空结果 ≠ 建模错误**：`LoopBack0` 等逻辑接口不在物理端口表，属数据边界
4. **① 索引含测试垃圾**（`111.yml` 等）：可用范围收敛到 `registry.yaml`；脚本对非 2xx 输出结构化错误
5. **沙箱（27090）与生产（30002）是不同服务**：本 skill 只对接生产已发布本体，只读
6. **② 发布态未验证**：GET yaml 可能返回最新存储版（含草稿可能）；发布判定以 ① 列表 `draft:false` 为准（门禁已覆盖）
7. **① 索引 version 字段可能滞后**（2026-09-08 实例：索引 2.0.0 / 记录 v2.1 已发布）→ stale 判定以索引为准并人工复核，门禁拦截时先 `schema` 下载核对 YAML `metadata.version`

## 引擎侧经验（写函数/读 schema 时相关）

- 全部函数脚本合并编译为单个 `DomainModel.groovy`：局部变量撞生成器保留名（`code`/`ip`）→ 整个本体领域类编译失败（全部 groovy/domain-query 500）；用非常见名（`codeVal`/`ipVal`）
- 字典列排序规则区分大小写（`MCN.ALEAF` ≠ `MCN.Aleaf`），等值查询需精确大小写
- link 遍历是实例方法（`obj.getRelationXxx()`），不能静态调用

## 准入流程（unregistered → active）

1. `draft:false`（已发布）
2. 沙箱或目标环境 validate 0 错误（工具：ontology-gen-validator 沙箱流程）
3. domain-query 抽测真实数据（≥3 个函数）
4. 推荐：L2 chat 回归（LLM 路由正确性）
5. 登记 `registry.yaml`：`file/situation/domain/version/state/keywords/verified_at/verified_by/evidence` 四要素
   ⚠️ `verified_at` 必须带引号——裸日期被 YAML 解析为 date 对象，无法 JSON 序列化
8. **④ 偶发 504 与会话过期**：chat 网关间歇性 504（5xx 自动重试 1 次）；会话服务端会过期/回收（chat 404）→ 脚本自动弃缓存重建会话重试 1 次；仍失败时信息保留 sessionId 可手动重试
9. **索引 version 滞后毒化缓存**：schema 下载后回验 YAML `metadata.version` 与索引 version，不一致 → `VERSION_MISMATCH` 并删缓存（脚本已内化，勿绕过）
10. **平台限制**：脚本面向 Linux/WSL（Git Bash 未验证——python3 命令名、mktemp 路径可能差异）；P1 分发时若需 Windows 支持先实测
11. **relation 函数不可 domain-query 直调**（引擎 HTTP 404）：由 link 解析注入 facts 调用；脚本对 404 查 schema 缓存细分报错（relation 专属提示 / 列出可用函数）
