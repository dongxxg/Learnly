## ADDED Requirements

### Requirement: 田字格触屏书写
The system SHALL 提供田字格书写画板，支持手指触屏在格内书写汉字，实时渲染笔迹。

#### Scenario: 进入书写模式
- **WHEN** 用户在详情页进入书写练习
- **THEN** 展示田字格画板（含淡色目标字轮廓提示），可立即起笔书写

#### Scenario: 触屏书写轨迹
- **WHEN** 用户手指在田字格内按下并移动
- **THEN** 实时渲染书写轨迹，抬笔结束当前笔画

#### Scenario: 三端可用
- **WHEN** 在 H5、app 端（app-plus）、微信小程序端打开书写画板
- **THEN** 触屏书写交互在三端均可用（renderjs 视图层渲染）

### Requirement: 严格按笔顺判定
The system SHALL 按"必须严格遵循标准笔顺"判定书写：逐笔校验顺序与方向，错误即提示重写当前笔，不得跳笔或乱序通过。

#### Scenario: 笔顺正确
- **WHEN** 用户按标准笔顺逐笔写完所有笔画
- **THEN** 每笔实时判定通过，全部完成后判定书写成功并给出成功反馈

#### Scenario: 笔顺顺序错误
- **WHEN** 用户书写的笔画顺序与标准笔顺不符
- **THEN** 当前笔判定失败并提示重写该笔

#### Scenario: 空间容差放宽
- **WHEN** 用户笔画位置/形状与标准轨迹有偏差，但顺序与方向正确
- **THEN** 判定通过（空间容差放宽适配儿童手指，顺序与方向不放宽）

### Requirement: 书写提示
The system SHALL 在同一笔连续写错达到阈值（2 次）时显示该笔的灰色提示轨迹供描红，避免儿童挫败卡死。

#### Scenario: 连续写错触发提示
- **WHEN** 同一笔连续判定失败达到 2 次
- **THEN** 显示该笔提示轨迹，用户描红后继续正常判定

### Requirement: 书写通过自动记录进度
The system SHALL 在书写判定全部通过时自动上报完成进度，无需手动按钮；未通过不上报完成。

#### Scenario: 书写全部通过
- **WHEN** 用户按正确笔顺写完全部笔画（quiz 通过）
- **THEN** 前端自动调用 `POST /api/progress`（action=complete），该字状态变为"已学"

#### Scenario: 进入详情自动开始
- **WHEN** 用户进入"未学"状态汉字的详情页
- **THEN** 前端自动上报 action=start，状态变为"在学"

#### Scenario: 已学汉字重复写对
- **WHEN** 已学汉字再次书写通过并上报 complete
- **THEN** 服务端保持"已学"状态仅刷新最近学习时间，前端无错误提示
