# Mixed Backend Usage Test Fixture

Used by:
- `.claude/tools/scripts/tests/test_usage_report_backend_e2e.mjs`

## pipeline-state.json

混合 backend 的 pipeline dispatch_history：
- claude dispatch (input=1000, output=100, cache_read=500, model=claude-sonnet-4-6)
- codex dispatch (total=30000)
- claude dispatch **无 backend 字段**（向前兼容测试，应被兜底为 claude）

## usage.jsonl

自然触发（natural）条目：
- claude natural dispatch (input=2000, output=200, cache_read=1000)
- codex natural dispatch (total=15000)

## 期望行为

调用 `recalcTokens` 后 `token_summary.by_backend`：
- `claude.input_tokens = 1500`（1000 + 500，第三条无 backend 兜底为 claude）
- `claude.cached_tokens = 700`（500 + 200）
- `claude.dispatch_count = 2`
- `codex.total_tokens = 30000`
- `codex.input_tokens = null`（稀疏）
- `codex.dispatch_count = 1`
- `backend_fallback_count = 1`（第三条无 backend）

调用 `computeStats` 后 `stats.by_backend` 累加多 task。
