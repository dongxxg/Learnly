# 知芽 Learnly

> 知识萌芽，AI 陪伴成长。

面向儿童的 AI 教育产品，含 5 个模块：

| 模块 | 说明 |
| --- | --- |
| 知芽识字 | 汉字认读与书写 |
| 知芽英语 | 英语启蒙 |
| 知节数学 | 数学思维 |
| 知芽AI老师 | 个性化 AI 辅导（LLM + MCP 教学工具） |
| 知芽家长助手 | 学习报告与辅导建议 |

## 技术架构

```
frontend(uni-app/Vue3/TS)  ──▶  backend(Go/Gin/GORM + PostgreSQL + Redis)
                                       │
                                       ▼  HTTP
                                 ai-service(Python/FastAPI + LLM + MCP)
```

三端独立子目录（决策见 [docs/adr/0001](docs/adr/0001-monorepo-three-tier.md)）：

| 目录 | 技术栈 | 说明 |
| --- | --- | --- |
| [`frontend/`](frontend/) | uni-app + Vue3 + TS | H5 / 微信小程序 / App |
| [`backend/`](backend/) | Go + Gin + GORM | 业务平台 + PostgreSQL + Redis |
| [`ai-service/`](ai-service/) | Python + FastAPI | AI 老师 / 出题 / 批改 / MCP 工具 |
| [`deploy/`](deploy/) | Docker / docker-compose | 编排与环境变量 |
| [`docs/`](docs/) | — | 架构、ADR |

完整拓扑与模块边界见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

### 一键起容器（推荐）

```bash
cd deploy
cp .env.example .env          # 填入 LEARNLY_AI_LLM_API_KEY，改 LEARNLY_JWT_SECRET
docker compose up -d --build
# 访问 http://localhost
```

### 各端独立开发

```bash
# backend
cd backend && go mod tidy && go run ./cmd/server          # :8080

# ai-service
cd ai-service && pip install -r requirements.txt && \
  uvicorn app.main:app --reload --port 8000               # :8000

# frontend(H5)
cd frontend && npm install && npm run dev:h5              # :5173
```

健康检查：`GET /healthz`（存活）、`GET /readyz`（就绪，探测下游依赖）。

## 状态

当前为**目录结构 + 配置脚手架**阶段：三端可独立启动/构建、容器可联调，但尚无业务代码。
后续按模块（识字 / 英语 / 数学 / AI 老师 / 家长助手）逐步填充，路由挂载点已在各端预留。
