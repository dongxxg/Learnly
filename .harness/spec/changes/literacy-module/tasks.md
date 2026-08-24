## 1. 数据层 — 模型与迁移

- [ ] 1.1 定义 GORM 模型：`Parent`（id, phone, password_hash, created_at）、`ChildProfile`（id, parent_id FK, name, avatar, created_at）、`Character`（id, char, pinyin, strokes, level, definition, order_data, created_at）、`Progress`（id, child_id FK, character_id FK, status, last_study_at, completed_at, created_at; UNIQUE(child_id, character_id)）
- [ ] 1.2 实现自动迁移（AutoMigrate）：启动时按顺序创建 4 张表，失败阻塞启动并打印错误
- [ ] 1.3 在 `model` 包暴露 `AllModels()` 返回模型切片，供迁移统一调用

## 2. Seed 数据 — 常用字库

- [ ] 2.1 创建 `seeds/characters.json`：包含 ≥200 个小学语文一级常用字（char/pinyin/strokes/level/definition）
- [ ] 2.2 实现 seed 加载器：启动时读取 JSON，按 char 唯一键 MERGE（已存在则跳过，不存在则插入）
- [ ] 2.3 种子加载失败阻塞启动并打印明确错误；加载成功后打印实际插入/跳过计数

## 3. Repository 层

- [ ] 3.1 `parent_repository`：FindByPhone、Create
- [ ] 3.2 `child_profile_repository`：FindByParentID、FindByIDAndParent、Create
- [ ] 3.3 `character_repository`：FindByID、List（支持 page/pageSize/level 筛选，返回 total+items）
- [ ] 3.4 `progress_repository`：FindByChildAndCharacter、Upsert（按 UNIQUE 约束原子更新 status）、GetStatsByChild（返回 learned/learning/unlearned/total）

## 4. Service 层

- [ ] 4.1 `auth_service`：Register（手机号唯一性校验 + bcrypt 哈希 + JWT 签发）、Login（密码验证 + JWT 签发）
- [ ] 4.2 `child_service`：CreateProfile、SwitchProfile（校验 childId 归属当前 parent）
- [ ] 4.3 `character_service`：GetByID、List（参数校验 + 调用 repository）
- [ ] 4.4 `progress_service`：RecordStudy（状态机：未学→在学→已学，单向不可逆，重复完成仅更新 last_study_at）、GetStats、GetStatusByCharacter
- [ ] 4.5 所有 service 接口定义清晰，repository 通过接口注入（便于单测 mock）

## 5. Handler 层 + 路由

- [ ] 5.1 `auth_handler`：POST `/api/v1/auth/register`、POST `/api/v1/auth/login`
- [ ] 5.2 `child_handler`：POST `/api/v1/profiles`、POST `/api/v1/profiles/switch`（需 JWT）
- [ ] 5.3 `character_handler`：GET `/api/v1/characters`（分页/筛选，需 JWT）、GET `/api/v1/characters/:id`（详情+进度，需 JWT）
- [ ] 5.4 `progress_handler`：POST `/api/v1/progress`（学习行为上报，需 JWT）、GET `/api/v1/progress/stats`（统计，需 JWT）
- [ ] 5.5 在 `router.go` 注册所有 literacy 路由，受保护路由挂 JWT 中间件

## 6. JWT 鉴权

- [ ] 6.1 `auth` 包：GenerateToken（含 parent_id、child_id 声明）、VerifyToken（解析 + 过期校验）
- [ ] 6.2 JWT 中间件：从 Authorization Header 提取 token，校验后注入 `parentId`/`childId` 到 gin context；过期返回 401 + `TOKEN_EXPIRED`
- [ ] 6.3 JWT secret 通过 `LEARNLY_JWT_SECRET` 环境变量注入，启动时校验存在性

## 7. 单元测试（覆盖率 ≥80%）

- [ ] 7.1 service 层单测：auth（注册/登录/密码错误）、progress（状态机所有分支/非法回退）、character（列表/详情/不存在）
- [ ] 7.2 handler 层单测：HTTP 状态码校验、参数校验、JWT 鉴权成功/失败/过期场景
- [ ] 7.3 repository 使用 sqlite内存库或 sqlmock 测试查询正确性
- [ ] 7.4 运行 `go test ./... -cover` 确认覆盖率 ≥80%

## 8. 前端 — 识字模块页面

- [ ] 8.1 汉字列表页 `pages/literacy/list`：分页加载、按难度筛选、进度状态标识、下拉刷新/上拉加载
- [ ] 8.2 汉字详情页 `pages/literacy/detail`：展示拼音/释义/笔画/笔顺动画占位、学习按钮（触发 start/complete）
- [ ] 8.3 学习统计入口：展示 learned/learning/unlearned/total

## 9. 前端 — 状态管理与 API

- [ ] 9.1 `api/literacy.ts`：封装所有 literacy 接口（带 JWT header）
- [ ] 9.2 `stores/auth.ts`：登录态、token 持久化、当前 child 管理（localStorage + 切换时 reset）
- [ ] 9.3 `stores/literacy.ts`：汉字列表缓存、当前 child 切换时 reset 列表/进度缓存
- [ ] 9.4 `api/request.ts` 拦截器：401 自动跳转登录页、TOKEN_EXPIRED 提示刷新

## 10. 前端 — 用户体系

- [ ] 10.1 注册/登录页 `pages/auth/login`、`pages/auth/register`
- [ ] 10.2 儿童档案管理：创建档案、切换当前儿童（切换时刷新所有相关 store）

## 11. 双端适配

- [ ] 11.1 使用 uni-app 条件编译区分 H5 / 微信小程序样式差异
- [ ] 11.2 公共样式 token（颜色/间距/字号）抽离到 `uni.scss` 变量
- [ ] 11.3 真机/模拟器双端冒烟：H5 浏览器 + 微信开发者工具各跑通核心流程
