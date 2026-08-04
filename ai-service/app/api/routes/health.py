from fastapi import APIRouter, status
from fastapi.responses import JSONResponse

from app.core.config import get_settings

router = APIRouter()


@router.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "learnly-ai-service"}


@router.get("/readyz")
async def readyz():
    s = get_settings()
    checks = {"llm_key": "configured" if s.llm_api_key else "missing"}
    ready = bool(s.llm_api_key)
    return JSONResponse(
        status_code=status.HTTP_200_OK if ready else status.HTTP_503_SERVICE_UNAVAILABLE,
        content={"status": "ready" if ready else "not-ready", "checks": checks},
    )
