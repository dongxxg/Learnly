## Why

首页"知芽英语"入口目前点击仅提示"待开发"。26 个英文字母的大小写笔顺书写与字母名读音是英语启蒙第一课；识字模块已沉淀 hanzi-writer 笔顺引擎、触屏书写板、读音播放与列表/详情页模式，复用即可低成本交付，无需新增后端。

## What Changes

- 新增英语模块页签页与字母列表页：页签页展示 26 字母页签，点击罗列 26 个字母卡（对齐识字列表交互）
- 新增字母详情页：每个字母以四线三格（三线格）展示大小写书写笔顺，含笔顺演示与触屏书写判定，支持字母名读音播放（交互对齐识字模块）
- 笔顺数据自产生成器 `frontend/scripts/gen-letter-data.mjs`：52 字形（A–Z 大小写）生成 HanziData 同构 JSON，零改动复用现有渲染/判定引擎
- 书写板组件 `<hanzi-writer-board>` 泛化：新增 `source`（hanzi/letter）与 `grid`（tian/fourline）props，田字格能力不变
- 读音生成 `frontend/scripts/gen-audio.py` 扩展 edge-tts 英文音色分支，产出 26 个字母名 mp3 至 `static/audio/`
- 首页"知芽英语"入口接入真实导航（静态集合，v1 无登录守卫、无进度上报）

## Capabilities

### New Capabilities

- `english-alphabet`: 英语字母表能力——26 字母页签页、字母列表、四线三格大小写笔顺演示与书写判定、字母名读音播放

### Modified Capabilities

（无——书写板组件泛化为实现层重构，识字模块田字格书写需求不变）

## Impact

- 前端：新增 `pages/english/`（tabs/list/detail）、`stores/english.ts`、`hanzi-letter-data/`（52 字形 JSON）；`components/hanzi-writer-board.vue` 加 props；`pages.json` 注册新页面；`pages/index/index.vue` 入口改造；`utils/` 增加字母工具
- 静态资源：26 个 mp3（约 +100KB）构建期内嵌 app 包；letter-data JSON 打包进 bundle
- 脚本：新增 `frontend/scripts/gen-letter-data.mjs`；`frontend/scripts/gen-audio.py` 加英文音色变体
- 后端：零改动（26 字母为静态集合）
- 测试：前端 type-check（linter 零 error）+ vitest 单测（字母工具/数据加载）+ 三端冒烟
