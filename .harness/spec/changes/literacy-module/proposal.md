## Why

识字模块后端已落地（270 字字库、进度状态机、JWT 鉴权），但前端页面未开发，首页"知芽识字"入口点击仅提示"待开发"。产品核心体验要求儿童能"听音、看笔顺、动手写"：按简单到复杂展示汉字、详情含读音与笔顺演示、田字格触屏书写且严格按笔顺判定——这些能力决定产品可用性。app 端交付还需顺带完成云打包配置。

## What Changes

- 前端识字列表页/详情页落地（原计划未实施部分）：分页、难度筛选、进度标识、注册路由
- 汉字列表按"简单到复杂"显式排序：level 升序 → 笔画数升序 → id 升序（后端排序修改 + 修复列表接口 N+1）
- 汉字详情新增真实笔顺演示与读音播放：引入 Hanzi Writer（MIT 开源）+ 开源笔顺数据，读音采用预生成 mp3 静态资源
- 新增田字格触屏书写：renderjs 封装 Hanzi Writer quiz 模式，严格按笔顺逐笔判定（保序保向、空间容差放宽适配儿童），连续写错出提示轨迹
- 书写结果驱动进度：进详情自动上报 start，quiz 通过自动上报 complete（复用现有进度契约，后端零改动）
- 笔顺数据与读音音频构建期内嵌 app 包（270 字一次性打包，约 +7MB）
- app 端（app-plus）云打包：manifest/图标/权限配置与打包操作文档（DCloud appid 与证书由用户提供）

## Capabilities

### New Capabilities
- `stroke-writing`: 田字格触屏书写画板、严格按笔顺判定、书写提示、书写通过自动记录进度

### Modified Capabilities
- `character-list`: 新增"按简单到复杂排序"需求（level → strokes → id 稳定排序）
- `character-detail`: 新增"读音播放"与"笔顺演示"需求（含数据缺失降级）

（`user-auth`、`progress-tracking` 需求不变）

## Impact

- 后端：character 列表接口排序修改 + N+1 修复（无 schema 变更；`OrderData` 占位字段弃用保留）
- 前端：新增依赖 hanzi-writer（经 renderjs 引入）；新增列表/详情页面与书写组件；pages.json 注册新页面
- 静态资源：270 字笔顺 JSON + 读音 mp3 构建期内嵌 frontend/src/static/（包体积 +7MB 左右）
- manifest.json app-plus 段配置（名称/图标/权限/modules）
- 打包链路：HBuilderX 云打包；DCloud appid、安卓 keystore、iOS 证书必须由用户本人提供（AI 交付备料与文档）
- 测试：后端补列表排序/批量进度查询单测；前端三端冒烟（H5 / app 基座 / 微信开发者工具）
