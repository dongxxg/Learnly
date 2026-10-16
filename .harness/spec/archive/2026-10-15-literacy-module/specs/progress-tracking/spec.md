## ADDED Requirements

### Requirement: 记录学习行为
The system SHALL 接收学习行为上报，按状态机规则更新进度。

#### Scenario: 首次学习
- **WHEN** 前端上报 `POST /api/progress` body: `{ characterId: "xxx", action: "start" }`
- **THEN** 系统创建进度记录，状态置为"在学"

#### Scenario: 完成学习
- **WHEN** 前端上报 `action: "complete"` 且当前状态为"在学"
- **THEN** 系统将状态更新为"已学"，记录 `completedAt`

#### Scenario: 重复完成
- **WHEN** 已完成状态下再次上报 `action: "complete"`
- **THEN** 系统保持"已学"状态，更新 `lastStudiedAt`，不报错

### Requirement: 进度状态机
The system SHALL 维护状态流转：未学 → 在学 → 已学（单向不可逆）。

#### Scenario: 非法回退
- **WHEN** 已学状态尝试上报 `action: "start"`
- **THEN** 系统忽略该操作，返回当前状态

### Requirement: 学习统计
The system SHALL 返回当前 child 的学习统计（已学数/在学数/未学数/总数）。

#### Scenario: 查询统计
- **WHEN** 前端请求 `GET /api/progress/stats?childId=xxx`
- **THEN** 系统返回 `{ learned: 10, learning: 3, unlearned: 487, total: 500 }`
