## ADDED Requirements

### Requirement: 家长注册
The system SHALL 支持手机号+密码注册，密码须加密存储。

#### Scenario: 成功注册
- **WHEN** 前端请求 `POST /api/auth/register` body: `{ phone, password }`
- **THEN** 系统创建 Parent 记录，返回 JWT token 与过期时间

#### Scenario: 手机号已注册
- **WHEN** 注册手机号已存在
- **THEN** 系统返回 409 Conflict，提示"手机号已注册"

### Requirement: 家长登录
The system SHALL 验证手机号+密码，签发 JWT。

#### Scenario: 登录成功
- **WHEN** 前端请求 `POST /api/auth/login` 携带正确凭证
- **THEN** 系统返回 JWT token 与关联的 child profiles 列表

#### Scenario: 密码错误
- **WHEN** 密码不匹配
- **THEN** 系统返回 401 Unauthorized

### Requirement: 多儿童档案管理
The system SHALL 支持一个 Parent 关联多个 ChildProfile，切换时刷新前端状态。

#### Scenario: 创建儿童档案
- **WHEN** 已登录用户请求 `POST /api/profiles` body: `{ name, avatar }`
- **THEN** 系统创建 ChildProfile 并关联到当前 Parent

#### Scenario: 切换当前儿童
- **WHEN** 前端请求 `POST /api/profiles/switch` body: `{ childId }`
- **THEN** 系统校验 childId 属于当前 Parent，返回新 JWT（含 childId 声明）

### Requirement: JWT 鉴权中间件
The system SHALL 对需要鉴权的路由校验 JWT 有效性。

#### Scenario: Token 有效
- **WHEN** 请求携带未过期且签名正确的 JWT
- **THEN** 中间件将 `parentId` 注入上下文，放行请求

#### Scenario: Token 过期
- **WHEN** 请求携带已过期的 JWT
- **THEN** 系统返回 401 Unauthorized，body 含 `code: "TOKEN_EXPIRED"`
