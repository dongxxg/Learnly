# Learnly Backend

Go + Gin + GORM 业务平台。承载用户、课程、学习进度、家长数据等核心域，并作为反向代理把 AI 相关请求转发到 `ai-service`。

## 技术栈

- Gin — HTTP 框架
- GORM + PostgreSQL — ORM / 主库
- go-redis — 缓存（会话、限流、热点）
- go-tools/config — 配置（`conf/configuration.toml` + 无前缀环境变量覆盖，例 `POSTGRES_HOST`）

## 目录结构

```
backend/
├── cmd/server/main.go        # 启动入口
├── internal/
│   ├── config/               # 环境变量加载
│   ├── handler/              # HTTP 处理器（Deps 注入 DB/Redis）
│   ├── router/               # 路由注册
│   ├── store/                # PostgreSQL / Redis 连接初始化
│   ├── model/                # GORM 模型（待填充）
│   ├── repository/           # 数据访问层（待填充）
│   └── service/              # 业务逻辑（待填充）
├── go.mod
└── Dockerfile
```

分层约定：`handler → service → repository → model`。

## 本地运行

```bash
go mod tidy
go run ./cmd/server
# 健康检查
curl http://localhost:8080/healthz   # liveness
curl http://localhost:8080/readyz    # readiness（探测 postgres/redis）
```

环境变量见 `deploy/.env.example`。

> 业务模块将挂在 `/api/v1/{literacy,english,math,ai-teacher,parent}` 下，预留位置见 `internal/router/router.go`。
