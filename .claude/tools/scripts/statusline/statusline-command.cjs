'use strict';

// Claude Code status line — ported from statusline-command.sh.
// Layout (multi-line):
//   Line 1: path | vX.Y.Z | branch[dirty] sync-state
//   Line 2: model | token:in/out/Σ | cache:% | n/K(%) | HhMmin
//   sync-state: ✓sync | ↑N unpushed | ↓N unpulled | ↑N↓N diverged
//
// Reads JSON from stdin (Claude Code's statusline payload) and writes a single
// ANSI-colored line to stdout. Designed to be both a CLI entrypoint (run via
// `node statusline-command.js`) and a require-able module (pure helpers are
// exported for unit testing).
//
// All filesystem/git/usage state is best-effort: any failure degrades silently
// to omitting that segment, never crashes the line. The line is the user's
// primary visibility into model/context/cost — uptime matters more than
// perfection.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// --- ANSI ---
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

// --- Pure helpers (exported for testing) ---

// Format a non-negative token count as human-readable: "999", "1.5K", "1.5M".
// Returns "0" for missing/invalid input so the line never shows "undefined".
function formatTokens(v) {
  if (typeof v !== 'number' || !isFinite(v) || v < 0) return '0';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
  return String(Math.floor(v));
}

// Cache hit rate as an integer percent, or null when there are no input-side
// tokens to cache (avoids divide-by-zero and meaningless 0%).
//
// Hit rate = cache_read / (cache_read + input).
// input_tokens 已经是"未命中"的部分（Anthropic API 把 input/cached_input/cache_creation_input 三者分开计），分母用 cache_creation 是错的：cache_creation 是"本次写入缓存"，几乎永远是 0，会导致恒等于 100%。
function calcCacheRate(stats) {
  const cr = (stats && Number(stats.cache_read)) || 0;
  const input = (stats && Number(stats.input)) || 0;
  const total = cr + input;
  if (total <= 0) return null;
  return Math.round((cr * 100) / total);
}

// Aggregate usage.jsonl lines into {input, output, cache_read, cache_creation}.
//
// 过滤策略：
// - sessionIdFilter 提供：扫所有行（usage.jsonl 是 append-only，同 session 记录可能
//   散落在任何位置），只累加 session_id 匹配的行 → 显示"当前 session 真实消耗"
// - sessionIdFilter 缺失（老版 CC）：退化为最近 `limit` 行（默认 200），保持向后兼容
//
// Malformed lines 一律跳过（usage.jsonl 是 append-only，可能末尾有半行）。
function parseUsage(lines, limit = 200, sessionIdFilter) {
  const agg = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  if (!Array.isArray(lines) || lines.length === 0) return agg;
  const start = sessionIdFilter ? 0 : (lines.length > limit ? lines.length - limit : 0);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (sessionIdFilter && rec.session_id !== sessionIdFilter) continue;
    const t = (rec && rec.tokens) || {};
    agg.input += Number(t.input) || 0;
    agg.output += Number(t.output) || 0;
    agg.cache_read += Number(t.cache_read) || 0;
    agg.cache_creation += Number(t.cache_creation) || 0;
  }
  return agg;
}

// Aggregate transcript JSONL `.message.usage` into {input, output, cache_read, cache_creation}.
// transcript 的 usage 字段名与 usage.jsonl 不同（input_tokens / cache_read_input_tokens /
// cache_creation_input_tokens / output_tokens），这里映射到统一结构。Malformed 行跳过。
// 兼容 usage 嵌套在 .message.usage 或顶层 .usage 两种情况。
function parseTranscriptUsage(lines) {
  const agg = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  if (!Array.isArray(lines) || lines.length === 0) return agg;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const u = (rec && (rec.message ? rec.message.usage : rec.usage)) || null;
    if (!u) continue;
    agg.input += Number(u.input_tokens) || 0;
    agg.output += Number(u.output_tokens) || 0;
    agg.cache_read += Number(u.cache_read_input_tokens) || 0;
    agg.cache_creation += Number(u.cache_creation_input_tokens) || 0;
  }
  return agg;
}

