## ADDED Requirements

### Requirement: 共享 UI 组件契约
系统 MUST 提供共享组件（卡片容器、主按钮、页头，位于 `components/ui/`），页面 MUST 使用共享组件而非各自手写同构样式；主按钮组件 MUST 内置 mp-weixin button 默认样式 reset。

#### Scenario: 页面使用共享卡片
- **WHEN** 页面需要白底圆角卡片容器
- **THEN** 引用共享卡片组件，不再复制粘贴阴影/圆角样式

#### Scenario: mp 端按钮无默认边距
- **WHEN** mp-weixin 端渲染共享主按钮
- **THEN** 无 button 默认 margin/边框残留（reset 内置生效）

### Requirement: SVG 图标集
系统 MUST 提供统一线性风格的 SVG 图标组件集（覆盖 5 个模块入口图标、页内功能图标），替换现有汉字代图标与 emoji 混用；图标组件 MUST 双端可用：H5 内联 SVG、mp-weixin 经 base64 data URL 渲染。

#### Scenario: 首页模块图标统一
- **WHEN** 打开首页模块卡片
- **THEN** 5 个模块均显示 SVG 图标，无汉字代图标

#### Scenario: mp 端图标渲染
- **WHEN** mp-weixin 端打开含图标组件的页面
- **THEN** 图标以 image data URL 正常显示，无破图

### Requirement: 吉祥物使用规范
几何风小芽吉祥物（SVG 组件）MUST 仅出现在三类场景：首页 hero、完成庆祝动效、空态占位；MUST NOT 在功能性界面（表单、列表项、设置项）中出现。

#### Scenario: 吉祥物出现位置约束
- **WHEN** 扫描全部页面模板中的吉祥物组件引用
- **THEN** 引用位置仅限 hero/庆祝/空态三类容器内

### Requirement: 资产体积预算
新增视觉资产（图标集+吉祥物）总体积 MUST ≤ 90KB（图标 ≤60KB、吉祥物 ≤30KB），保障小程序主包 2MB 限制。

#### Scenario: 构建产物体积核对
- **WHEN** 双端构建完成并统计新增静态资产体积
- **THEN** 图标与吉祥物体积在预算内，超限则构建核对步骤报告失败
