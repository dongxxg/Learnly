## 1. 令牌层（design-tokens）

- [x] 1.1 `uni.scss` 扩容为完整令牌：品牌色对（萌芽绿/暖阳橙+渐变）、中性灰阶、状态色、边框灰、8 级字阶、4 级间距、3 圆角、2 阴影；旧 6 变量名保持兼容映射
- [x] 1.2 App.vue 全局注入 CSS 变量（与 SCSS 同值双轨）；新增 sync 断言测试（解析 uni.scss 与 CSS 变量块比对，含 pages.json tabBar/导航栏颜色比对）并纳入 vitest
- [x] 1.3 新增令牌引用扫描脚本 `scripts/check-tokens.mjs`（白名单：教学组件 3 文件几何百分比；规则：硬编码色/字号/阴影违规计数），输出违规清单，接入 `npm run check` 类 script（基线：全站 161 处违规，白名单 3 文件；报告模式默认，--strict 留待 5.3 接门禁）
- [x] 1.4 `pages.json` 对齐令牌值（tabBar selectedColor/backgroundColor 等），确认与 uni.scss 无漂移（sync 测试通过，值本就同源无需改动）

## 2. 共享件与资产（ui-kit）

- [x] 2.1 `components/ui/` 共享组件（TDD 优先可测逻辑）：卡片容器 LCard、主按钮 LButton（内置 mp button reset）、页头 LPageHeader；props/slot 契约注释齐全
- [x] 2.2 SVG 图标组件集：5 个模块入口图标 + 页内常用功能图标（返回/发音/播放/重写等），双端分支（H5 内联 SVG / mp base64 data URL image）；单测覆盖 data URL 生成纯函数（双端渲染验证留待批次 A 截图）
- [x] 2.3 几何风小芽吉祥物 SVG 组件（2-3 造型候选，PM 过目定稿：选 A 简约双子叶芽 2026-10-15）；体积核对：图标集 ≤60KB、吉祥物 ≤30KB（源码合计 3.6KB）
- [x] 2.4 首页改造：hero 品牌绿渐变 + 吉祥物 + 模块卡片换 SVG 图标 + 学习数据占位（接入现有进度接口的统计展示；登录态调 getStats，未登录/无档案/接口失败静默降级占位文案）

## 3. 逐页迁移（page-theming，6 批）

- [x] 3.1 批次 A：首页 index + TabBar 图标重绘（81px 精修 PNG×4，SVG→Edge headless 栅格化，脚本 scripts/gen-tab-icons.py 可复现）+ pages.json tabBar 收口；截图比对通过（.harness/tasks/ui-polish/batch-a/h5-home-390.png，无横向溢出 scroll=390=inner）
- [x] 3.2 批次 B：英语模块 3 页（tabs/list/detail）+ letter-copybook 边框阴影令牌化（几何百分比冻结）；截图比对通过（batch-b/h5-en-{tabs,list,detail}.png；H5 路由为 history 模式，截图须走 SPA fallback 服务，见 batch-b/spa-server.py）
- [x] 3.3 批次 C：数学模块 3 页（tabs/ranges/practice）；截图比对通过
- [x] 3.4 批次 D：汉语 tabs + 识字 2 页 + hanzi-writer-board/stroke-strip 边框阴影令牌化（几何冻结 + 渲染快照比对格线像素一致）；STATUS_CLASS 类名契约验证不变；截图比对通过
- [x] 3.5 批次 E：古诗 2 页（list/detail）；截图比对通过
- [x] 3.6 批次 F：auth 4 页（login/register/profiles/profile）；截图比对通过
- [x] 3.7 `hanzi-writer-mp` canvas 配色常量同步令牌主题色；mp 端识字/字母详情冒烟（渲染+书写判定不回归）

## 4. 动效层（motion-feedback）

- [ ] 4.1 按压反馈：共享卡片/主按钮内置按压态（scale+令牌过渡时长）；列表卡片逐页套用
- [ ] 4.2 完成庆祝动效：CSS keyframes 撒花+星星（≤800ms、粒子 ≤24、仅 transform/opacity），接入识字/字母详情 onQuizComplete；H5 端 prefers-reduced-motion 降级
- [ ] 4.3 动效验收：双端截图/录屏抽查无布局抖动；确认 package.json 零新增动画依赖

## 5. 双端专项与全量回归

- [ ] 5.1 品牌字体 spike：候选字体 H5 @font-face + mp wx.loadFontFace 双路验证（域名白名单/加载闪烁/体积方案），结论与 PM 确认记录进 design.md D7；不通过则维持系统栈
- [ ] 5.2 体积核对：双端构建产物统计新增资产总量（≤90KB 预算）与主包体积，超限出裁剪清单
- [ ] 5.3 全量回归：type-check 零错误 + vitest 全量通过 + 令牌扫描白名单外违规 0 + sync 断言通过；三端（H5/app 基座/微信开发者工具）关键页截图比对抽查
- [ ] 5.4 三端冒烟（PM 决定执行方式：免验关闭或按 literacy smoke-checklist 惯例人工执行）