// 读取 transcript 最后一条带 usage 的记录（最近一次 API 调用）。
// 用于推断"当前窗口实际装载量"：单次调用 input + cache_read + cache_creation，
// 避免用累计值导致状态栏 context 段失真（210% bug）。
// 失败/空文件返回 null，调用方回退到 payload。
function lastTranscriptUsage(transcriptFile) {
  if (!transcriptFile) return null;
  let lines;
  try {
    lines = fs.readFileSync(transcriptFile, 'utf-8').split(/\r?\n/);
  } catch (_) {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const u = rec && (rec.message ? rec.message.usage : rec.usage);
      if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) return u;
    } catch (_) { /* skip malformed */ }
  }
  return null;
}

// Aggregate usage.jsonl lines by `role` for the given session (子 agent 分类).
// 返回 { role: { count, input, output, cache_read } }，用于按子 agent 类别展示。
// sessionIdFilter 为空时不过滤（与 parseUsage 向后兼容策略一致）。Malformed 行跳过。
function parseUsageByRole(lines, sessionIdFilter) {
  const byRole = {};
  if (!Array.isArray(lines) || lines.length === 0) return byRole;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (sessionIdFilter && rec.session_id !== sessionIdFilter) continue;
    const role = (rec && rec.role) || 'unknown';
    const t = (rec && rec.tokens) || {};
    if (!byRole[role]) byRole[role] = { count: 0, input: 0, output: 0, cache_read: 0 };
    byRole[role].count += 1;
    byRole[role].input += Number(t.input) || 0;
    byRole[role].output += Number(t.output) || 0;
    byRole[role].cache_read += Number(t.cache_read) || 0;
  }
  return byRole;
}

// Model → context window size 映射。
// Claude Code payload 里 context_window_size 不分模型统一写 200000（包括 1M 窗口的
// glm-5.2 / claude-sonnet-4-x / gemini-2.5 等），导致 used_percentage 和 size 都失真。
// 这里覆盖主流模型；查表失败回退到 payload 的值。
//
// 匹配优先级：精确 → 前缀（按 key 长度降序匹配最长前缀，比如 'claude-sonnet-4-' 优先于 'claude-'）。
// 数据来源：各厂商 2026/06 官方文档（Claude 4.6 release notes、Gemini API docs、
// Qwen blog、Moonshot GitHub、DeepSeek API docs、智谱开放平台）。
const MODEL_CONTEXT_WINDOWS = {
  // ─── Anthropic Claude ───
  // 4.5+ 系列原生支持 1M context window
  'claude-opus-4-7':   1_000_000,
  'claude-opus-4-6':   200_000,
  'claude-sonnet-4-':  1_000_000,   // 前缀：4-5/4-6/4-7
  'claude-haiku-4-':   200_000,
  'claude-3-5-':       200_000,     // 前缀：3-5-sonnet/haiku
  'claude-3-opus':     200_000,
  'claude-3-haiku':    200_000,
  'claude-3-sonnet':   200_000,

  // ─── 智谱 GLM ───
  'glm-5.3':           1_000_000,
  'glm-5.2':           1_000_000,
  'glm-5.1':           204_800,
  'glm-5':             202_752,
  'glm-4.6':           128_000,
  'glm-4.5':           128_000,
  'glm-4-':            128_000,     // 前缀：glm-4-plus/air/flash 等

  // ─── Google Gemini ───
  'gemini-3-':         1_000_000,   // 前缀：gemini 3.x
  'gemini-2.5-pro':    1_000_000,
  'gemini-2.5-flash':  1_000_000,
  'gemini-2.0-':       1_000_000,   // 前缀
  'gemini-1.5-pro':    2_000_000,
  'gemini-1.5-flash':  1_000_000,

  // ─── 阿里 Qwen ───
  'qwen3.7-max':       1_000_000,
  'qwen3-max':         1_000_000,   // 可扩展到 1M
  'qwen3-':            256_000,     // 前缀：qwen3-coder/instruct 等
  'qwen2.5-':          128_000,     // 前缀

  // ─── Moonshot Kimi ───
  'kimi-k2.5':         256_000,
  'kimi-k2.6':         256_000,
  'kimi-k2':           128_000,
  'moonshot-v1-':      128_000,     // 前缀：moonshot-v1-8k/32k/200k（API 限速有差异）

  // ─── DeepSeek ───
  'deepseek-v4-pro':   1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-':      1_000_000,   // 前缀：v4 系列兜底
  'deepseek-v3':       128_000,
  'deepseek-r1':       128_000,
  'deepseek-chat':     128_000,

  // ─── OpenAI GPT ───
  'gpt-4o':            128_000,
  'gpt-4-turbo':       128_000,
  'gpt-4':             8_192,

  // ─── xAI Grok ───
  'grok-4':            256_000,
  'grok-3':            128_000,

  // ─── 美图 LongCat ───
  // LongCat-2.0 文档（https://longcat.chat/platform/docs/zh/）：上下文长度 1M，最大输出 128K。
  'longcat-2.0':       1_000_000,
  'longcat-':          1_000_000,   // 前缀兜底未来版本

  // ─── 腾讯混元 hy3 ───
  'hy3':               256_000,
};

