## Context

后端已实现（Go/Gin/GORM，原文档写 Node.js 与实现不符，以代码为准）：`Parent`/`ChildProfile`/`Character`/`Progress` 四实体、JWT 鉴权、270 字 seed（char/pinyin/strokes/level/definition，level 分布 1:225 / 2:43 / 3:2）、进度状态机（unlearned→learning→learned 单向不可逆，重复 complete 仅刷新 last_study_at）。前端 uni-app（Vue3 + TS + Vite + Pinia + sass，无 UI 库）仅首页骨架：`pages.json` 只注册 index 页，"知芽识字"卡片仅 toast 占位。目标三端：H5 / app-plus / 微信小程序。

本次扩展把"听音、看笔顺、动手写"补齐为完整产品体验，并完成 app 云打包配置。架构边界（ADR-0001）：业务数据归 backend，AI 能力归 ai-service，frontend 只与 backend 通信。

## Goals / Non-Goals

**Goals:**
- 实现 4 个能力：character-list / character-detail / progress-tracking / user-auth / stroke-writing
- 汉字列表按简单到复杂显式排序（level → strokes → id）
- 详情页真实笔顺演示（Hanzi Writer animation 模式）+ 读音播放（预生成 mp3）
- 田字格触屏书写：严格按笔顺逐笔判定，quiz 通过自动上报 complete
- app 端（app-plus）云打包备料：manifest 配置 + 打包操作文档
- 单测覆盖率 ≥80%（核心 service 与 handler）

**Non-Goals:**
- 不做 AI 手写评分/笔迹美化（仅标准笔顺与方向的硬判定）
- 不做云端笔迹存储与回放（笔迹仅存于画板会话内）
- 不做复杂推荐算法（进度仅记录，不驱动推荐）
- 不做第三方登录（仅手机号+密码注册登录）
- 不做管理后台（seed 数据即固定字库）
- 不做安卓/iOS 离线打包（云打包即可，本地工程环境不在范围）

## Decisions

### D1: 用户体系作为内部子包

**选择**：后端 `internal/auth` 包内实现 JWT 签发/验证，不引入外部身份服务

**替代方案：**
- A) Auth0 / Firebase Auth — 引入外部依赖，增加网络开销与合规成本，不适合儿童类产品的数据本地化要求
- B) 独立微服务 — 项目初期用户量小，微服务增加部署复杂度，ROI 不合理

**理由**：项目初期用户规模可控，内部子包足够支撑 JWT 签发/验证，数据完全自主可控，符合儿童隐私合规方向。（已实现）

### D2: PostgreSQL 作为主存储

**选择**：PostgreSQL 存储进度与用户数据

**替代方案：**
- A) MongoDB — 文档型适合 schema 多变场景，但进度数据关系明确（parent-child-profile-character 4 表关联），关系型更合适
- B) SQLite — 零配置但并发弱，不适合未来多实例部署

**理由**：进度数据是典型关系型结构，PG 支持事务与 JSONB（汉字扩展属性），兼顾结构化与灵活性。（已实现）

### D3: JSON 文件 + 启动加载 seed

**选择**：`seeds/characters.json` + 启动时幂等加载

**替代方案：**
- A) SQL 迁移文件 — 几百条 INSERT 语句可读性差，维护成本高
- B) 运行时 API 导入 — 需要额外管理接口，增加攻击面

**理由**：JSON 可读性好，启动加载幂等（MERGE by char），失败阻塞启动可立即感知。（已实现，270 字）

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

**理由**：资源（characters / profiles / progress）天然映射 REST，团队约定一致，调试方便。（已实现）

### D6: handler-service-repository 分层

**选择**：Handler(HTTP) → Service(业务) → Repository(数据) → Model(ORM)

**替代方案：**
- A) Active Record 模式 — 模型耦合数据访问，单测困难
- B) 单层 handler 直连 DB — 业务逻辑与 HTTP 耦合，不可复用

**理由**：分层后 service 可单测（mock repository），handler 仅做参数校验与响应封装，职责清晰。（已实现）

### D7: 笔顺数据与渲染引擎 = Hanzi Writer + hanzi-writer-data

**选择**：引入 MIT 开源的 Hanzi Writer（渲染/动画/quiz 引擎）+ hanzi-writer-data（~9500 字笔顺数据，每字 JSON 含笔画 SVG 路径与中线点序）；270 字数据在**构建期打包**进前端（vite glob import），不做运行时 fetch

**替代方案：**
- A) 第三方笔顺 API — 稳定性差、有配额、商用授权风险，且都不带书写判定能力
- B) 预生成 SVG 动画文件自托管 — 只能"看"不能"写"，逐笔判定算法仍需自研
- C) 自建笔顺数据 — 270 字 × 平均 8 笔的 SVG 路径，成本不可行

**理由**：一个库同时满足"笔顺演示"与"书写判定"两个需求（quiz 模式内置逐笔顺序/方向校验、田字格/米字格背景、提示轨迹）；数据按字懒加载体积小；构建期打包规避 app webview 运行时 fetch 本地静态文件的路径不确定性，三端行为一致。

### D8: app 端渲染桥接 = renderjs 封装组件

**选择**：`<hanzi-writer-board>` 组件以 renderjs 实现——视图层脚本直接驱动 HanziWriter 实例，逻辑层经 props（char/mode/容差/提示阈值）与事件（quiz 结果）通信

