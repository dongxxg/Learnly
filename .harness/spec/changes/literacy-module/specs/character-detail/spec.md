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