// 用 model.id 查真实 context window。找不到返回 0（调用方回退到 payload）。
// Issue !192: payload model.id 可能是 PascalCase（如 GLM-5.2、GPT-4o），
// 表 keys 全小写，大小写不敏感匹配避免回退到 200K 失真。
// 匹配策略（优先级降序）：
//   1. 精确匹配（大小写不敏感）
//   2. 前缀匹配（最长前缀优先，大小写不敏感）
//   3. 包含匹配（最长关键字优先，大小写不敏感）— 包含模型名称关键字即算匹配
function lookupContextWindow(modelId) {
  if (!modelId || typeof modelId !== 'string') return 0;
  const lowerId = modelId.toLowerCase();
  // 精确匹配（大小写不敏感）
  for (const k of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (k.toLowerCase() === lowerId) return MODEL_CONTEXT_WINDOWS[k];
  }
  // 前缀匹配（最长前缀优先，大小写不敏感）
  const prefixes = Object.keys(MODEL_CONTEXT_WINDOWS)
    .filter((k) => k.endsWith('-'))
    .sort((a, b) => b.length - a.length);
  for (const p of prefixes) {
    if (lowerId.startsWith(p.toLowerCase())) return MODEL_CONTEXT_WINDOWS[p];
  }
  // 包含匹配（最长关键字优先，大小写不敏感）
  // 将 table keys 按长度降序，检查 modelId 是否包含该 key
  // 对尾部带 - 的 key，也检查去除 - 后的包含关系（如 "claude-sonnet-4" 匹配 "claude-sonnet-4-"）
  const allKeys = Object.keys(MODEL_CONTEXT_WINDOWS)
    .sort((a, b) => b.length - a.length);
  for (const k of allKeys) {
    const keyLower = k.toLowerCase();
    if (lowerId.includes(keyLower)) return MODEL_CONTEXT_WINDOWS[k];
    if (keyLower.endsWith('-') && lowerId.includes(keyLower.slice(0, -1))) {
      return MODEL_CONTEXT_WINDOWS[k];
    }
  }
  return 0;
}

