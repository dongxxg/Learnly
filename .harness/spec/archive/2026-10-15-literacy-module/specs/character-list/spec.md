## ADDED Requirements

### Requirement: 汉字列表分页查询
The system SHALL 支持按页码和每页条数分页查询汉字列表，返回总数与当前页数据。

#### Scenario: 默认分页查询
- **WHEN** 前端请求 `GET /api/characters?page=1&pageSize=20`
- **THEN** 系统返回第 1 页 20 条汉字数据，响应包含 `total`、`page`、`pageSize`、`items`

#### Scenario: 超出页码范围
- **WHEN** 前端请求的 page 超出最大页数
- **THEN** 系统返回空 items 数组，total 为实际总数

### Requirement: 按难度等级筛选
The system SHALL 支持按难度等级（level）筛选汉字列表。

#### Scenario: 筛选指定难度
- **WHEN** 前端请求 `GET /api/characters?level=1`
- **THEN** 系统仅返回 level=1 的汉字，分页基于筛选后总数

#### Scenario: 不传筛选参数
- **WHEN** 前端请求未携带 level 参数
- **THEN** 系统返回全部汉字（仍分页）

### Requirement: 进度状态过滤
The system SHALL 支持按学习进度状态（未学/在学/已学）过滤汉字列表。

#### Scenario: 筛选已学汉字
- **WHEN** 前端请求 `GET /api/characters?status=learned&childId=xxx`
- **THEN** 系统返回当前 child 已学汉字列表

#### Scenario: 未登录访问
- **WHEN** 未携带 JWT 的请求访问列表接口
- **THEN** 系统返回 401 Unauthorized

## ADDED Requirements

### Requirement: 汉字列表按简单到复杂排序
The system SHALL 按"难度等级升序 → 笔画数升序 → ID 升序"对汉字列表排序，保证展示顺序稳定且从简单到复杂。

#### Scenario: 默认排序
- **WHEN** 前端请求 `GET /api/characters` 不带排序参数
- **THEN** 系统按 level 升序、同 level 内 strokes 升序、同 strokes 内 id 升序返回列表

#### Scenario: 排序跨页稳定
- **WHEN** 前端连续请求不同页码
- **THEN** 相同汉字在各页请求中的相对顺序保持一致（排序键唯一且稳定）

### Requirement: 列表进度批量附加
The system SHALL 以批量查询（单次 IN 查询）为当前页汉字附加学习进度状态，禁止逐字循环查询。

#### Scenario: 分页列表附带进度
- **WHEN** 前端请求 `GET /api/characters?page=1&pageSize=100`
- **THEN** 响应中每个 item 含该 child 的进度状态，且进度查询仅产生一次数据库调用
