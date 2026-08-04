# 知芽 Learnly 架构

## 目标

知识萌芽，AI 陪伴成长。面向儿童的 AI 教育产品，含识字、英语、数学、AI 老师、家长助手 5 个模块。

## 三端拓扑

```
┌──────────────┐    /api/*    ┌──────────────┐   PostgreSQL / Redis
│  frontend    │ ───────────▶ │   backend    │ ─────────────────────▶
│ uni-app(Vue3)│              │  Go/Gin/GORM │
│ H5/小程序/App │ ── /ai/* ──▶ │              │
└──────────────┘ │            └──────┬───────┘
                 │                   │ HTTP（LLM 调用、MCP 工具）
                 ▼                   ▼
          ┌──────────────┐   ┌──────────────┐   LLM API
          │  ai-service  │ ◀─┤   (转发)     │ ────────▶ OpenAI/Anthropic
          │ Python/FastAPI│   └──────────────┘
          └──────────────┘
```

## 模块边界

| 端 | 职责 | 不做的事 |
| --- | --- | --- |
| **frontend** | UI、多端适配、本地学习状态、离线缓存 | 直接调 LLM、直接读写主库 |
| **backend** | 用户/课程/进度/家长数据、鉴权、计费、对 ai-service 的转发与结果落库 | 跑模型推理、拼长 prompt |
| **ai-service** | AI 老师对话、智能出题、自动批改、MCP 教学工具调用 | 持久化业务数据（结果交 backend 落库） |

原则：**业务数据归属 backend，AI 能力归属 ai-service**。frontend 只与 backend 通信；backend 决定何时调用 ai-service，避免 LLM 密钥与 prompt 逻辑泄漏到客户端。

## 请求链路（示例：AI 老师一节课）

1. frontend → `POST /api/v1/ai-teacher/lessons`（携带 JWT）
2. backend 鉴权 → 取儿童画像与学习进度 → 组装上下文 → `POST ai-service/chat`
3. ai-service 拼 prompt → 调 LLM API（可能并行调 MCP 工具：出题/查词典/语音）→ 流式返回
4. backend 落库进度、计费扣减 → 透传流式响应给 frontend

## 鉴权与多端

- backend 颁发 JWT（家长账户 + 多个儿童档案）
- 微信小程序走 `wx.login` → backend 换 session
- 家长助手端复用同一 JWT，权限隔离家长数据域

## 部署形态

- 容器化（见 `deploy/docker-compose.yml`）：postgres / redis / ai-service / backend / frontend
- frontend(H5) 容器内置 nginx：`/api/*` → backend，`/ai/*` → ai-service
- 生产：TLS 终止、独立网关、ai-service 仅内网可达、LLM 密钥经密钥管理注入

## 待决项

- [ ] LLM 提供商与模型选型（影响成本与延迟）
- [ ] 流式协议（SSE vs WebSocket）统一
- [ ] 儿童数据隐私合规（监护人同意、数据留存策略）
- [ ] MCP 工具集清单与权限模型