// Context-window segment, color-coded by usage: green <70%, yellow 70-89%, red ≥90%.
// Returns '' when no reliable usage data is available.
//
// 数据源优先级（修复 210% 失真 bug）：
//   1. transcript 最后一条 message.usage（真实窗口占用 = input + cache_read + cache_creation）
//      — 这是最后一次 API 调用"装入"窗口的内容，cache_read 只算一次（不像 payload 累计）。
//   2. payload context_window.total_input_tokens（CodeBuddy 注入）
//      — 实测含累计 cache_read，长会话+高缓存命中率时会远超真实窗口（210% bug 根因），
//        仅在无 transcript 时兜底。
//   3. payload context_window.used_percentage × realSize
//
// 旧版直接用 payload total_input_tokens，未扣除累计 cache_read；当缓存命中率高
// （本仓库常态 98%）时会显示 200%+。改用 transcript 单次 API 调用避免重复累加。
function buildContextDisplay(ctx, modelId, lastUsage) {
  if (!ctx && !lastUsage) return '';
  const payloadSize = Number(ctx && ctx.context_window_size) || 0;
  const realSize = lookupContextWindow(modelId) || payloadSize;
  if (realSize <= 0) return '';

  let usedTokens = 0;
  // 优先：transcript 最后一条 usage 的 input + cache_read + cache_creation
  // cache_read 是窗口内已存在的命中部分，cache_creation 是本次新写入，
  // input 是本次未命中：三者之和 = 本次调用窗口实际装载量。
  if (lastUsage) {
    usedTokens = (Number(lastUsage.input_tokens) || 0)
      + (Number(lastUsage.cache_read_input_tokens) || 0)
      + (Number(lastUsage.cache_creation_input_tokens) || 0);
  }
  let pct;
  if (usedTokens > 0) {
    pct = Math.round((usedTokens / realSize) * 100);
  } else if (ctx && isFinite(Number(ctx.total_input_tokens)) && Number(ctx.total_input_tokens) > 0) {
    // 回退 1：payload total_input_tokens（已知失真，仅无 transcript 时用）
    usedTokens = Number(ctx.total_input_tokens);
    pct = Math.round((usedTokens / realSize) * 100);
  } else if (ctx && ctx.used_percentage != null) {
    // 回退 2：payload 百分比 × realSize
    pct = Math.round(Number(ctx.used_percentage));
    usedTokens = Math.round(realSize * pct / 100);
  } else {
    return '';
  }

  // 整数显示不带 ".0"：1.0M → 1M，80.0K → 80K，1.5K → 1.5K
  const trimZero = (s) => s.replace(/\.0([MK])/, '$1');
  const usedD = trimZero(formatTokens(usedTokens));
  const sizeD = trimZero(formatTokens(realSize));
  const color = pct >= 90 ? RED : pct >= 70 ? YELLOW : GREEN;
  return `${color}ctx:${usedD}/${sizeD}(${pct}%)${RESET}`;
}

// Elapsed-wall-clock formatting: "Ss", "Mmin", "HhMmin", "DdHhMmin".
// Returns '' if inputs are missing/inverted so a brand-new session doesn't
// show negative durations.
function buildDuration(startMs, nowMs) {
  if (!startMs || !nowMs || nowMs < startMs) return '';
  const elapsed = Math.floor((nowMs - startMs) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const d = Math.floor(elapsed / 86400);
  const h = Math.floor((elapsed % 86400) / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  if (d > 0) return `${d}d${h}h${m}min`;
  if (h > 0) return `${h}h${m}min`;
  return `${m}min`;
}

// ── 工作流状态段（Line 3：⚡生成速度 + 🔐待审批 + ⚙️rd-auto 阶段，全部瞬态）──

// 生成速度：transcript 尾部若干条 usage 记录的 output_tokens 合计 / 时间跨度（tok/s）。
// 跨度含中间工具执行时间 → 保守低估，作感知用非计量。数据不足（<2 条）/
// 时间戳缺失 / 跨度 <1s（精度抖动）返回 null。
function calcGenSpeed(entries) {
  if (!Array.isArray(entries) || entries.length < 2) return null;
  const tail = entries.slice(-5);
  let outTok = 0;
  for (const e of tail) outTok += Number(e && e.output_tokens) || 0;
  const first = Date.parse(tail[0].timestamp);
  const last = Date.parse(tail[tail.length - 1].timestamp);
  if (!first || !last || last <= first) return null;
  const secs = (last - first) / 1000;
  if (secs < 1) return null;
  return Math.round(outTok / secs);
}

// 待审批段：push / 分支挑战码文件存在时红字提醒。
// 审批完成后 session-start 清理挑战文件 → 自动消失（瞬态）。
function buildApprovalDisplay({ pushPending, branchPending } = {}) {
  const parts = [];
  if (pushPending) parts.push(`${RED}🔐待push审批${RESET}`);
  if (branchPending) parts.push(`${RED}🔐待分支审批${RESET}`);
  return parts.join('·');
}

// rd-auto pipeline 阶段段：mtime 最新且非终态的 change → `⚙️<change>:<phase>`。
// 全部终态（completed/archived）→ ''（没有进行中的流程就不占行，瞬态）。
const PIPELINE_TERMINAL_PHASES = new Set(['completed', 'archived']);
function buildPipelineDisplay(states) {
  if (!Array.isArray(states) || states.length === 0) return '';
  const active = states
    .filter((s) => s && s.phase && !PIPELINE_TERMINAL_PHASES.has(String(s.phase).toLowerCase()))
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  if (active.length === 0) return '';
  const top = active[0];
  return `${YELLOW}⚙️${top.change}:${top.phase}${RESET}`;
}

// 剥除 ANSI 转义后的显示宽度估算：emoji / CJK（码点 ≥0x1100）按 2 列，VS16 不占宽。
// 状态栏内容可控（emoji + 中文 + ASCII），粗粒度规则够用；精确东亚宽度表不值得引入。
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function displayWidth(s) {
  if (!s) return 0;
  let w = 0;
  for (const ch of String(s).replace(ANSI_RE, '')) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f) continue; // variation selector：与前一字符合成一个 emoji，不占宽
    w += cp >= 0x1100 ? 2 : 1;
  }
  return w;
}

