// codex-rollout.js — Codex subagent 用量的 dispatch 时间窗归集（Issue !271 根因1）
//
// 背景：codex backend 无 Claude transcript，dispatch（mark-dispatch --end /
// record-usage）拿不到 subagent token，「AI 员工调度统计」codex 恒空。
// Codex 的 subagent 线程落盘为独立 rollout 文件（~/.codex/sessions/YYYY/MM/DD/
// rollout-*.jsonl），session_meta.thread_source='subagent'（旧版本或为
// source.subagent.thread_spawn 对象 / forked_from_id），事件 token_count 携带
// total_token_usage（生命周期累计）与 last_token_usage（单次增量）。
//
// 归集口径（与 daily-report/collect-ai.js collectCodexSessionTokens 一致，
// 即 !268/!276 的结论，勿在此单点发明新语义；两处为 skill 边界内联副本——
// 先例同 RESOLVED_SYNONYMS，改动需双向同步）：
//   - 文件首事件用 last（resume/fork 继承的历史不在 last 中）；total 按组件和封顶，
//     防 fork 首轮 auto-compact recompute 合成值计入
//   - 其后事件按 Δtotal（逐字段 max(0) 钳制，total Δ 组件和封顶）
//   - 只归集「session 创建于 dispatch 窗口内」的 subagent 文件（dispatch 派生的
//     子线程创建时刻必落在派生区间；跨窗口长活子线程按创建归属，不重复计）
//   - mtime < startMs 预过滤（创建 ts ≤ mtime，安全）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { debugLog } from './constants.js';

const DAY_MS = 24 * 3600 * 1000;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function codexSessionsRoot(override) {
  const raw = override || process.env.CODEX_HOME || join(homedir(), '.codex');
  return raw.replace(/\\/g, '/');
}

// subagent 识别：三种已知形状并集（codex 版本演进）
function isSubagentMeta(metaPayload) {
  if (!metaPayload || typeof metaPayload !== 'object') return false;
  if (metaPayload.thread_source === 'subagent') return true;
  if (metaPayload.source && typeof metaPayload.source === 'object'
      && metaPayload.source.subagent && metaPayload.source.subagent.thread_spawn) return true;
  if (typeof metaPayload.forked_from_id === 'string' && metaPayload.forked_from_id) return true;
  return false;
}

// 单文件 → {createdAtMs, model, agg} 或 null（非 subagent / 无事件 / 解析失败）
function readSubagentRollout(filePath) {
  let content;
  try { content = readFileSync(filePath, 'utf8'); } catch { return null; }
  const lines = content.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let meta = null;
  let model = null;
  const events = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const et = (entry.payload && typeof entry.payload === 'object' && entry.payload.type) || entry.type;
    if (et === 'session_meta') { meta = entry.payload; }
    else if (et === 'turn_context') {
      const mm = entry.payload && entry.payload.model;
      if (typeof mm === 'string' && mm) model = mm;
    } else if (et === 'token_count') {
      const info = entry.payload && entry.payload.info;
      if (info) events.push({ ts: entry.timestamp || null, last: info.last_token_usage || null, total: info.total_token_usage || null });
    }
  }
  if (!meta || !isSubagentMeta(meta)) return null;
  const createdAtMs = Date.parse(meta.timestamp || '');
  if (Number.isNaN(createdAtMs)) return null;

  const agg = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
  const models = {};
  let prevTotal = null;
  for (const ev of events) {
    if (ev.total && prevTotal !== null) {
      const d = {
        input: Math.max(0, num(ev.total.input_tokens) - num(prevTotal.input_tokens)),
        output: Math.max(0, num(ev.total.output_tokens) - num(prevTotal.output_tokens)),
        cached: Math.max(0, num(ev.total.cached_input_tokens) - num(prevTotal.cached_input_tokens)),
        cacheWrite: Math.max(0, num(ev.total.cache_write_input_tokens) - num(prevTotal.cache_write_input_tokens)),
      };
      agg.input += d.input; agg.output += d.output;
      agg.cached += d.cached; agg.cacheWrite += d.cacheWrite;
      agg.reasoning += Math.max(0, num(ev.total.reasoning_output_tokens) - num(prevTotal.reasoning_output_tokens));
    } else if (prevTotal === null) {
      const src = ev.last || ev.total;
      if (src) {
        // 首事件字段直接计入；total 组件和封顶语义（防合成值）在此场景仅影响
        // total 单值，本函数不产出 total，字段可信（合成样本 input/output 已清零 → 计 0）
        agg.input += num(src.input_tokens);
        agg.output += num(src.output_tokens);
        agg.cached += num(src.cached_input_tokens);
        agg.cacheWrite += num(src.cache_write_input_tokens);
        agg.reasoning += num(src.reasoning_output_tokens);
      }
    }
    if (ev.total) {
      const down = prevTotal !== null && num(ev.total.total_tokens) < num(prevTotal.total_tokens);
      if (!down) prevTotal = ev.total;
    }
    if (model) models[model] = (models[model] || 0) + num(ev.last && ev.last.input_tokens) + num(ev.last && ev.last.output_tokens);
  }
  return { createdAtMs, model: model || (Object.entries(models).sort((a, b) => b[1] - a[1])[0] || [null])[0], agg, empty: events.length === 0 };
}

