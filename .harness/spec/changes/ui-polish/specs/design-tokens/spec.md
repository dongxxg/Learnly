## ADDED Requirements

### Requirement: 设计令牌唯一权威
所有页面与组件样式 MUST 引用设计令牌（SCSS 变量或 CSS 变量），禁止新增硬编码色值、字号、间距、阴影。唯一白名单：教学组件格线几何百分比（见 page-theming 规格）。

#### Scenario: 新代码引用硬编码色被拦截
- **WHEN** 任意 .vue 文件新增 `color: #xxxxxx` 形式的硬编码色值（教学组件白名单文件除外）
- **THEN** 令牌引用扫描脚本报告该文件违规，CI 门禁失败

#### Scenario: 全量迁移后硬编码归零
- **WHEN** 对 frontend/src 运行令牌引用扫描脚本
- **THEN** 白名单外硬编码色/字号/阴影计数为 0

### Requirement: 令牌覆盖域
令牌体系 MUST 覆盖：品牌色（萌芽绿/暖阳橙及渐变对）、中性灰阶、状态色（成功/警告/错误/信息）、边框灰、8 级字阶、4 级间距、3 级圆角、2 级阴影。

#### Scenario: 各域令牌可取用
- **WHEN** 页面需要字阶/间距/阴影/状态色中任一样式
- **THEN** 存在对应命名令牌可供引用，无需临时拼凑数值

### Requirement: SCSS 与 CSS 变量同源
令牌 MUST 以 SCSS 变量（编译期，uni.scss 自动注入）与 CSS 变量（运行时，全局注入）双轨交付，两轨取值 MUST 一致。

#### Scenario: 双轨漂移被检出
- **WHEN** uni.scss 变量值与全局 CSS 变量值出现不一致
- **THEN** sync 断言测试失败并指出漂移的变量名

### Requirement: pages.json 主题值同步
pages.json 中 tabBar 与导航栏颜色 MUST 与令牌值保持一致；令牌改色时 MUST 同步更新 pages.json（SCSS 无法注入 JSON 的物理限制，以 sync 断言测试守护）。

#### Scenario: 改主题色漏改 pages.json 被检出
- **WHEN** 令牌中品牌绿值变更而 pages.json 的 selectedColor 未同步
- **THEN** sync 断言测试失败并提示需同步的字段