// 超终端宽度时按显示宽度截断加 …（防溢出错乱；正常路径不触发，兜底用）。
// '…'（U+2026 ≥0x1100）按本模块宽度规则占 2 列，截断预算含省略号自身宽度。
function truncateDisplayWidth(s, max) {
  if (!s) return s || '';
  if (max <= 0 || displayWidth(s) <= max) return s;
  const ELLIPSIS_W = 2;
  let w = 0;
  let out = '';
  for (const ch of String(s).replace(ANSI_RE, '')) {
    const cp = ch.codePointAt(0);
    const cw = cp === 0xfe0f ? 0 : cp >= 0x1100 ? 2 : 1;
    if (w + cw + ELLIPSIS_W > max) return out + '…';
    out += ch;
    w += cw;
  }
  return out;
}

// Read the first line of .harness/.harness-version (Uni-AURI framework version).
// Returns '' when the file is missing or unreadable — this is a best-effort segment.
function buildHarnessVersion(cwd) {
  try {
    const verFile = path.join(cwd, '.harness', '.harness-version');
    const raw = fs.readFileSync(verFile, 'utf-8');
    const firstLine = raw.split(/\r?\n/)[0].trim();
    if (!firstLine) return '';
    return `${CYAN}v${firstLine}${RESET}`;
  } catch (_) {
    return '';
  }
}

// --- Best-effort I/O helpers (not exported — side-effectful) ---

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (_) {
    return '';
  }
}

function buildGitDisplay(cwd) {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch) return { git: '', sync: '' };

  const status = runGit(['status', '--porcelain'], cwd);
  const dirtyCount = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
  const dirtyMark = dirtyCount > 0 ? `${RED}✗${dirtyCount}${RESET}` : `${GREEN}✓${RESET}`;
  const git = `${BOLD}${branch}${RESET}${dirtyMark}`;

  // ahead/behind upstream
  let sync = '';
  const upstream = runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd);
  if (upstream) {
    const ab = runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd);
    const m = (ab || '').match(/^(\d+)\s+(\d+)$/);
    if (m) {
      const ahead = m[1];
      const behind = m[2];
      const aheadN = ahead !== '0';
      const behindN = behind !== '0';
      if (aheadN && behindN) {
        sync = `${YELLOW}↑${ahead}↓${behind} diverged${RESET}`;
      } else if (aheadN) {
        sync = `${YELLOW}↑${ahead} unpushed${RESET}`;
      } else if (behindN) {
        sync = `${YELLOW}↓${behind} unpulled${RESET}`;
      } else {
        sync = `${GREEN}✓sync${RESET}`;
      }
    }
  }
  return { git, sync };
}

// buildMainUsageDisplay: 主对话 token 段（来自 transcript .message.usage）。
// 返回单个状态栏段字符串，如 "👤in393K/out239K·♻️18.8M·98%"；无数据返回 ''。
// 主对话是主会话与 API 的往返，不含子 agent dispatch（子 agent 见 buildAgentUsageDisplay）。
function buildMainUsageDisplay(transcriptFile) {
  if (!transcriptFile) return '';
  let lines = [];
  try {
    lines = fs.readFileSync(transcriptFile, 'utf-8').split(/\r?\n/);
  } catch (_) {
    return '';
  }
  const agg = parseTranscriptUsage(lines);
  if (agg.input <= 0 && agg.output <= 0 && agg.cache_read <= 0 && agg.cache_creation <= 0) return '';

  const inD = formatTokens(agg.input);
  const outD = formatTokens(agg.output);
  let seg = `👤in${GREEN}${inD}${RESET}/out${YELLOW}${outD}${RESET}`;
  // 缓存读量 + 命中率：cache_read 是大头（本仓库常见 ~16× input），
  // 单独展示避免并入累计虚高；命中率复用 calcCacheRate。
  const rate = calcCacheRate(agg);
  if (agg.cache_read > 0 || rate != null) {
    seg += `·♻️${CYAN}${formatTokens(agg.cache_read)}`;
    if (rate != null) seg += `·${rate}%`;
    seg += RESET;
  }
  return seg;
}

