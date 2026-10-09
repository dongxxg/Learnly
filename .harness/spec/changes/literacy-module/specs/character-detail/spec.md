## ADDED Requirements

### Requirement: 汉字详情查询
The system SHALL 根据汉字 ID 返回完整详情（拼音/释义/笔画数/难度等级/笔顺动画占位）。

#### Scenario: 查询存在的汉字
- **WHEN** 前端请求 `GET /api/characters/:id`
- **THEN** 系统返回该汉字的拼音、释义、笔画数、难度等级、笔顺动画占位 URL

#### Scenario: 查询不存在的汉字
- **WHEN** 前端请求的 ID 在数据库中不存在
- **THEN** 系统返回 404 Not Found

### Requirement: 当前学习进度附加
The system SHALL 在返回汉字详情时，附带当前 child 的学习进度状态。

#### Scenario: 已登录用户查看
- **WHEN** 携带 JWT 的请求查询汉字详情
- **THEN** 响应包含 `progressStatus`（未学/在学/已学）与 `lastStudiedAt`

#### Scenario: 未登录用户查看
- **WHEN** 未携带 JWT 的请求查询汉字详情
- **THEN** 系统返回 401 Unauthorized

## ADDED Requirements

### Requirement: 读音播放
The system SHALL 在详情页提供该汉字读音的播放能力：点击发音按钮播放预置读音音频，可重复播放。

#### Scenario: 点击播放读音
- **WHEN** 用户在详情页点击发音按钮
- **THEN** 播放该汉字的读音音频，再次点击可重播

#### Scenario: 读音资源缺失
- **WHEN** 该汉字的读音音频不存在或加载失败
- **THEN** 发音按钮置灰或提示不可用，不阻塞详情页其余功能，不弹出错误

### Requirement: 笔顺演示
The system SHALL 在详情页提供标准笔顺动画演示：按标准书写顺序逐笔动态展示该汉字的书写过程，可重复播放。

#### Scenario: 播放笔顺动画
- **WHEN** 用户点击笔顺演示按钮（或进入详情页自动演示）
- **THEN** 在田字格区域按标准笔顺逐笔动画展示书写过程，可重播

#### Scenario: 笔顺数据缺失
- **WHEN** 该汉字无笔顺数据
- **THEN** 详情页隐藏笔顺演示与书写入口，正常展示拼音/释义/笔画数等其余信息，不报错
