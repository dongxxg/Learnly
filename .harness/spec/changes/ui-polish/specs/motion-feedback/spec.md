## ADDED Requirements

### Requirement: 三档动效体系
交互反馈 MUST 分三档实现，全部使用纯 CSS（transform/opacity 合成属性优先）：
1. 按压反馈：可点卡片/按钮按下时缩放反馈（≤100ms）
2. 页面转场：沿用 uni-app 导航原生转场，不自绘转场
3. 完成庆祝：学习任务完成时撒花+星星动效（≤800ms，粒子 ≤24）

#### Scenario: 按压卡片有反馈
- **WHEN** 用户按下首页模块卡片或列表卡片
- **THEN** 卡片呈现缩放按压态，松开恢复，全程 ≤100ms

#### Scenario: 书写完成触发庆祝
- **WHEN** 书写 quiz 全部正确触发 onQuizComplete
- **THEN** 详情页播放撒花+星星庆祝动效，时长 ≤800ms

#### Scenario: 庆祝动效不阻塞交互
- **WHEN** 庆祝动效播放中
- **THEN** 页面按钮仍可点击，动效不遮挡关键操作区

### Requirement: 动效性能约束
动效 MUST 仅使用 compositor 友好属性（transform/opacity/filter）；庆祝粒子数 MUST ≤24；H5 端 MUST 响应 `prefers-reduced-motion`（减弱动效），mp 端不支持则忽略。

#### Scenario: 低端机不掉帧布局
- **WHEN** 庆祝动效运行期间检查页面布局
- **THEN** 无 layout 属性（width/height/top/left）动画，无布局抖动

### Requirement: 动效零资产
动效层 MUST NOT 引入图片序列/Lottie/JS 动画库，全部以 CSS keyframes + 令牌色值实现。

#### Scenario: 动效无新增依赖
- **WHEN** 检查 package.json 与动效实现文件
- **THEN** 无新增动画依赖，无 Lottie/图片序列资产