// buildAgentUsageDisplay: 子 agent dispatch 用量段（来自 usage.jsonl，按 role 聚合）。
// 返回 Line 3 字符串，如 "└ 🤖 explore×2 147K→46K · developer×1 50K→8K"；无 dispatch 返回 ''。
function buildAgentUsageDisplay(usageFile, sessionId) {
  let lines = [];
  try {
    lines = fs.readFileSync(usageFile, 'utf-8').split(/\r?\n/);
  } catch (_) {
    return '';
  }
  const byRole = parseUsageByRole(lines, sessionId);
  const roles = Object.keys(byRole);
  if (roles.length === 0) return '';
  // 按 output 降序，主要角色在前
  roles.sort((a, b) => byRole[b].output - byRole[a].output);
  const parts = roles.map((role) => {
    const r = byRole[role];
    return `${role}×${r.count} ${formatTokens(r.input)}→${formatTokens(r.output)}`;
  });
  return `└ 🤖 ${parts.join(' · ')}`;
}

// Resolve the current session's transcript JSONL path.
//
// CC passes `session_id` in the statusline stdin payload. The JSONL at
// ~/.claude/projects/<slug>/<session_id>.jsonl is THIS session's transcript
// (one file per session, filename IS sessionId). Returns null when the file
// doesn't exist (fresh session) or cwd is missing.
//
// Issue !209: 同时探测 Claude Code (~/.claude) 和 CodeBuddy (~/.codebuddy) 两个后端，
// 按各自 slug 规则查找。Claude Code: 全量替换非字母数字为 '-'；CodeBuddy: 仅盘符小写 + 其余替换。
function resolveTranscriptFile(cwd, sessionId) {
  if (!cwd) return null;

  // Claude Code slug 规则：全量替换非字母数字为 '-'
  // 如 D:\Claude\NCFA → D--Claude-NCFA
  const ccSlug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  // CodeBuddy slug 规则：仅盘符小写 + 其余替换
  // 如 D:\Claude\NCFA → d-Claude-NCFA
  const cbSlug = cwd.replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':').replace(/[^a-zA-Z0-9]/g, '-');

  const backends = [
    { base: '.claude', slug: ccSlug },
    { base: '.codebuddy', slug: cbSlug },
  ];

  for (const { base, slug } of backends) {
    const projectsDir = path.join(os.homedir(), base, 'projects');
    if (!fs.existsSync(projectsDir)) continue;

    if (sessionId) {
      // sessionId 给定：精确查找该 session 的 transcript
      const direct = path.join(projectsDir, slug, `${sessionId}.jsonl`);
      if (fs.existsSync(direct)) return direct;
    } else {
      // sessionId 缺失：回退到最新修改的 jsonl
      const sessionDir = path.join(projectsDir, slug);
      if (fs.existsSync(sessionDir)) {
        try {
          const files = fs.readdirSync(sessionDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => {
              const full = path.join(sessionDir, f);
              const st = fs.statSync(full);
              return { f: full, mtime: st.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length) return files[0].f;
        } catch (_) { /* ignore */ }
      }
    }
  }

  return null;
}

// Find the start time of the CURRENT session in ms, from its transcript.
// The first timestamped line is the session start — robust across filesystems
// that lack birthtime, survives copy/move, and correctly reflects "time since
// this session window opened" (not since some other session in the same project).
function findSessionStartMs(transcriptFile) {
  if (!transcriptFile) return 0;

  // Read the first timestamped event. Lines without `timestamp`
  // (e.g. `mode`, `permission-mode`) are skipped.
  try {
    const fd = fs.openSync(transcriptFile, 'r');
    let buf = '';
    const chunk = Buffer.alloc(8192);
    let startMs = 0;
    while (true) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      buf += chunk.subarray(0, n).toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const d = JSON.parse(line);
          if (d.timestamp) {
            startMs = Date.parse(d.timestamp);
            break;
          }
        } catch (_) { /* skip malformed */ }
      }
      if (startMs) break;
    }
    fs.closeSync(fd);
    if (startMs) return startMs;
    // No timestamp in the file yet — happens when a fresh session was just
    // opened (only `mode`/`permission-mode` lines so far). Fall back to the
    // file's mtime: for a newly-created jsonl this IS the session start time.
    return fs.statSync(transcriptFile).mtimeMs;
  } catch (_) {
    return 0;
  }
}