/**
 * 按 [startedAt, completedAt] 窗口归集 codex subagent rollout 用量。
 * 返回与 extractZcodeSubagentTokenUsage 同形状（dispatch_history.token_usage 直接可存），
 * 无匹配 → null（调用方回退 --tokens / note）。
 */
export function extractCodexSubagentTokenUsage(startedAt, completedAt, opts = {}) {
  try {
    const startMs = startedAt != null ? Date.parse(startedAt) : NaN;
    const endMs = completedAt != null ? Date.parse(completedAt) : Date.now();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null; // 无界窗口不求和（防历史全量误采）

    const root = join(codexSessionsRoot(opts.codexHome), 'sessions');
    if (!existsSync(root)) return null;

    let input = 0, output = 0, cached = 0, cacheWrite = 0, reasoning = 0;
    const models = {};

    // 日期目录 ∈ [start-1d, end+1d]（目录按启动日归档，UTC/本地边界差一天冗余）
    const seen = new Set();
    for (let t = startMs - DAY_MS; t <= endMs + DAY_MS; t += DAY_MS) {
      const d = new Date(t);
      const y = String(d.getUTCFullYear());
      const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
      const da = String(d.getUTCDate()).padStart(2, '0');
      const dayDir = join(root, y, mo, da);
      if (seen.has(dayDir) || !existsSync(dayDir)) continue;
      seen.add(dayDir);
      let files;
      try { files = readdirSync(dayDir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = join(dayDir, f);
        try { if (statSync(fp).mtimeMs < startMs) continue; } catch { continue; }
        const r = readSubagentRollout(fp);
        if (!r || r.empty) continue;
        if (r.createdAtMs < startMs || r.createdAtMs > endMs) continue; // 创建归属
        input += r.agg.input; output += r.agg.output;
        cached += r.agg.cached; cacheWrite += r.agg.cacheWrite; reasoning += r.agg.reasoning;
        if (r.model) models[r.model] = (models[r.model] || 0) + r.agg.input + r.agg.output;
      }
    }

    if (input === 0 && output === 0 && cached === 0 && cacheWrite === 0) return null;
    const dominant = Object.entries(models).sort((a, b) => b[1] - a[1])[0];
    return {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: cacheWrite,
      reasoning_output_tokens: reasoning,
      model: dominant ? dominant[0] : 'unknown',
    };
  } catch (e) {
    debugLog('extractCodexSubagentTokenUsage failed —', e.message);
    return null;
  }
}
