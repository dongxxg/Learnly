## ADDED Requirements

### Requirement: 逐页迁移完成定义
19 个 .vue（16 页面+3 组件）MUST 全量完成令牌迁移：白名单外硬编码色值/字号/阴影归零，页面气质统一（同一套卡片/按钮/页头规范）。迁移 MUST 分批进行（每批 3-5 页），每批迁移后 MUST 通过截图比对再进入下一批。

#### Scenario: 单批迁移回归
- **WHEN** 某批页面迁移完成
- **THEN** 该批页面 H5 截图与迁移前比对无布局错位/文字溢出，双端构建通过

#### Scenario: 全量迁移验收
- **WHEN** 6 批迁移全部完成
- **THEN** 令牌扫描脚本白名单外违规计数为 0，vitest 全量通过，type-check 零错误

### Requirement: 教学组件几何红线
hanzi-writer-board / letter-copybook / stroke-strip 三组件的田字格/四线三格 linear-gradient 线位百分比 MUST 原样保留（与 hanzi-writer Positioner 数据空间及 gen-letter-data.mjs 三方同源的数学契约）；仅线色/背景色/边框/阴影可令牌化；`hanzi-writer-mp` canvas 绘制配色 MUST 与令牌主题色同步。

#### Scenario: 几何未漂移可验证
- **WHEN** 教学组件迁移完成并做 H5 渲染快照比对
- **THEN** 格线位置像素级一致（色值差异除外），书写判定行为不变

#### Scenario: mp 端配色同步
- **WHEN** mp-weixin 端打开识字/字母详情页
- **THEN** canvas 板配色与页面主题一致，无孤立旧色

### Requirement: 状态类名契约保留
`utils/hanzi.ts` 的 `STATUS_CLASS`（status-unlearned/status-learning/status-learned）utils→页面类名契约 MUST 保留，迁移时仅可改其样式实现。

#### Scenario: 进度状态样式正常
- **WHEN** 列表页渲染不同学习状态的字卡角标
- **THEN** 三类状态类名对应样式正确区分显示

### Requirement: TabBar 图标精修
TabBar 四枚 PNG 图标（home/profile 及 active 态）MUST 重绘为与令牌主题色一致的精修版本（81px 标准保留），替换现有占位图。

#### Scenario: TabBar 视觉更新
- **WHEN** 查看双端 TabBar
- **THEN** 图标为重绘版本，选中态使用品牌绿令牌同值色

### Requirement: 品牌字体 spike 门禁
品牌圆润字体 MUST 先经双路 spike（H5 @font-face + mp wx.loadFontFace）验证域名白名单、加载闪烁与体积方案，验证通过并经 PM 确认后才可全量引入；验证不通过则维持系统字体栈。

#### Scenario: spike 失败零影响回退
- **WHEN** 品牌字体 spike 验证不通过
- **THEN** 全站维持系统字体栈，无残留字体引入代码
