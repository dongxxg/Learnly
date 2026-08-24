## Why

项目处于脚手架阶段（零业务代码），需要首个落地业务模块验证技术栈与架构分层。识字模块是儿童教育产品的核心能力，覆盖汉字列表、详情、进度追踪与用户体系，能端到端检验后端 API + 前端页面 + 数据持久化的完整链路。

## What Changes

- 新增 `literacy` 后端模块：汉字数据管理、学习进度 RESTful API、JWT 鉴权中间件
- 新增 `Parent` / `ChildProfile` / `Progress` / `Character` 四实体及其数据库迁移
- 新增用户体系内部子包（注册/登录/多儿童档案切换）
- 新增前端识字页面：汉字列表（分页/难度筛选）、汉字详情（拼音/释义/笔顺动画占位）
- 新增 Pinia 状态管理（按 child 重置缓存）
- 新增内置 seed 数据（几百常用字，JSON + 启动加载）
- 新增 H5 + 微信小程序双端适配

## Capabilities

### New Capabilities
- `character-list`: 汉字列表分页查询、按难度等级筛选
- `character-detail`: 汉字详情展示（拼音/释义/笔画/笔顺动画占位）
- `progress-tracking`: 学习进度状态机（未学→在学→已学）的读写与统计
- `user-auth`: JWT 鉴权、家长注册/登录、多儿童档案切换

### Modified Capabilities
（无，首个业务模块，无既有能力变更）

## Impact

- 新增数据库表：`parents`, `child_profiles`, `characters`, `progresses`
- 新增 API 路由：`/api/auth/*`, `/api/characters/*`, `/api/profiles/*`, `/api/progress/*`
- 新增前端路由：`/literacy/list`, `/literacy/detail/:id`
- 依赖：PostgreSQL（主存）、Pinia（前端状态）、JWT 库
- 测试：新增单测覆盖核心 service 与 handler，覆盖率目标 ≥80%
