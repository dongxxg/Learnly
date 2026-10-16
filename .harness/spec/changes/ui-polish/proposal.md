# ui-polish — 前端 UI 美化到上线标准

## Why

当前 UI 是"功能可用但无记忆点"的工程师审美：token 采用率虽 100%，但体系只有 6 个变量，一致性靠复制粘贴维持（同一条阴影复制 19 处/14 文件、硬编码灰 36 处、字号 16 种无刻度）；5 个模块 5 种气质（首页汉字当图标、英语页 emoji 混用）。家长打开 3 秒内感受不到"这是给孩子做的产品"，达不到上线标准。

探索阶段（2026-10-15）已定案三个决策：**视觉方向 C（清爽底+童趣点缀）**、**插画资产纯 SVG/CSS 手搓**、**先收尾旧变更再开本变更**（前置条件已满足）。

## What Changes

- **建立完整设计令牌体系**：uni.scss 从 6 变量扩为覆盖色彩/8 级字阶/间距刻度/圆角/阴影分级/状态色/边框灰的 token 层，SCSS 变量+CSS 变量双轨（兼容 mp-weixin）
- **抽取共享 UI 组件**：卡片容器、主按钮、页头等（收敛 19 处重复阴影、36 处硬编码灰、各页手写 button reset）
- **统一视觉资产**：SVG 线性图标集（替换汉字/emoji 混用）、几何风小芽吉祥物（仅关键位置：hero、完成庆祝、空态）、品牌绿渐变 hero
- **逐页视觉迁移**：19 个 .vue（16 页面+3 组件）机械替换硬编码色→token，统一页面气质
- **动效层**：按压反馈→页面转场→完成庆祝（撒花+星星）三档，纯 CSS keyframes 优先
- **双端专项**：品牌字体 wx.loadFontFace 双路验证、TabBar PNG 图标重绘（81px→精修）、三端截图比对回归

明确**不做**（另行处理）：小程序分享卡片图、骨架屏/空态流程、逐页导航栏主题——进上线 checklist；上线渠道合规（类目/备案/儿童信息/AI 模块取舍）见 `docs/launch-compliance.md`。

## Capabilities

### New Capabilities
- `design-tokens`: 设计令牌体系——色彩/字阶/间距/圆角/阴影/状态色的唯一权威定义，SCSS+CSS 变量双轨交付，pages.json 同步规则
- `ui-kit`: 共享 UI 组件与视觉资产——卡片/主按钮/页头组件契约，SVG 图标集与吉祥物使用规范
- `motion-feedback`: 动效与反馈——按压/转场/庆祝三档动效的触发时机、时长与双端兼容约束
- `page-theming`: 逐页视觉迁移与双端专项——19 个 .vue 的迁移要求、教学组件几何红线、字体双路、TabBar 图标、截图比对验收

### Modified Capabilities
（无——既有 6 个能力域规格均为功能需求，本变更新增视觉层，不改变其规格级行为）

## Impact

- **代码**：`frontend/src/` 全部 19 个 .vue、`uni.scss`、`App.vue`、`pages.json`、`static/tab/*.png`、`hanzi-writer-mp/` 绘制配色；预计不新增任何 npm 依赖（纯自绘，与 literacy design.md"无 UI 库"既定决策一致）
- **红线约束**：田字格/四线三格 linear-gradient 线位百分比是与 hanzi-writer Positioner 数据空间（y∈[-124,900]/1024）及 gen-letter-data.mjs 三方同源的数学契约，只准调色不准动几何；`STATUS_CLASS`（unlearned/learning/learned）utils→页面类名契约必须保留
- **不受影响**：backend/、ai-service/、deploy/ 零改动；功能行为（登录/进度上报/书写判定）零变化
- **风险点**：小程序主包 2MB 限制（禁止引入大图/Lottie）；自定义字体需 loadFontFace 双路且字体文件域名白名单
