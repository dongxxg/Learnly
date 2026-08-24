## Context

项目处于脚手架阶段（零业务代码），识字模块是首个落地业务模块。技术栈：后端 Node.js + PostgreSQL，前端 Vue3 + Pinia，目标运行于 H5 + 微信小程序双端。需要端到端验证 handler-service-repository 分层架构、JWT 鉴权链路、数据库迁移流程。

## Goals / Non-Goals

**Goals:**
- 实现 4 个能力：character-list / character-detail / progress-tracking / user-auth
- 建立可复用的分层架构模板（handler → service → repository → model）
- 内置几百常用字 seed 数据，启动自动加载
- 单测覆盖率 ≥80%（核心 service 与 handler）

**Non-Goals:**
- 不做真实笔顺动画（仅占位组件，后续独立 change 实现）
- 不做复杂推荐算法（进度仅记录，不驱动推荐）
- 不做第三方登录（仅手机号+密码注册登录）
- 不做管理后台（seed 数据即固定字库）

## Decisions

### D1: 用户体系作为内部子包

**选择**：`packages/auth/` 内部子包，不引入外部身份服务

**替代方案：**
- A) Auth0 / Firebase Auth — 引入外部依赖，增加网络开销与合规成本，不适合儿童类产品的数据本地化要求
- B) 独立微服务 — 项目初期用户量小，微服务增加部署复杂度，ROI 不合理

**理由**：项目初期用户规模可控，内部子包足够支撑 JWT 签发/验证/刷新，数据完全自主可控，符合儿童隐私合规方向。

### D2: PostgreSQL 作为主存储

**选择**：PostgreSQL 存储进度与用户数据

**替代方案：**
- A) MongoDB — 文档型适合 schema 多变场景，但进度数据关系明确（parent-child-profile-character 4表关联），关系型更合适
- B) SQLite — 零配置但并发弱，不适合未来多实例部署

**理由**：进度数据是典型关系型结构（用户-儿童-汉字-进度），PG 支持事务与 JSONB（汉字扩展属性），兼顾结构化与灵活性。

### D3: JSON 文件 + 启动加载 seed

**选择**：`seeds/characters.json` + 启动时幂等加载

**替代方案：**
- A) SQL 迁移文件 — 几百条 INSERT 语句可读性差，维护成本高
- B) 运行时 API 导入 — 需要额外管理接口，增加攻击面

**理由**：JSON 可读性好，启动加载幂等（MERGE by character code），失败阻塞启动可立即感知。

### D4: 前端 Pinia 按 child 重置缓存

**选择**：切换 child profile 时重置相关 store

**替代方案：**
- A) 全局单一 store — 切换 child 时残留上一 child 数据，易出 bug
- B) URL query 参数持久化 — 刷新后丢失当前 child 上下文

**理由**：按 child 隔离 store 状态，切换时显式 reset，语义清晰；当前 childId 存 localStorage 保持刷新后恢复。

### D5: RESTful API 设计

**选择**：标准 RESTful 资源命名 + HTTP 动词

**替代方案：**
- A) GraphQL — 灵活但增加复杂度，识字模块数据关系简单，REST 足够
- B) RPC 风格 — 不符合团队已有约定，可读性差

**理由**：资源（characters / profiles / progress）天然映射 REST，团队约定一致，调试方便。

### D6: handler-service-repository 分层

**选择**：Controller(HTTP) → Service(业务) → Repository(数据) → Model(ORM)

**替代方案：**
- A) Active Record 模式 — 模型耦合数据访问，单测困难
- B) 单层 handler 直连 DB — 业务逻辑与 HTTP 耦合，不可复用

**理由**：分层后 service 可单测（mock repository），handler 仅做参数校验与响应封装，职责清晰。

## Risks / Trade-offs

- [seed 数据质量] → 需人工审核几百常用字表，确保拼音/释义准确 → 采用公开权威字表（如小学语文一级字表）
- [JWT 密钥管理] → 硬编码密钥泄露风险 → 通过环境变量注入，启动校验存在性
- [双端样式差异] → H5 与小程序样式不一致 → 使用条件编译 + 公共样式 token
- [进度并发写] → 同一汉字快速重复学习导致重复记录 → 唯一约束 (child_id, character_id) + upsert
