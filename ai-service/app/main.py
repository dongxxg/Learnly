import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.routes import health
from app.core.config import get_settings
from app.core.logger import setup_logging


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    s = get_settings()
    logging.getLogger("app").info(
        "starting %s (provider=%s, model=%s)", s.app_name, s.llm_provider, s.llm_model
    )
    yield
    logging.getLogger("app").info("shutting down %s", get_settings().app_name)


settings = get_settings()
app = FastAPI(title="Learnly AI Service", version="0.1.0", lifespan=lifespan)

app.include_router(health.router, tags=["health"])

# 业务路由占位（后续填充）：
#   /chat        知芽AI老师 对话
#   /generate    智能出题
#   /grade       自动批改
#   /tools/*     MCP 教学工具调用
