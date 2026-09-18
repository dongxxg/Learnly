# Deploy

本机 / 单机编排。生产环境应在 docs 架构基础上补充：TLS 终止、独立网关、密钥管理、持久化备份、CI/CD。

## 快速启动

```bash
cd deploy
cp .env.example .env          # 至少填入 LEARNLY_AI_LLM_API_KEY、改 JWT_SECRET
docker-compose up -d --build
```

## 服务与端口

| 服务          | 容器                  | 端口   | 说明                          |
| ------------- | --------------------- | ------ | ----------------------------- |
| frontend(H5)  | learnly-frontend      | :80    | nginx 托管 + 反代 `/api` `/ai` |
| backend       | learnly-backend       | :8080  | Go/Gin，`/healthz` `/readyz`   |
| ai-service    | learnly-ai-service    | :8000  | FastAPI，`/healthz` `/readyz`  |
| postgres      | learnly-postgres      | :5432  | 主库                          |
| redis         | learnly-redis         | :6379  | 缓存                          |

访问入口：http://localhost（frontend），http://localhost:8080/healthz（backend 直连）。

## 请求链路

```
浏览器/小程序 ──> frontend(nginx:80)
                     ├── /        → H5 静态资源
                     ├── /api/*   → backend:8080
                     └── /ai/*    → ai-service:8000
```

## 常用命令

```bash
docker compose logs -f backend         # 跟踪日志
docker compose restart backend         # 重启单服务
docker compose down                    # 停止（保留数据卷）
docker compose down -v                 # 停止并清空数据（postgres/redis 数据丢失）
```