// 收集 transcript 尾部带 usage 的记录（时间升序 {timestamp, output_tokens}），供 calcGenSpeed。
function collectRecentUsageWithTime(transcriptFile, limit = 6) {
  if (!transcriptFile) return [];
  let lines;
  try {
    lines = fs.readFileSync(transcriptFile, 'utf-8').split(/\r?\n/);
  } catch (_) {
    return [];
  }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const u = rec && (rec.message ? rec.message.usage : rec.usage);
      if (u && u.output_tokens != null) out.push({ timestamp: rec.timestamp, output_tokens: u.output_tokens });
    } catch (_) { /* skip malformed */ }
  }
  return out.reverse();
}

// 工作流状态 I/O（best-effort）：审批挑战码文件存在性 + rd-auto pipeline-state 汇总。
// 挑战码只查 .harness/ 主位置（旧 backend 目录残留由 session-start 启动时清理）。
function buildWorkflowDisplay(cwd) {
  let approval = '';
  try {
    approval = buildApprovalDisplay({
      pushPending: fs.existsSync(path.join(cwd, '.harness', '.push-challenge')),
      branchPending: fs.existsSync(path.join(cwd, '.harness', '.branch-challenge')),
    });
  } catch (_) { /* best-effort */ }

  let pipeline = '';
  try {
    const tasksDir = path.join(cwd, '.harness', 'tasks');
    if (fs.existsSync(tasksDir)) {
      const states = [];
      for (const name of fs.readdirSync(tasksDir)) {
        const f = path.join(tasksDir, name, 'pipeline-state.json');
        try {
          const st = fs.statSync(f);
          const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
          states.push({ change: rec.change_name || name, phase: rec.current_phase, mtimeMs: st.mtimeMs });
        } catch (_) { /* skip unreadable */ }
      }
      pipeline = buildPipelineDisplay(states);
    }
  } catch (_) { /* best-effort */ }
  return { approval, pipeline };
}

// --- Helper: terminal width detection ---

// 检测终端宽度
function getTerminalWidth() {
  // 优先从环境变量读取（兼容 tput）
  const envWidth = process.env.COLUMNS || process.stdout.columns;
  if (envWidth) return parseInt(envWidth, 10) || 80;
  return 80; // 默认值
}

// --- Main assembly ---

