## 1. 数据层 — 模型与迁移（已实现）

- [x] 1.1 定义 GORM 模型：`Parent`（id, phone, password_hash, created_at）、`ChildProfile`（id, parent_id FK, name, avatar, created_at）、`Character`（id, char, pinyin, strokes, level, definition, order_data, created_at）、`Progress`（id, child_id FK, character_id FK, status, last_study_at, completed_at, created_at; UNIQUE(child_id, character_id)）
- [x] 1.2 实现自动迁移（AutoMigrate）：启动时按顺序创建 4 张表，失败阻塞启动并打印错误
- [x] 1.3 在 `model` 包暴露 `AllModels()` 返回模型切片，供迁移统一调用

## 2. Seed 数据 — 常用字库（已实现，270 字）

- [x] 2.1 创建 `seeds/characters.json`：包含 ≥200 个小学语文一级常用字（char/pinyin/strokes/level/definition）
- [x] 2.2 实现 seed 加载器：启动时读取 JSON，按 char 唯一键 MERGE（已存在则跳过，不存在则插入）
- [x] 2.3 种子加载失败阻塞启动并打印明确错误；加载成功后打印实际插入/跳过计数

## 3. Repository 层（已实现）

- [x] 3.1 `parent_repository`：FindByPhone、Create
- [x] 3.2 `child_profile_repository`：FindByParentID、FindByIDAndParent、Create
- [x] 3.3 `character_repository`：FindByID、List（支持 page/pageSize/level 筛选，返回 total+items）
- [x] 3.4 `progress_repository`：FindByChildAndCharacter、Upsert（按 UNIQUE 约束原子更新 status）、GetStatsByChild（返回 learned/learning/unlearned/total）

## 4. Service 层（已实现）

- [x] 4.1 `auth_service`：Register（手机号唯一性校验 + bcrypt 哈希 + JWT 签发）、Login（密码验证 + JWT 签发）
- [x] 4.2 `child_service`：CreateProfile、SwitchProfile（校验 childId 归属当前 parent）
- [x] 4.3 `character_service`：GetByID、List（参数校验 + 调用 repository）
- [x] 4.4 `progress_service`：RecordStudy（状态机：未学→在学→已学，单向不可逆，重复完成仅更新 last_study_at）、GetStats、GetStatusByCharacter
- [x] 4.5 所有 service 接口定义清晰，repository 通过接口注入（便于单测 mock）

## 5. Handler 层 + 路由（已实现）

- [x] 5.1 `auth_handler`：POST `/api/v1/auth/register`、POST `/api/v1/auth/login`
- [x] 5.2 `child_handler`：POST `/api/v1/profiles`、POST `/api/v1/profiles/switch`（需 JWT）
- [x] 5.3 `character_handler`：GET `/api/v1/characters`（分页/筛选，需 JWT）、GET `/api/v1/characters/:id`（详情+进度，需 JWT）
- [x] 5.4 `progress_handler`：POST `/api/v1/progress`（学习行为上报，需 JWT）、GET `/api/v1/progress/stats`（统计，需 JWT）
- [x] 5.5 在 `router.go` 注册所有 literacy 路由，受保护路由挂 JWT 中间件

## 6. JWT 鉴权（已实现）

- [x] 6.1 `auth` 包：GenerateToken（含 parent_id、child_id 声明）、VerifyToken（解析 + 过期校验）
- [x] 6.2 JWT 中间件：从 Authorization Header 提取 token，校验后注入 `parentId`/`childId` 到 gin context；过期返回 401 + `TOKEN_EXPIRED`
- [x] 6.3 JWT secret 经 `auth.Init(cfg.JWT.Secret)` 启动注入（配置键 jwt.secret / 环境变量 JWT_SECRET），空密钥 fail-fast 拒绝启动

## 7. 单元测试（覆盖率 ≥80%）

- [x] 7.1 service 层单测：auth（注册/登录/密码错误）、progress（状态机所有分支/非法回退）、character（列表/详情/不存在）
- [x] 7.2 handler 层单测：HTTP 状态码校验、参数校验、JWT 鉴权成功/失败/过期场景
- [x] 7.3 repository 使用 sqlite 内存库或 sqlmock 测试查询正确性
- [x] 7.4 运行 `go test ./... -cover` 确认覆盖率 ≥80%

## 8. 前端 — 识字模块页面

