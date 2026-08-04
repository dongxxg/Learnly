# Learnly AI Service

Python + FastAPI。承载 AI 老师对话、智能出题、自动批改，以及基于 MCP 的教学工具调用。

## 技术栈

- FastAPI + Uvicorn — 异步 Web 框架
- pydantic-settings — 配置（环境变量，前缀 `LEARNLY_AI_`）
- httpx — 调用 LLM API / MCP 工具
- LLM API — OpenAI / Anthropic（按 `LEARNLY_AI_LLM_PROVIDER` 切换）

## 目录结构

```
ai-service/
├── app/
│   ├── main.py               # FastAPI 入口
│   ├── core/                 # 配置、日志
│   ├── api/routes/           # 路由（health 已就绪）
│   └── services/             # LLM 客户端 / MCP 工具（待填充）
├── requirements.txt
└── Dockerfile
```

## 本地运行

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
curl http://localhost:8000/healthz
curl http://localhost:8000/readyz   # 检查 LLM key 是否配置
```

环境变量见 `deploy/.env.example`。

> 业务路由将挂在 `/chat`（AI 老师）、`/generate`（出题）、`/grade`（批改）、`/tools/*`（MCP 工具）下，预留位置见 `app/main.py`。