**替代方案：**
- A) nvue + canvas 自研 — 需重写笔顺匹配（起笔位置/方向/顺序）算法，成本高
- B) 逻辑层直操作 DOM/SVG — app-vue 逻辑层与视图层分离，碰不到 DOM，直接白屏
- C) 仅 H5 支持书写 — 砍掉核心需求（app 端触屏书写是本次目标）

**理由**：uni-app app-vue 的逻辑层无法操作 DOM/SVG，renderjs 运行在视图层是官方桥接方案；同一组件在 H5 / app-vue / mp-weixin 三端编译兼容，小程序端顺带解决。

### D9: 读音 = 预生成 mp3 内嵌静态资源

**选择**：一次性脚本批量生成 270 字读音 mp3（TTS 源实施期选定），放 `frontend/src/static/audio/` 构建期内嵌；详情页 `<audio>`/`uni.createInnerAudioContext` 播放

**替代方案：**
- A) 设备端 TTS — 三端行为不一（mp-weixin 无内置 TTS，H5 WebSpeech 中文音质参差，app 端依赖原生模块）
- B) ai-service 实时 TTS 代理 — 完全静态的资源走每次点击的网络往返，延迟伤儿童点按体验，且违反"静态资源不值得服务化"的性价比
- C) 拼音文本展示代替 — 目标用户是学龄前儿童，不认识拼音，等于没做

**理由**：270 个字一次性生成成本近乎零，换来运行时零依赖、零延迟、三端一致。

### D10: 列表排序 = level asc, strokes asc, id asc + N+1 修复

**选择**：repository 排序键 `level asc, strokes asc, id asc`；列表页进度状态从逐字查询改为单次 IN 批量查询

**替代方案：**
- A) 纯 strokes 排序 — 丢掉字表 level 分级语义
- B) 维持现状 id asc — 依赖 seed 录入顺序的巧合（恰好从简到繁），扩字库即破坏
- C) 前端拉全量自行排序 — 全量 270 字拉取浪费，分页语义在服务端就该定好

**理由**：level 是产品分级（课次），strokes 在层内细化复杂度，id 兜底保证排序全键唯一、跨页稳定；N+1（character_handler 对当前页每字一次 GetStatusByCharacter）合并为一次 IN 查询即可，pageSize≤100 无内存顾虑。

### D11: 书写 → 进度绑定 = 复用现有契约自动上报

**选择**：进入"未学"字详情自动 `POST /progress {action: start}`；quiz 全部通过自动上报 `action: complete`；不新增接口

**替代方案：**
- A) 手动"我学会了"按钮 — 儿童操作负担重，且与"写会"事实脱节、数据失真
- B) 服务端校验笔迹后再落进度 — 笔顺判定逻辑需在服务端重写一遍；儿童 app 无作弊动机，ROI 不成立

**理由**：现有状态机天然幂等（重复 complete 仅刷新 last_study_at，已实现），后端零改动；"写对即学会"与单向状态机语义完全对齐。

### D12: app 交付 = HBuilderX 云打包，人机分工备料

**选择**：云打包。AI 侧交付：manifest.json app-plus 段完整配置（名称/图标/启动图/权限/modules）、打包操作文档；用户侧执行：注册 DCloud 获取 appid、生成安卓 keystore、iOS 证书、在 HBuilderX 触发云打包

**替代方案：**
- A) 离线打包 — 需本地 Android/iOS 工程环境，首次交付成本高
- B) 仅 H5 交付 — 不满足"app 端触屏书写"的验收形态

**理由**：云打包零本地环境依赖、流程成熟；appid 与证书是账号敏感资产，必须由用户本人持有与操作，任务按此拆人机边界。

## Risks / Trade-offs

- [包体积 +~7MB（笔顺 JSON ≈2-3MB + 音频 ≈4MB）] → 当前 270 字可接受；将来扩字库时切换为远端懒加载
- [hanzi-writer-data 对 seed 270 字的覆盖缺口] → 构建期校验脚本逐一核对并输出缺字清单；缺字按 spec 降级（隐藏笔顺/书写入口）
- [renderjs 调试成本（视图层无常规断点）] → 组件内聚收敛问题域；console + 真机日志排查
- [云打包依赖用户操作（appid/证书）] → 打包文档显式标注人机分工步骤，避免任务卡在 AI 侧
- [读音 TTS 源可用性（免费 edge-tts vs 云厂商付费）] → 实施期做一次 270 字小样生成验证音质与连通性再定
- [seed 数据质量] → 采用公开权威字表，拼音/释义人工抽查
- [JWT 密钥管理] → 环境变量注入，启动校验存在性
- [进度并发写] → 唯一约束 (child_id, character_id) + upsert（已实现）

## Migration Plan

- 后端：无 schema 迁移。排序与 N+1 是查询层改动，出问题直接还原查询即可；`OrderData` 占位字段停止写入但保留列，避免迁移
- 前端：新增页面/组件/静态资源，独立可回滚；静态资源构建期内嵌，发版后不可撤——上线前核对包体积与资源完整性
- 打包：manifest 配置合入后，用户首次云打包出包即验收；证书问题不影响代码合入

## Open Questions

- 读音 TTS 生成源：edge-tts（免费）vs 云厂商（音色好、收费）——任务 13.3 实施时以 270 字小样试听后定
- iOS 证书类型（开发/分发）——用户云打包时确定，只影响文档措辞不影响代码