function main(input) {
  input = input || {};
  const cwd = (input.workspace && input.workspace.current_dir) || process.cwd();
  const model = (input.model && (input.model.display_name || input.model.id)) || 'unknown';
  const modelId = (input.model && input.model.id) || '';

  // 检测终端宽度
  const termWidth = getTerminalWidth();

  const { git, sync } = buildGitDisplay(cwd);
  // 主对话 token 来自 transcript；子 agent dispatch 来自 usage.jsonl（按 role）
  const transcriptFile = resolveTranscriptFile(cwd, input.session_id);
  const mainUsage = buildMainUsageDisplay(transcriptFile);
  const usageFile = path.join(os.homedir(), '.claude', 'usage', 'usage.jsonl');
  const agentUsage = buildAgentUsageDisplay(usageFile, input.session_id);
  // context 段用 transcript 最后一次 API 调用的真实占用，避免 payload total_input_tokens
  // 含累计 cache_read 导致的百分比失真（210% bug）
  const lastUsage = lastTranscriptUsage(transcriptFile);
  let ctx = buildContextDisplay(input.context_window, modelId, lastUsage);
  if (ctx) ctx = ctx.replace('ctx:', '');
  const startMs = findSessionStartMs(transcriptFile);
  const dur = buildDuration(startMs, Date.now());

  const harnessVer = buildHarnessVersion(cwd);

  // 工作流状态段（Line 3，全瞬态）：⚡生成速度常态显示，🔐审批 / ⚙️pipeline 有内容才出现
  const speed = calcGenSpeed(collectRecentUsageWithTime(transcriptFile));
  const speedSeg = speed ? `${CYAN}⚡${speed}tok/s${RESET}` : '';
  const { approval, pipeline } = buildWorkflowDisplay(cwd);

  // 窄屏模式（<70字符）：每项独立一行，保留所有信息
  if (termWidth < 70) {
    const lines = [];

    // 第1行：路径
    lines.push(`${BOLD}${cwd}${RESET}`);

    // 第2行：分支 + 同步状态
    const gitLine = [];
    if (harnessVer) gitLine.push(harnessVer);
    if (git) gitLine.push(git);
    if (sync) gitLine.push(sync);
    if (gitLine.length) lines.push(gitLine.join(' · '));

    // 第3行：模型
    lines.push(`🤖 ${model}`);

    // 第4行：主对话 token
    if (mainUsage) lines.push(mainUsage);

    // 第5行：上下文
    if (ctx) lines.push(`📊 ${ctx}`);

    // 第6行：时长
    if (dur) lines.push(`⏱️ ${dur}`);

    // 第7-9行：生成速度 / 待审批 / pipeline 阶段（各占一行）
    if (speedSeg) lines.push(speedSeg);
    if (approval) lines.push(approval);
    if (pipeline) lines.push(pipeline);

    // 第10行：子 agent 用量
    if (agentUsage) lines.push(agentUsage);

    return lines.join('\n');
  }

  // 宽屏模式（≥70字符）：紧凑显示，用 | 分隔
  const sep = ` ${BOLD}|${RESET} `;

  // Line 1: project metadata
  const line1Parts = [cwd];
  if (harnessVer) line1Parts.push(harnessVer);
  if (git) line1Parts.push(git);
  if (sync) line1Parts.push(sync);

  // Line 2: model + 主对话 token + context + duration
  const line2Parts = [];
  line2Parts.push(`🤖 ${model}`);
  if (mainUsage) line2Parts.push(mainUsage);
  if (ctx) line2Parts.push(`📊 ${ctx}`);
  if (dur) line2Parts.push(`⏱️ ${dur}`);

  const line1 = line1Parts.join(sep);
  const line2 = line2Parts.join(sep);

  // 组装：line1 必有；line2 至少含 model 段；line3 工作流状态（全空则整行省略）；
  // line4 仅在有子 agent dispatch 时追加。末尾按终端宽度兜底截断（防溢出错乱）。
  const line3Parts = [speedSeg, approval, pipeline].filter(Boolean);

  let out = line1;
  if (line2Parts.length) out += `\n${line2}`;
  if (line3Parts.length) out += `\n${line3Parts.join(sep)}`;
  if (agentUsage) out += `\n${agentUsage}`;
  return out.split('\n').map((l) => truncateDisplayWidth(l, termWidth)).join('\n');
}

// --- Entrypoint ---

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let input = {};
    if (raw.trim()) {
      try { input = JSON.parse(raw); } catch (_) { /* degrade to empty */ }
    }
    try {
      process.stdout.write(main(input));
    } catch (e) {
      // Never crash the statusline — emit a minimal line so the user still
      // sees something. Full failure mode goes to stderr for debugging.
      process.stderr.write(`[statusline] error: ${e.message}\n`);
      process.stdout.write('statusline error');
    }
  });
}

module.exports = {
  formatTokens,
  calcCacheRate,
  parseUsage,
  parseTranscriptUsage,
  parseUsageByRole,
  buildContextDisplay,
  buildDuration,
  lookupContextWindow,
  resolveTranscriptFile,
  calcGenSpeed,
  buildApprovalDisplay,
  buildPipelineDisplay,
  displayWidth,
  truncateDisplayWidth,
};
