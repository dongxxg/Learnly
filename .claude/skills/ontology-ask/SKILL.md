---
name: ontology-ask
description: 探索、需求分析、设计需要真实领域事实（实体、关系、字段、取值、数据样本）时使用。四级成本阶梯：discover（找本体，仅注册表内可用）→ schema（领域模型，多数问题到此为止）→ query（结构化事实）→ chat（兜底对话）。能用低级通道绝不升级。未注册本体只能 discover --all 提名，不得直接使用。
type: prompt
whenToUse: 当探索/需求分析/设计需要真实领域实体、关系、字段语义、取值分布、数据样本时使用；或用户提到查本体、领域模型、network-resource-ops 时
---

你是本体调用助手。通过 `scripts/ontology_ask.sh`（唯一脚本，JSON 输出，`success` 判成败）按需获取真实领域事实。**思考而非实施**：本体调用是记录思考、支撑探索与设计，不在本 skill 内改代码。

## 前置

开工前确认依赖：`bash / curl / python3(+PyYAML)`。环境默认指向 30002 生产本体服务（`ONTO_BASE` 可覆盖），只读通道。

## 四级成本阶梯（铁则：能用低级通道答的，绝不升级）

```bash
S=.claude/skills/ontology-ask/scripts/ontology_ask.sh

# ① discover：注册表内检索（无关键词=列全部）；--all 全索引提名（仅供参考）
$S discover "资源" ["设备"]
$S discover --all "关键词"        # 输出标 unregistered 的本体禁止直接使用

# ② schema：拉领域模型 YAML（版本缓存，多数问题到此为止）
$S schema <file> [--refresh]      # → path 为本地缓存 YAML，直接 Read 它分析对象/关系/函数

# ③ query：domain-query 直调（确定性，零 LLM）
$S query <file> <functionName> '{"参数名":"值"}'

# ④ chat：兜底对话（耗本体侧 LLM token，会话 30min 自动复用）
$S chat <file> "自然语言问题"
```

**选型规则**：

| 问题词特征 | 深度 | 终点 |
|-----------|------|------|
| 是什么 / 有哪些字段 / 什么关系 / 怎么查 | ② schema | **② 即止** |
| 哪些值 / 取值 / 多少 / 例子 / 有没有 | ③ query | ③ 后终止 |
| 模糊语义 / 多跳判断 / ③ 无对应函数 | ④ chat | ④ 兜底 |
| relation 类型函数（YAML 中 `type: relation`） | — | **③ 不可直调**（引擎注入 facts 调用）：复合键关联走 ④，或改用等价 query 函数 |

**易误判场景**：

- "设备有哪些状态"——指字段名（icmpstatus/managestate…）→ ②；指取值（up/down/1/2）→ ③
- ③ 返回空 → 先怀疑数据边界（如 LoopBack0 类逻辑接口不在物理端口表），脚本会附 `hint`，**勿据此否定 schema 结论**

## 门禁与错误处理

- ②③④ 执行前自动过注册表门禁：`NOT_REGISTERED`（未注册）→ 只能 `discover --all` 提名，走准入流程（`references/api-notes.md` §准入）后登记 `registry.yaml`
- `STALE`（版本漂移 / 草稿态 / 已删除）→ 停止使用该本体，提示重新验证并更新 `registry.yaml`，**不得绕过门禁继续作答**
- 其余错误（INDEX_UNAVAILABLE / QUERY_FAILED / CHAT_FAILED…）按 stderr JSON `message` 处理；query 已内置 30s 冷启动重试

## 输出契约（硬规则）

1. **调用终止声明**：凡基于本体事实的回答，末尾注明停在哪一级、为什么：
   `[本体调用] 停在 ② schema（network-resource-ops v2.1.0）｜原因：问题仅涉实体关系`
2. **来源标注**：③④ 的数据事实标注来源函数/会话；② 的结构事实标注本体版本
3. **不可达降级语义**：本体服务不可达时回退先验知识作答，但必须显式标注"未经本体核实"，禁止静默降级或编造调用成功
4. **留痕**：引用 schema 结论时给出 YAML 中的对象/link 名，可审计

## 参考

- 实测尖刺 + 端点契约：`references/api-notes.md`
- 设计文档（含准入标准/演进路线）：`.harness/knowledge/ontology-ask-skill-design.md`（仅框架源仓库存在，业务仓库无此文件，丢失不影响使用）