- [x] 8.1 汉字列表页 `pages/literacy/list`：分页加载、按难度筛选、进度状态标识、下拉刷新/上拉加载、注册进 pages.json、首页卡片接通跳转
- [x] 8.2 汉字详情页 `pages/literacy/detail`：拼音/释义/笔画数展示、笔顺演示区、书写练习区、进度状态联动（详见任务组 15）
- [x] 8.3 学习统计入口：展示 learned/learning/unlearned/total

## 9. 前端 — 状态管理与 API

- [x] 9.1 `api/literacy.ts`：封装所有 literacy 接口（带 JWT header）
- [x] 9.2 `stores/auth.ts`：登录态、token 持久化、当前 child 管理（localStorage + 切换时 reset）
- [x] 9.3 `stores/literacy.ts`：汉字列表缓存、当前 child 切换时 reset 列表/进度缓存
- [x] 9.4 `api/request.ts` 拦截器：401 自动跳转登录页、TOKEN_EXPIRED 提示刷新

## 10. 前端 — 用户体系

- [x] 10.1 注册/登录页 `pages/auth/login`、`pages/auth/register`
- [x] 10.2 儿童档案管理：创建档案、切换当前儿童（切换时刷新所有相关 store）

## 11. 双端适配

- [x] 11.1 使用 uni-app 条件编译区分 H5 / 微信小程序 / app 端样式差异
- [x] 11.2 公共样式 token（颜色/间距/字号）抽离到 `uni.scss` 变量
- [ ] 11.3 H5 浏览器 + 微信开发者工具双端冒烟核心流程

## 12. 后端 — 列表排序与性能

- [x] 12.1 `character_repository` 列表排序改为 `level asc, strokes asc, id asc`
- [x] 12.2 修复 `character_handler` 列表 N+1：进度状态改为单次 IN 批量查询（repository 增加 ListStatusByChildAndCharacterIDs）
- [x] 12.3 单测：排序稳定性（跨页一致）、批量进度附加正确性

## 13. 笔顺与读音静态资源

- [x] 13.1 引入 hanzi-writer-data 数据源，脚本导出 seed 270 字的笔顺 JSON，构建期 glob import 打包进前端
- [x] 13.2 覆盖校验脚本：逐一核对 270 字均有笔顺数据，输出缺字清单（缺字按 spec 降级隐藏入口）
- [x] 13.3 读音音频批量生成脚本（TTS 源以 270 字小样试听后定），产出 `static/audio/<char>.mp3` 并核对齐全
- [x] 13.4 资源体积核对：笔顺 JSON + 音频总增量 ≤10MB

## 14. 前端 — 田字格书写组件（renderjs）

- [x] 14.1 `<hanzi-writer-board>` 组件骨架：renderjs 视图层模块 + 逻辑层 props（char/mode/空间容差/提示阈值）与事件（onQuizComplete/onStrokeResult）
- [x] 14.2 animation 模式：按标准笔顺逐笔动画演示，支持重播
- [x] 14.3 quiz 模式：严格笔顺判定（保序保向、空间容差放宽 ~1.6）、同一笔错 2 次显示灰色提示轨迹
- [x] 14.4 田字格背景网格 + 儿童向视觉：画笔粗细/颜色、判定通过/失败反馈、完成庆祝动效
- [ ] 14.5 组件三端冒烟：H5 / app 自定义基座 / 微信开发者工具触屏书写各验证通过

## 15. 前端 — 详情页集成

- [x] 15.1 详情页装配：拼音/释义/笔画数 + 发音按钮（`uni.createInnerAudioContext` 播放内嵌 mp3，缺失时置灰降级）
- [x] 15.2 笔顺演示区（board animation 模式；无笔顺数据时隐藏演示与书写入口）
- [x] 15.3 书写练习区（board quiz 模式）；onQuizComplete 后自动 `POST /progress {action: complete}` 并刷新进度状态
- [x] 15.4 进入"未学"字详情自动上报 `action: start`；详情页进度标识随之联动

## 16. app 端云打包

- [x] 16.1 manifest.json app-plus 配置：应用名称/图标/启动图/权限/modules 填齐
- [x] 16.2 打包操作文档：DCloud appid 获取、安卓 keystore 生成、HBuilderX 云打包步骤（用户执行部分显式标注）
- [ ] 16.3 app 真机冒烟：登录→列表→详情→读音→笔顺演示→书写→进度闭环跑通
