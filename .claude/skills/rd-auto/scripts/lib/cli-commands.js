// lib/cli-commands.js — All CLI command implementations and helpers
import { readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync, mkdirSync, existsSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  PROJECT_ROOT, RULES_PATH, CLAUDE_DIR, ROLE_AGENT_MAP,
  errExit, output, debugLog, parseArgs, getArg
} from './constants.js';
import {
  stateInit, stateLoad, stateSave, getTasksDir, writeCheckpoint,
  stateListActive, stateListAll, getPipelinePhases, getCountedPhases
} from './state-store.js';
import { parseRules, loadRulesYaml } from './transitions.js';
import { advance, getRole, getPreviousSummary, resolveQuickFlowRole, scoreRoleKey } from './advance.js';
import { formatDuration, computeStats, computeAdvancedStats } from './stats.js';
import { parseTasksMd as parseTasksMdFn } from './fanout.js';
import { assembleContextPack, expandAgentIncludes, recommendMode } from './context-pack.js';
import { getBackendInfo } from './backend.js';
import { filterConcernsByStatus, normalizeConcerns, resolveConcernById } from './concerns.js';
import { extractCodexSubagentTokenUsage } from './codex-rollout.js';

// ─── Transcript Token Extraction ───

function findTranscriptPath() {
  // 兼容 claude code / codebuddy 的 session id 环境变量
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
    || process.env.CODEBUDDY_SESSION_ID
    || process.env.CLAUDE_SESSION_ID;
  if (!sessionId) return null;
  const cwd = process.env.PROJECT_ROOT || process.cwd();
  const projectSlug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  // HARNESS_PROJECTS_DIR 由 hook 前缀注入（可能含字面 $HOME，需展开）；未设则回退 ~/.claude/projects
  const projectsDir = process.env.HARNESS_PROJECTS_DIR
    ? process.env.HARNESS_PROJECTS_DIR.replace(/\$HOME/g, homedir())
    : join(process.env.HOME || '/root', '.claude', 'projects');
  const candidates = [
    join(projectsDir, projectSlug, `${sessionId}.jsonl`),
    join(projectsDir, projectSlug, 'tool-results', `${sessionId}.jsonl`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback: 不同后端（如 CodeBuddy Code）的 project slug 算法可能不同（保留下划线等），
  // 按 harness slug 找不到时，扫描 projectsDir 下所有子目录匹配 session 文件（session id 唯一，安全）。
  try {
    for (const sub of readdirSync(projectsDir)) {
      const p = join(projectsDir, sub, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch (e) { debugLog('findTranscriptPath fallback scan failed —', e.message); }
  return null;
}

function countTranscriptLines(transcriptPath) {
  try {
    const content = readFileSync(transcriptPath, 'utf8');
    return content.split('\n').filter(Boolean).length;
  } catch (e) {
    debugLog('countTranscriptLines failed —', e.message);
    return 0;
  }
}

function extractTokenUsage(transcriptPath, startLine) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const content = readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    if (startLine >= lines.length) return null;

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let models = {};

    // 同一 assistant 消息的 usage 去重键（message.id）。
    //
    // Claude Code 在**流式响应过程中会把同一条消息多次落盘**——同一 message.id 出现
    // 2~4 次（timestamp 差数百毫秒、usage 完全相同）。逐行累加会把同一次 API 调用
    // 重复计入：实测现场该会话 cache_read 未去重 419,785,472 / 去重后 159,302,528，
    // 虚高 2.57×，直接抬高了日报「AI 员工调度统计」的 main-session 行。
    //
    // 去重范围限于本次 [startLine, end) 区间：偏移窗口之间的同一 id 不会重复出现
    // （窗口只前进、不重叠），故无需跨调用保持状态。
    // 无 message.id 的条目无法判重，按原样计入（不因缺字段丢量）。
    const seenUsageMsgIds = new Set();

    for (let i = startLine; i < lines.length; i++) {
      try {
        const obj = JSON.parse(lines[i]);
        const u = obj.message?.usage;
        if (!u) continue;
        const msgId = obj.message?.id;
        if (msgId) {
          if (seenUsageMsgIds.has(msgId)) continue;
          seenUsageMsgIds.add(msgId);
        }
        // model 字段兼容：Claude Code 在 message.model；CodeBuddy Code 在 providerData.model
        const model = obj.message?.model || obj.providerData?.model || 'unknown';
        inputTokens += u.input_tokens || 0;
        outputTokens += u.output_tokens || 0;
        cacheReadTokens += u.cache_read_input_tokens || 0;
        cacheCreationTokens += u.cache_creation_input_tokens || 0;
        models[model] = (models[model] || 0) + (u.input_tokens || 0) + (u.output_tokens || 0);
      } catch (e) { debugLog('extractTokenUsage: line parse failed —', e.message); }
    }

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) return null;
    const dominantModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0];

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      model: dominantModel ? dominantModel[0] : 'unknown',
    };
  } catch (e) {
    debugLog('extractTokenUsage failed —', e.message);
    return null;
  }
}

// ─── Subagent Transcript Token Extraction (issue !193) ───
//
// Claude backend pipeline dispatch 的子 agent（主会话 Agent 工具调用触发）token 落在
// 独立 transcript：projects/<slug>/<sessionId>/subagents/agent-*.jsonl。主会话 transcript
// 在 dispatch 期间无新 usage，extractTokenUsage 返回 null，致 by_backend 桶全空。
//
// 本函数从主会话 transcript 路径推导 subagents 目录，扫描 mtime ≥ startedAt 的子 agent
// transcript，累加 usage。格式与主会话 transcript 一致（message.usage.*），解析逻辑复用。
//
// 并发假设：pipeline 同 phase 串行（--start → Agent → --end → advance），不并发。
// fanout 走独立 wrapper（fanout-dispatch-agent.js），不经此 fallback。
//
// Reviewer P1 约束：try/catch 包裹 + existsSync 守卫，失败静默 return null 不阻塞 mark-dispatch
export function extractSubagentTokenUsage(mainTranscriptPath, startedAt) {
  try {
    if (!mainTranscriptPath) return null;
    // 推导：projects/<slug>/<sessionId>.jsonl → projects/<slug>/<sessionId>/subagents/
    const dir = dirname(mainTranscriptPath);
    const sessionId = basename(mainTranscriptPath, '.jsonl');
    const subagentsDir = join(dir, sessionId, 'subagents');
    if (!existsSync(subagentsDir)) return null;  // CodeBuddy 等结构未验证，静默 fallback

    const files = readdirSync(subagentsDir)
      .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));
    if (files.length === 0) return null;

    // mtime 过滤：只算 dispatch startedAt 之后修改的子 agent transcript
    const startedMs = startedAt ? new Date(startedAt).getTime() : 0;
    const candidateFiles = files.filter(f => {
      try {
        const st = statSync(join(subagentsDir, f));
        return st.mtimeMs >= startedMs;
      } catch (_) {
        return false;
      }
    });
    if (candidateFiles.length === 0) return null;

    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
    const models = {};

    for (const f of candidateFiles) {
      try {
        const content = readFileSync(join(subagentsDir, f), 'utf8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch (_) { continue; }
          const u = obj.message?.usage;
          if (!u) continue;
          const model = obj.message?.model || 'unknown';
          inputTokens += u.input_tokens || 0;
          outputTokens += u.output_tokens || 0;
          cacheReadTokens += u.cache_read_input_tokens || 0;
          cacheCreationTokens += u.cache_creation_input_tokens || 0;
          models[model] = (models[model] || 0) + (u.input_tokens || 0) + (u.output_tokens || 0);
        }
      } catch (_) { /* 单文件失败跳过，继续其他文件 */ }
    }

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
      return null;  // 容错：LongCat 等模型 usage 为空 {} 或全 0
    }
    const dominantModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0];
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      model: dominantModel ? dominantModel[0] : 'unknown',
    };
  } catch (e) {
    debugLog('extractSubagentTokenUsage failed —', e.message);
    return null;
  }
}

// ─── ZCode model-io Token Extraction (issues #277/#282) ───
//
// ZCode 本地逐次调用日志：~/.zcode/cli/rollout/model-io-sess_<sessionId>.jsonl，每行一次
// 模型调用（camelCase schema，2026-09-08 本机实测）：
//   { startedAt, completedAt, model:{modelId, role, ...}, response:{usage:{
//     inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens }},
//     sessionId, querySource, ... }
// request 字段含完整请求体（数百 KB/行），解析后只取 usage/model/时间戳，request 即刻丢弃。
//
// subagent 布局两种并存，归因一律看记录级字段、不能只认文件名：
//   - 独立文件：model-io-sess_subagent_agent_<uuid>.jsonl（querySource:"subagent"）
//   - 混在主会话文件：同 sessionId 下的 querySource:"subagent" 记录（limt 机器实测布局）
//
// ⚠ keep-in-sync：与 collect-ai.js 的 parseZcodeModelIoRecord 保持同步（collect-ai 是
// CJS、本文件 ESM，不共享 import，参照 !259 RESOLVED_SYNONYMS 内联副本模式）；
// tests/zcode-modelio.test.mjs 做漂移对账。

export function parseZcodeModelIoRecord(line) {
  let obj;
  try { obj = JSON.parse(line); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const usage = obj.response && obj.response.usage;
  if (!usage || typeof usage !== 'object') return null;
  const startedMs = Date.parse(obj.startedAt);
  if (Number.isNaN(startedMs)) return null; // 无 startedAt 无法归档时间
  // 缺 completedAt 按起点时刻的点事件处理（时间窗重叠判定仍可用）
  const completedRaw = obj.completedAt != null ? Date.parse(obj.completedAt) : NaN;
  const completedMs = Number.isNaN(completedRaw) ? startedMs : completedRaw;
  return {
    started_at_ms: startedMs,
    completed_at_ms: completedMs,
    input_tokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
    output_tokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
    cache_read_input_tokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0,
    cache_creation_input_tokens: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0,
    total_tokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : 0,
    model: (obj.model && typeof obj.model.modelId === 'string') ? obj.model.modelId : null,
    // 归因隔离信号：querySource 与 model.role 任一标记 subagent 即算（两种布局并存，不能只认一个）
    is_subagent: obj.querySource === 'subagent' || (obj.model && obj.model.role) === 'subagent',
  };
}

function getZcodeRolloutDir() {
  // ZCODE_ROLLOUT_DIR：测试/CI 重定向到 fixture 目录；未设则 zcode 默认布局
  return process.env.ZCODE_ROLLOUT_DIR || join(homedir(), '.zcode', 'cli', 'rollout');
}

// dispatch 归因：按 [startedAt, completedAt] 时间窗聚合 model-io 中的 subagent 用量。
// ⚠ 只认 subagent 记录（is_subagent），禁止全量扫所有会话文件求和——同窗口内其他
// 主会话的并发用量（limt 实测 ~300 万无关 token）不是本次 dispatch 的。
// 返回 claude 格式 token_usage（stats.js / collect-ai.js normalize 直接复用），
// 无匹配/无有效时间窗返回 null（调用方落 note 或跳过）。
export function extractZcodeSubagentTokenUsage(startedAt, completedAt, rolloutDirOverride) {
  try {
    const dir = rolloutDirOverride || getZcodeRolloutDir();
    if (!existsSync(dir)) return null;
    const startMs = startedAt != null ? Date.parse(startedAt) : NaN;
    const endMs = completedAt != null ? Date.parse(completedAt) : NaN;
    // 无完整时间窗不聚合：无界求和会把历史上所有 subagent 用量都算进来（误采）
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;

    let files;
    try {
      files = readdirSync(dir).filter((f) => f.startsWith('model-io-sess_') && f.endsWith('.jsonl'));
    } catch (_) { return null; }
    if (files.length === 0) return null;

    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
    const models = {};

    for (const f of files) {
      // mtime 预过滤（对齐 extractSubagentTokenUsage）：记录 completedAt ≤ 文件最后写入
      // 时间，mtime 早于窗口起点 → 不可能含重叠记录，跳过省读整文件
      try {
        const st = statSync(join(dir, f));
        if (st.mtimeMs < startMs) continue;
      } catch (_) { continue; }

      let content;
      try { content = readFileSync(join(dir, f), 'utf8'); } catch (_) { continue; }

      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const rec = parseZcodeModelIoRecord(line);
        if (!rec) continue;
        if (!rec.is_subagent) continue;
        // 时间窗重叠判定（毫秒）：记录与 [startMs, endMs] 有交集即计入
        if (!(rec.started_at_ms <= endMs && rec.completed_at_ms >= startMs)) continue;
        inputTokens += rec.input_tokens;
        outputTokens += rec.output_tokens;
        cacheReadTokens += rec.cache_read_input_tokens;
        cacheCreationTokens += rec.cache_creation_input_tokens;
        const modelKey = rec.model || 'unknown';
        models[modelKey] = (models[modelKey] || 0) + rec.input_tokens + rec.output_tokens;
      }
    }

    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
      return null;
    }
    const dominantModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0];
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      model: dominantModel ? dominantModel[0] : 'unknown',
    };
  } catch (e) {
    debugLog('extractZcodeSubagentTokenUsage failed —', e.message);
    return null;
  }
}

// ─── Unified Usage JSONL ───

function getUsageFile() {
  // HARNESS_USAGE_DIR 由 hook 前缀注入（可能含字面 $HOME，需展开）；未设则回退 ~/.claude/usage
  const usageDir = process.env.HARNESS_USAGE_DIR
    ? process.env.HARNESS_USAGE_DIR.replace(/\$HOME/g, homedir())
    : join(homedir(), '.claude', 'usage');
  if (!existsSync(usageDir)) mkdirSync(usageDir, { recursive: true });
  return join(usageDir, 'usage.jsonl');
}

function appendUsage(record) {
  const usageFile = getUsageFile();
  const line = JSON.stringify(record) + '\n';
  appendFileSync(usageFile, line, 'utf8');
}

// ─── Shared State Helpers ───

function getSharedStateDirFn(changeName) {
  return join(PROJECT_ROOT, '.harness', 'shared-state', changeName);
}

// ─── Summarize State ───

function summarizeState(state) {
  const pipeline = state.pipeline || {};
  const phases = Object.keys(pipeline);
  const countedPhases = getCountedPhases(state);
  const doneCount = countedPhases.filter((phase) => pipeline[phase].status === 'done' || pipeline[phase].status === 'done_with_concerns').length;

  const startedPhases = phases.filter(p => pipeline[p].started_at);
  let elapsed_ms = null;
  if (startedPhases.length > 0) {
    const firstStart = startedPhases.map(p => new Date(pipeline[p].started_at).getTime()).sort((a, b) => a - b)[0];
    elapsed_ms = Date.now() - firstStart;
  }

  return {
    change_name: state.change_name,
    title: state.title,
    current_phase: state.current_phase,
    flow_type: state.flow_type,
    updated_at: state.updated_at,
    progress: `${doneCount}/${countedPhases.length}`,
    elapsed_ms,
    scores: state.scores,
    rework_count: state.rework_count,
    blocked_count: state.blocked_count,
    checkpoint: state.checkpoint || null,
    pipeline: Object.fromEntries(
      phases.map(p => [p, { status: pipeline[p].status, exit_status: pipeline[p].exit_status || null }])
    ),
  };
}

// ─── Stall Detection (issue !256/!257) ───

// 停滞阈值：60min。codex 单次 dispatch 合法耗时可达数十分钟，取宽松值避免误报。
export const STALL_THRESHOLD_MS = 60 * 60 * 1000;

// 纯函数（读侧检测，无新写入者）：当前阶段 in_progress 且超过阈值无状态回写
// （stateSave 每次写盘刷新 state.updated_at，长期不刷新 = wrapper 消亡/未启动，
// 见 issue !256/!257）→ 判定停滞。cmdStatus/cmdDashboard 只做展示拼接。
// fail-open：completed、非 in_progress、updated_at 缺失/非法 → 一律不判停滞，避免误报。
// 边界：stalled_ms > threshold（严格大于），恰好等于阈值不算停滞。
// stalled_ms 在可计算时始终返回（含未超阈值，供消费方展示接近阈值的程度），
// 不可计算（上述 fail-open 分支）时为 null。
export function detectStall(state, now = Date.now()) {
  const base = { stalled: false, phase: null, stalled_ms: null, threshold_ms: STALL_THRESHOLD_MS };
  if (!state || state.current_phase === 'completed') return base;
  const phaseData = state.pipeline?.[state.current_phase];
  if (!phaseData || phaseData.status !== 'in_progress') return base;
  const updatedMs = Date.parse(state.updated_at); // undefined/''/非法 → NaN
  if (Number.isNaN(updatedMs)) return base;
  const stalledMs = now - updatedMs;
  return { stalled: stalledMs > STALL_THRESHOLD_MS, phase: state.current_phase, stalled_ms: stalledMs, threshold_ms: STALL_THRESHOLD_MS };
}

// ─── CLI: init ───

export function cmdInit(args) {
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js init <change-name> --title <title> --criteria <c1,c2>');
  if (!/^[a-zA-Z0-9_-]+$/.test(changeName)) errExit(`Invalid change-name '${changeName}': only letters, digits, hyphens, underscores allowed`);

  const parsed = parseArgs(args.slice(1));
  const title = parsed.title || changeName;
  const criteria = parsed.criteria ? parsed.criteria.split(',') : [];
  const hotfix = parsed.hotfix === 'true' || parsed.hotfix === '';
  const docs = parsed.docs === 'true' || parsed.docs === '';
  const flowTypeArg = parsed['flow-type'] || null;
  const intentJson = getArg(args, '--intent-json');

  let flowType;
  if (flowTypeArg) {
    const validTypes = ['development', 'docs', 'hotfix', 'refactor', 'test-only', 'config-change', 'quick'];
    if (!validTypes.includes(flowTypeArg)) {
      errExit(`Invalid flow-type '${flowTypeArg}'. Valid: ${validTypes.join(', ')}`);
    }
    flowType = flowTypeArg;
  } else {
    flowType = docs ? 'docs' : null;
  }

  const effectiveHotfix = flowTypeArg ? (flowTypeArg === 'hotfix') : hotfix;

  const state = stateInit(changeName, title, criteria, flowType, effectiveHotfix, { mode: parsed.mode });

  if (intentJson) {
    try {
      state.intent = JSON.parse(intentJson);
      state.intent.parsed_at = new Date().toISOString();
    } catch (e) {
      errExit('Invalid JSON in --intent-json: ' + e.message);
    }

    // P1-2: Auto-upgrade to quick flow for simple intents
    if (state.flow_type === 'development' && state.intent.intent_category) {
      const cat = state.intent.intent_category;
      const conf = state.intent.confidence || 0.5;
      const affectedFiles = state.intent.affected_files?.length || 999;
      const quickCategories = ['bug_fix', 'quick_change', 'code_review', 'testing'];
      if (quickCategories.includes(cat) && conf >= 0.85 && affectedFiles <= 3) {
        state.flow_type = 'quick';
        state.intent.auto_upgraded_to_quick = true;
        state.intent.original_flow_type = 'development';
        state.pipeline = {};
        const quickPhases = getPipelinePhases('quick');
        for (const p of quickPhases) {
          state.pipeline[p] = { status: 'pending', rd_skill: null, first_pass: null, rework_reasons: [], artifact_paths: [] };
        }
        state.current_phase = 'pending';
        state.quality_metrics.phases_total = quickPhases.length;
      }
    }

    stateSave(changeName, state);
  }

  output({ change_name: changeName, action: 'init', state: summarizeState(state) });
}

// ─── CLI: set-phase ───

export function cmdSetPhase(args) {
  const changeName = args[0];
  const phase = args[1];
  if (!changeName || !phase) errExit('Usage: orchestrator.js set-phase <change-name> <phase>');

  const validPhases = ['intake', 'explore', 'propose', 'design-review', 'implement', 'test', 'code-review', 'debate', 'archive', 'dispatch', 'verify', 'complete'];
  if (!validPhases.includes(phase)) errExit(`Invalid phase '${phase}'. Valid: ${validPhases.join(', ')}`);

  const state = stateLoad(changeName);
  const previous = state.current_phase;
  state.current_phase = phase;
  if (state.pipeline[phase]) {
    const now = new Date().toISOString();
    state.pipeline[phase].status = 'in_progress';
    if (!state.pipeline[phase].started_at) {
      state.pipeline[phase].started_at = now;
    }
    state.pipeline[phase].last_resumed_at = now;
  }
  stateSave(changeName, state);
  output({ change_name: changeName, previous_phase: previous, current_phase: phase, action: 'set_phase' });
}

// ─── CLI: mark-dispatch ───

/**
 * Phase 3a 防御校验：dispatch_history 末尾必须含 wrapper_invoked:true
 *
 * 由 dispatch-agent.js wrapper 在 mark-dispatch --start 后立即 read-modify-write 写入。
 * 缺失（且字段不存在）意味着主会话绕过 wrapper 直接调 Agent/CodexBackend。
 *
 * 兼容窗口（D7）：旧 change 的 dispatch_history 条目无 wrapper_invoked 字段，
 * 视为向后兼容（debugLog 警告但不阻塞），1 个迭代周期后移除。
 *
 * 跳过条件（不阻塞 advance）：
 *   - pipeline-state.json 不存在（change 未 init）
 *   - current_phase 缺失或 pipeline[phase] 不存在
 *   - dispatch_history 为空（automated phase / 首次 dispatch 前）
 *   - 末尾条目 wrapper_invoked === true（正常路径）
 *   - 末尾条目无 wrapper_invoked 字段（旧 change 兼容窗口，warning）
 *
 * 阻塞条件：末尾条目显式 wrapper_invoked === false（明确绕过）
 */
function _assertWrapperInvoked(changeName) {
  let state;
  try {
    state = stateLoad(changeName);
  } catch (e) {
    debugLog(`_assertWrapperInvoked: stateLoad failed — ${e.message}`);
    return; // state 不存在或解析失败，让 advance 自己处理
  }
  const phase = state.current_phase;
  if (!phase || !state.pipeline || !state.pipeline[phase]) return;
  const ph = state.pipeline[phase];
  if (!ph.dispatch_history || ph.dispatch_history.length === 0) return;
  const last = ph.dispatch_history[ph.dispatch_history.length - 1];
  if (last.wrapper_invoked === true) return; // 正常路径
  if (last.wrapper_invoked === undefined) {
    // 兼容窗口：旧 change 没写字段，warning 不阻塞
    debugLog(`_assertWrapperInvoked: legacy dispatch_history entry without wrapper_invoked field (${changeName}/${phase}) — backward-compat window, allowing advance`);
    return;
  }
  // 显式 false 或其他非 true 值 → 阻塞
  errExit(`dispatch must go through dispatch-agent.js wrapper; bypassing is forbidden (change='${changeName}', phase='${phase}', dispatch_history[${ph.dispatch_history.length - 1}].wrapper_invoked=${JSON.stringify(last.wrapper_invoked)})`);
}

export function cmdMarkDispatch(args) {
  const changeName = args[0];
  const marker = args[1]; // --start or --end
  if (!changeName || !marker) errExit('Usage: orchestrator.js mark-dispatch <change-name> --start|--end');

  const isStart = marker === '--start';
  const isEnd = marker === '--end';
  if (!isStart && !isEnd) errExit('Invalid marker. Use --start or --end');

  const parsed = parseArgs(args.slice(2));
  // --backend <type>：标记本次 dispatch 用的 backend（claude/codex），写入 token_usage.backend
  // 用于报表层按 backend 分组聚合 token。dispatch-agent.js wrapper 已知 backendType，透传即可。
  // 缺省时不强行推断（保持旧行为：未传则不写 backend 字段，由 recalcTokens 兜底为 claude）。
  const backend = parsed.backend || null;
  const state = stateLoad(changeName);
  const phase = state.current_phase;
  if (!phase || !state.pipeline[phase]) errExit(`No active phase for '${changeName}'`);

  if (phase === 'intake') {
    errExit(`BLOCKED: phase '${phase}' is automated and must not dispatch sub-agents. Use 'node orchestrator.js run-automated ${changeName}' instead.`);
  }

  const now = new Date().toISOString();
  const ph = state.pipeline[phase];

  if (!ph.dispatch_history) ph.dispatch_history = [];

  const transcriptPath = findTranscriptPath();

  if (isStart) {
    const transcriptLine = transcriptPath ? countTranscriptLines(transcriptPath) : null;
    ph.dispatch_history.push({
      started_at: now,
      completed_at: null, token_usage: null, exit_status: null,
      context_mode: state.intent?.context_mode || 'full',
      _transcript_line: transcriptLine,
    });
    ph.dispatch_started_at = now;
  } else {
    let tokenUsage = null;
    const lastOpen = ph.dispatch_history.findLast(h => h.completed_at === null);
    // 显式 token 参数标记（zcode 分支与公共兜底分支共用同一判定）
    const hasExplicitTokenArgs = parsed['input-tokens'] !== undefined || parsed['output-tokens'] !== undefined || parsed['cache-read-tokens'] !== undefined || parsed['cache-creation-tokens'] !== undefined || parsed['reasoning-tokens'] !== undefined || parsed.model !== undefined || parsed.tokens !== undefined;
    if (backend === 'zcode') {
      // Issue #282: zcode 主会话无 Claude transcript（extractTokenUsage / extractSubagentTokenUsage
      // 均无效），改为从 model-io 日志按 [lastOpen.started_at, now] 时间窗聚合 subagent 用量。
      // 显式 token 参数优先（对齐 record-usage zcode 分支）：时间窗聚合是尽力而为的估算，
      // 调用方显式透传的值不应被估算覆盖。
      if (!hasExplicitTokenArgs && lastOpen && lastOpen.started_at) {
        tokenUsage = extractZcodeSubagentTokenUsage(lastOpen.started_at, now);
      }
    } else if (backend === 'codex') {
      // Issue !271 根因1：codex dispatch 的 subagent 用量在其独立 rollout 文件，
      // 按窗口归集（显式 --tokens/--input-tokens 优先，语义同 zcode 分支）。
      // 根因2（无窗口可归集时 token_usage 残缺）仍属 Codex backend Phase 2 已知限制。
      if (!hasExplicitTokenArgs && lastOpen && lastOpen.started_at) {
        tokenUsage = extractCodexSubagentTokenUsage(lastOpen.started_at, now);
      }
    } else if (lastOpen && lastOpen._transcript_line != null && transcriptPath) {
      tokenUsage = extractTokenUsage(transcriptPath, lastOpen._transcript_line);
    }
    // Issue !193: 主会话 transcript 拿不到子 agent token，fallback 扫 subagents 目录
    // Claude backend pipeline dispatch 的子 agent token 在独立 transcript：
    // projects/<slug>/<sessionId>/subagents/agent-*.jsonl
    // （zcode 无此布局，backend==='zcode' 时跳过）
    if (!tokenUsage && backend !== 'zcode' && lastOpen && transcriptPath) {
      tokenUsage = extractSubagentTokenUsage(transcriptPath, lastOpen.started_at);
    }
    if (!tokenUsage && hasExplicitTokenArgs) {
      // codex 路径：--tokens N（单值 total）+ 结构化明细（--input-tokens 等，!262 起透传 usageDetail）；
      // claude 路径：--input-tokens/--output-tokens/--cache-*-tokens。
      // 结构化与 total 可并存（结构化优先、total 兜底）：两者都传时合并，单传时保持旧行为。
      const hasStructured = parsed['input-tokens'] !== undefined || parsed['output-tokens'] !== undefined
        || parsed['cache-read-tokens'] !== undefined || parsed['cache-creation-tokens'] !== undefined
        || parsed['reasoning-tokens'] !== undefined;
      const total = parsed.tokens !== undefined ? parseInt(parsed.tokens, 10) : NaN;
      if (parsed.tokens !== undefined && !hasStructured) {
        // codex 单值兜底：--tokens N（无明细）
        tokenUsage = Number.isNaN(total) ? null : { total };
      } else {
        tokenUsage = {
          input_tokens: parsed['input-tokens'] !== undefined ? parseInt(parsed['input-tokens'], 10) : 0,
          output_tokens: parsed['output-tokens'] !== undefined ? parseInt(parsed['output-tokens'], 10) : 0,
          cache_read_input_tokens: parsed['cache-read-tokens'] !== undefined ? parseInt(parsed['cache-read-tokens'], 10) : 0,
          cache_creation_input_tokens: parsed['cache-creation-tokens'] !== undefined ? parseInt(parsed['cache-creation-tokens'], 10) : 0,
          ...(parsed['reasoning-tokens'] !== undefined ? { reasoning_output_tokens: parseInt(parsed['reasoning-tokens'], 10) } : {}),
          model: parsed.model || 'unknown',
        };
        if (!Number.isNaN(total)) tokenUsage.total = total;
      }
    }

    // 把 backend 字段写入 token_usage（若 tokenUsage 为 null 但 backend 有值，仍创建 {backend} 对象）
    if (backend) {
      if (tokenUsage) {
        tokenUsage.backend = backend;
      } else {
        tokenUsage = { backend };
      }
    }

    // 透传 dispatch 模板 / wrapper 传回的结果字段（issue !168：此前静默忽略
    // exit_status/summary/score，致 advance code-review 误判 rework）。
    // 仅当显式传入才落盘，避免 null 覆盖模板本应回写的真实值。
    const resultFields = {};
    if (parsed['exit-status'] !== undefined) resultFields.exit_status = parsed['exit-status'];
    if (parsed.summary !== undefined) resultFields.summary = parsed.summary;
    if (parsed.score !== undefined) resultFields.score = parsed.score !== '' ? Number(parsed.score) : null;
    if (parsed['p0-count'] !== undefined) resultFields.p0_count = Number(parsed['p0-count']) || 0;
    if (parsed['p1-count'] !== undefined) resultFields.p1_count = Number(parsed['p1-count']) || 0;

    if (lastOpen) {
      lastOpen.completed_at = now;
      if (tokenUsage) lastOpen.token_usage = tokenUsage;
      Object.assign(lastOpen, resultFields);
      delete lastOpen._transcript_line;
    } else {
      ph.dispatch_history.push({
        started_at: null, completed_at: now,
        token_usage: tokenUsage,
        exit_status: resultFields.exit_status ?? null,
        summary: resultFields.summary ?? null,
        score: resultFields.score ?? null,
        p0_count: resultFields.p0_count ?? 0,
        p1_count: resultFields.p1_count ?? 0,
      });
    }
    ph.dispatch_completed_at = now;

    // Issue !232 Bug1 Fix B: mirror --score into state.scores[roleKey] so that
    // advance's resolveAdvanceScore state-scores layer is populated even when
    // the main session forgets to repeat --score on the advance call.
    // roleKey mapping matches advance.js's writer (code-review → 'reviewer').
    if (resultFields.score !== undefined && resultFields.score !== null) {
      if (!state.scores) state.scores = {};
      state.scores[scoreRoleKey(phase)] = resultFields.score;
    }
  }

  stateSave(changeName, state);

  // pipeline dispatch 的统计来源是 pipeline-state.json 的 dispatch_history（上面 stateSave 已写）。
  // 不再向 usage.jsonl 追加 trigger=pipeline 条目，避免与 pipeline-state.json 双重计数。
  // usage.jsonl 现在只承载 trigger=natural（人工 dispatch）。

  output({ change_name: changeName, phase, action: 'mark_dispatch', marker, timestamp: now, dispatch_round: ph.dispatch_history.length });
}

// ─── CLI: record-usage ───

export function cmdRecordUsage(args) {
  const parsed = parseArgs(args);
  const role = parsed.role;
  const trigger = parsed.trigger || 'natural';
  const task = parsed.task || '';
  const startedAt = parsed['started-at'] || null;
  const completedAt = parsed['completed-at'] || new Date().toISOString();
  const fromLine = (parsed['from-line'] !== undefined && parsed['from-line'] !== 'true') ? parseInt(parsed['from-line'], 10) : null;
  const safeFromLine = (fromLine !== null && !isNaN(fromLine)) ? fromLine : null;

  if (!role) errExit('Usage: orchestrator.js record-usage --role <role> [--trigger natural|pipeline] [--task "..."] [--started-at ISO] [--completed-at ISO] [--from-line N] [--backend claude|codex|codebuddy|qoder|zcode] [--tokens N]');

  // Backend 维度（区分 claude/codex，便于报表不求和 token）
  const backend = (parsed.backend || _detectBackendTypeForUsage()).toLowerCase();
  const isHeadlessCli = backend === 'codex' || backend === 'qoder';

  const sessionId = process.env.QODER_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '';
  let durationMs = null;
  if (startedAt) {
    durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  }

  let tokens = null;
  let note = null;
  if (backend === 'zcode') {
    // Issue #282: zcode 本地 model-io 日志 schema 已实测稳定（limt 2026-09-08 comment），
    // 不再整支短路。优先级：
    //   ① 显式 --tokens 透传（调用方精确值优先，对齐 codex/qoder headless 模式）
    //   ② 按 [--started-at, --completed-at] 时间窗聚合 model-io subagent 用量
    //      （归因只认 subagent 记录，防并发主会话用量混入）
    //   ③ 都没有 → note 说明（不阻断）
    const cliTokens = parsed.tokens != null ? parseInt(parsed.tokens, 10) : null;
    if (cliTokens != null && !Number.isNaN(cliTokens) && cliTokens > 0) {
      tokens = { total: cliTokens };
    } else if (startedAt) {
      const extracted = extractZcodeSubagentTokenUsage(startedAt, completedAt);
      if (extracted) {
        tokens = {
          input: extracted.input_tokens,
          output: extracted.output_tokens,
          cache_read: extracted.cache_read_input_tokens,
          cache_creation: extracted.cache_creation_input_tokens,
          model: extracted.model,
        };
      } else {
        note = 'zcode model-io window aggregation found no subagent usage';
      }
    } else {
      note = 'zcode: no --tokens and no --started-at window for model-io aggregation';
    }
  } else if (isHeadlessCli) {
    // Headless CLI：主会话从 dispatchSubAgent 返回的 tokens_used 透传（--tokens N 参数）
    const cliTokens = parsed.tokens != null ? parseInt(parsed.tokens, 10) : null;
    if (cliTokens != null && !Number.isNaN(cliTokens) && cliTokens > 0) {
      tokens = { total: cliTokens };
    } else if (backend === 'codex' && startedAt) {
      // Issue !271 根因1：codex 无 --tokens 时按窗口归集 subagent rollout 用量
      // （三级优先与 zcode 分支对齐：显式透传 > 窗口归集 > note）。
      const extracted = extractCodexSubagentTokenUsage(startedAt, completedAt);
      if (extracted) {
        tokens = {
          input: extracted.input_tokens,
          output: extracted.output_tokens,
          cache_read: extracted.cache_read_input_tokens,
          cache_creation: extracted.cache_creation_input_tokens,
          model: extracted.model,
        };
      } else {
        note = 'codex rollout window aggregation found no subagent usage';
      }
    } else {
      note = `${backend} dispatch produced no parseable token usage`;
    }
  } else if (safeFromLine !== null) {
    const transcriptPath = findTranscriptPath();
    if (transcriptPath) {
      // Issue !279（主会话 Stop 采集）：自 fromLine 起无新增行 → 不产生记录。
      // 否则每次 Stop 都会 append 一条 tokens:null 记录，虚增 sampled_gap_count。
      const totalLines = countTranscriptLines(transcriptPath);
      if (totalLines <= safeFromLine) {
        output({ action: 'record_usage', role, trigger, skipped: 'no_new_transcript_lines' });
        return;
      }
      const extracted = extractTokenUsage(transcriptPath, safeFromLine);
      if (extracted) {
        tokens = {
          input: extracted.input_tokens,
          output: extracted.output_tokens,
          cache_read: extracted.cache_read_input_tokens,
          cache_creation: extracted.cache_creation_input_tokens || 0,
          model: extracted.model,
        };
      }
      // Issue !279：--advance-offset-file 由调用方（Stop hook）指定，extract 尝试后
      // 写入 transcript 总行数作为下一轮 from-line。行数以 countTranscriptLines 计，
      // 与 extractTokenUsage 同一度量；即使 extracted 为 null 也推进（该批行确无用量）。
      const offsetFile = parsed['advance-offset-file'];
      if (offsetFile) {
        try { writeFileSync(offsetFile, String(totalLines), 'utf8'); }
        catch (e) { debugLog('advance-offset-file write failed —', e.message); }
      }
    }
  }

  const record = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    role, trigger, task,
    backend,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    tokens,
  };
  if (note) record.note = note;

  appendUsage(record);
  output({
    action: 'record_usage',
    role, trigger, backend,
    duration_ms: durationMs,
    tokens: tokens ? 'captured' : 'unavailable',
    note: note || undefined,
  });
}

// 用于 record-usage 默认值：从环境推断 backend type（与 backend.js getBackendInfo 对齐）
function _detectBackendTypeForUsage() {
  const explicit = process.env.HARNESS_BACKEND?.toLowerCase();
  if (explicit === 'codex') return 'codex';
  if (explicit === 'claude') return 'claude';
  if (explicit === 'codebuddy') return 'codebuddy';
  if (explicit === 'qoder') return 'qoder';
  if (explicit === 'zcode') return 'zcode';
  if (process.env.QODER_PROJECT_DIR || process.env.QODER_SESSION_ID) return 'qoder';
  if (process.env.CODEBUDDY_SESSION_ID) return 'codebuddy';
  if (process.env.CLAUDE_CODE_SESSION_ID) return 'claude';
  return 'claude'; // 默认
}

// ─── CLI: advance ───

export function cmdAdvance(args) {
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js advance <change-name> [--exit-status DONE] [--score 85] [--artifacts f1,f2] [--work-item-id WI-1] [--worktree-path /path] [--rework-reason "..."]');

  // Phase 3a 防御校验：当前 phase 的 dispatch_history 末尾条目必须含 wrapper_invoked:true
  // 由 dispatch-agent.js wrapper 写入；缺失意味着主会话绕过 wrapper 直接调 Agent
  _assertWrapperInvoked(changeName);

  const parsed = parseArgs(args.slice(1));
  const result = advance(changeName, {
    exit_status: parsed['exit-status'] || 'DONE',
    score: parsed.score !== undefined ? parseFloat(parsed.score) : undefined,
    p0_count: parsed['p0-count'] !== undefined ? parseInt(parsed['p0-count'], 10) : undefined,
    p1_count: parsed['p1-count'] !== undefined ? parseInt(parsed['p1-count'], 10) : undefined,
    summary: parsed.summary || '',
    dimension: parsed.dimension || '',
    artifacts: parsed.artifacts ? parsed.artifacts.split(',').filter(Boolean) : [],
    rework_reason: parsed['rework-reason'] || '',
    work_item_id: parsed['work-item-id'] || '',
    worktree_path: parsed['worktree-path'] || '',
  });
  // checkpoint 自动落盘：跨 session resume 时无需重跑 advance 推断
  writeCheckpoint(changeName, result);
  output(result);
}

// ─── CLI: run-automated ───

export function cmdRunAutomated(args, _depth) {
  const depth = (_depth || 0) + 1;
  if (depth > 5) {
    errExit(`run-automated: recursion depth exceeded (>${depth}), possible infinite loop`);
  }
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js run-automated <change-name>');

  const state = stateLoad(changeName);
  const phase = state.current_phase;

  if (phase !== 'intake') {
    errExit(`run-automated: current phase is '${phase}', expected intake`);
  }

  let exitStatus, summary;

  if (phase === 'intake') {
    const concerns = [];
    if (!state.title || state.title.length < 5) {
      concerns.push('title too short or missing');
    }
    if (!state.acceptance_criteria || state.acceptance_criteria.length === 0) {
      concerns.push('no acceptance criteria');
    }
    const activeTasks = stateListActive().filter(t => t.change_name !== changeName);
    const dupes = activeTasks.filter(t => t.title === state.title && t.title === state.title);
    if (dupes.length > 0) {
      concerns.push(`duplicate active task: ${dupes.map(t => t.change_name).join(', ')}`);
    }
    const changeDir = join(PROJECT_ROOT, '.harness', 'spec', 'changes', changeName);
    if (existsSync(changeDir)) {
      concerns.push(`change directory already exists: ${changeDir}`);
    }

    if (concerns.length === 0) {
      exitStatus = 'DONE';
      summary = 'intake validation passed';
    } else {
      exitStatus = 'NEEDS_CONTEXT';
      summary = concerns.join('; ');
    }
  }

  if (state.pipeline[phase]) {
    state.pipeline[phase].status = exitStatus === 'BLOCKED' ? 'blocked' : exitStatus === 'DONE' ? 'done' : 'in_progress';
    state.pipeline[phase].exit_status = exitStatus;
    state.pipeline[phase].completed_at = new Date().toISOString();
    if (summary) state.pipeline[phase].summary = summary.slice(0, 500);
    state.pipeline[phase].first_pass = exitStatus === 'DONE';
  }

  const nextResult = advance(changeName, {
    exit_status: exitStatus,
    summary: summary,
  });

  if (nextResult.next_action === 'automated') {
    return cmdRunAutomated([changeName], depth);
  }

  output(nextResult);
}

// ─── CLI: status ───

export function cmdStatus(args) {
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js status <change-name> [--json]');

  const state = stateLoad(changeName);
  const json = args.includes('--json');

  if (json) {
    let rdStatus = null;
    try {
      const out = execSync(`rd status --change "${changeName}" --json`, { encoding: 'utf8', cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
      rdStatus = JSON.parse(out);
    } catch (e) { debugLog('rd status not available —', e.message); }

    output({ pipeline_state: state, stalled: detectStall(state), rd_status: rdStatus });
  } else {
    console.log(`Change: ${state.change_name}`);
    console.log(`Title:  ${state.title}`);
    console.log(`Phase:  ${state.current_phase}`);
    console.log(`Flow:   ${state.flow_type}`);
    console.log(`\nPipeline:`);
    for (const [phase, data] of Object.entries(state.pipeline)) {
      const icon = data.status === 'done' ? '✓' : data.status === 'in_progress' ? '●' : data.status === 'blocked' ? '⚠' : '○';
      let dispatchInfo = '';
      if (data.dispatch_history && data.dispatch_history.length > 0) {
        const rounds = data.dispatch_history
          .filter(h => h.started_at && h.completed_at)
          .map((h, i) => {
            const dur = Math.round((new Date(h.completed_at) - new Date(h.started_at)) / 1000);
            const m = Math.floor(dur / 60);
            const s = dur % 60;
            return `#${i + 1} ${m}m${String(s).padStart(2, '0')}s`;
          });
        if (rounds.length > 0) dispatchInfo = ` [${rounds.join(', ')}]`;
      }
      console.log(`  ${icon} ${phase}: ${data.status}${data.exit_status ? ` (${data.exit_status})` : ''}${dispatchInfo}${data.summary ? ` — ${data.summary.slice(0, 80)}` : ''}`);
    }
    const stall = detectStall(state);
    if (stall.stalled) {
      const thresholdMin = Math.round(STALL_THRESHOLD_MS / 60000);
      console.log(`\n⚠ STALLED: ${state.current_phase} 已停滞 ${formatDuration(stall.stalled_ms)}（超过 ${thresholdMin}m 阈值，无状态回写）`);
      const cp = state.checkpoint;
      if (cp && (cp.next_action || cp.next_rd_skill)) {
        const skill = cp.next_rd_skill ? ` → ${cp.next_rd_skill}` : '';
        console.log(`  恢复: 按 checkpoint 继续推进（rd-auto "继续 ${state.change_name}"）— ${cp.next_action}${skill}`);
      } else {
        console.log(`  恢复: node .claude/skills/rd-auto/scripts/dispatch-agent.js ${state.change_name} 或按 checkpoint 继续推进（rd-auto "继续 ${state.change_name}"）`);
      }
    }
    console.log(`\nRework count: ${JSON.stringify(state.rework_count)}`);
    console.log(`Blocked count: ${state.blocked_count}`);
    if (state.checkpoint) {
      const cp = state.checkpoint;
      const skill = cp.next_rd_skill ? ` → ${cp.next_rd_skill}` : '';
      console.log(`Checkpoint: ${cp.phase} → ${cp.next_action}${skill} (saved ${cp.saved_at})`);
      if (cp.reason) console.log(`  reason: ${cp.reason.slice(0, 120)}`);
    }
  }
}

// ─── CLI: dashboard ───

export function cmdDashboard(args) {
  const showAll = args.includes('--all');
  const tasks = showAll ? stateListAll() : stateListActive();
  const json = args.includes('--json');
  const showEfficiency = args.includes('--show-efficiency');

  if (json) {
    output(tasks.map(t => {
      const summary = summarizeState(t);
      summary.stalled = detectStall(t);
      summary.dispatch_efficiency = t.dispatch_efficiency || null;
      return summary;
    }));
    return;
  }

  if (tasks.length === 0) {
    console.log(showAll ? 'No tasks found.' : 'No active tasks.');
    return;
  }

  tasks.sort((a, b) => {
    const aActive = a.current_phase !== 'completed';
    const bActive = b.current_phase !== 'completed';
    if (aActive !== bActive) return aActive ? -1 : 1;
    const aBlocked = a.current_phase === 'blocked' || a.blocked_count >= 3;
    const bBlocked = b.current_phase === 'blocked' || b.blocked_count >= 3;
    if (aBlocked !== bBlocked) return bBlocked ? 1 : -1;
    return (b.updated_at || '').localeCompare(a.updated_at || '');
  });

  let headers = '| 任务 | 流程 | 当前阶段 | 进度 | 开始时间 | 已耗时 | 得分 | 返工 | 阻塞 |';
  let seps =   '|------|------|----------|------|----------|--------|------|------|------|';
  if (showEfficiency) {
    headers += ' 首产物耗时 | 总调度数 | PM到归档 |';
    seps +=   '----------|----------|----------|';
  }
  headers += ' 阶段进度 |';
  seps +=   '----------|';

  console.log(headers);
  console.log(seps);

  for (const t of tasks) {
    const pipeline = t.pipeline || {};
    const phases = Object.keys(pipeline);
    const countedPhases = getCountedPhases(t);

    const doneCount = countedPhases.filter(p => pipeline[p].status === 'done' || pipeline[p].status === 'done_with_concerns').length;
    const progress = `${doneCount}/${countedPhases.length}`;

    const startedPhases = phases.filter(p => pipeline[p].started_at);
    let startedAt = '-';
    let elapsed = '-';
    if (startedPhases.length > 0) {
      const firstStart = startedPhases.map(p => new Date(pipeline[p].started_at).getTime()).sort((a, b) => a - b)[0];
      const d = new Date(firstStart);
      startedAt = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (t.current_phase === 'completed' && t.completed_at) {
        elapsed = formatDuration(new Date(t.completed_at) - firstStart);
      } else {
        elapsed = formatDuration(Date.now() - firstStart);
      }
    }

    const scoreEntries = Object.entries(t.scores || {}).filter(([, v]) => v !== null && v !== undefined);
    const latestScore = scoreEntries.length > 0 ? scoreEntries[scoreEntries.length - 1][1] : '-';

    const totalRework = Object.values(t.rework_count || {}).reduce((a, b) => a + b, 0);

    const phaseStatus = phases.map(p => {
      const s = pipeline[p].status;
      if (s === 'done' || s === 'done_with_concerns') return `${p}✓`;
      if (s === 'blocked') return `${p}⚠`;
      if (s === 'in_progress') return `${p}●`;
      return `${p}○`;
    }).join(' ');

    const phaseDisplay = t.current_phase === 'completed' ? '✅ completed' : t.current_phase;
    const stallMark = detectStall(t).stalled ? ' ⚠stalled' : '';
    let row = `| ${t.change_name}${stallMark} | ${t.flow_type} | ${phaseDisplay} | ${progress} | ${startedAt} | ${elapsed} | ${latestScore} | ${totalRework} | ${t.blocked_count} |`;
    if (showEfficiency) {
      const eff = t.dispatch_efficiency || {};
      const firstArtifact = eff.pm_to_first_artifact_ms != null ? formatDuration(eff.pm_to_first_artifact_ms) : 'n/a';
      const totalDispatch = eff.total_dispatch_count != null ? String(eff.total_dispatch_count) : 'n/a';
      const pmToArchive = eff.pm_to_archive_ms != null ? formatDuration(eff.pm_to_archive_ms) : '进行中';
      row += ` ${firstArtifact} | ${totalDispatch} | ${pmToArchive} |`;
    }
    row += ` ${phaseStatus} |`;
    console.log(row);
  }
}

// ─── CLI: stats ───

export function cmdStats(args) {
  const json = args.includes('--json');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const tasks = stateListAll();

  if (tasks.length === 0) {
    console.log('No tasks found.');
    process.exit(0);
  }

  const rules = parseRules(RULES_PATH);
  const statsResult = computeStats(tasks, rules.phaseSkillMap);

  if (json) {
    const roles = statsResult.roles.map(s => ({
      role: s.role, task_count: s.task_count, first_pass_count: s.first_pass_count,
      first_pass_rate: s.first_pass_rate, rework_count: s.rework_count,
      avg_score: s.avg_score, avg_duration_ms: s.avg_duration_ms,
      blocked_count: s.blocked_count, total_input_tokens: s.total_input_tokens,
      total_output_tokens: s.total_output_tokens, primary_model: s.primary_model,
      avg_first_pass_rate: s.avg_first_pass_rate, common_rework_reasons: s.common_rework_reasons,
      // 透传 deprecation 标记（仅当该 role 跨多 backend）
      ...(s.__deprecated_for_backend_split ? { __deprecated_for_backend_split: true } : {}),
    }));
    const advanced = computeAdvancedStats(tasks, rules.phaseSkillMap);
    output({
      roles, phase_durations: statsResult.phase_durations,
      context_modes: statsResult.context_modes,
      context_upgrades: statsResult.context_upgrades,
      // 新增维度：by_backend / by_role_backend
      by_backend: statsResult.by_backend,
      by_role_backend: statsResult.by_role_backend,
      backend_fallback_count: statsResult.backend_fallback_count,
      by_role_deprecated_for_backend_split: statsResult.by_role_deprecated_for_backend_split,
      advanced,
    });
    return;
  }

  // ── by_role 旧表（混合求和；混合时附 deprecation 警告）──
  const hdr = '| 角色 | 任务数 | 一次通过 | 返工 | 平均分 | 平均耗时 | 阻塞 | 模型 | Token消耗 |';
  const sep = '|------|--------|----------|------|--------|----------|------|------|-----------|';
  console.log(hdr);
  console.log(sep);
  for (const s of statsResult.roles) {
    const fp = s.task_count > 0 ? `${s.first_pass_count}(${Math.round(s.first_pass_rate * 100)}%)` : '0';
    const sc = s.avg_score !== null ? String(s.avg_score) : 'n/a';
    const model = s.primary_model || '-';
    const tokenStr = (s.total_input_tokens > 0 || s.total_output_tokens > 0)
      ? `${s.total_input_tokens}in/${s.total_output_tokens}out`
      : '-';
    console.log(`| ${s.role} | ${s.task_count} | ${fp} | ${s.rework_count} | ${sc} | ${formatDuration(s.avg_duration_ms)} | ${s.blocked_count} | ${model} | ${tokenStr} |`);
  }
  // by_role 混合 backend 时输出 deprecation 警告
  if (statsResult.by_role_deprecated_for_backend_split) {
    console.log('');
    console.log('> ⚠️ by_role token totals mix backends; use by_backend for accurate breakdown');
  }

  // ── by_backend 新表（按 backend 分组；Claude/Codex 各算各的）──
  const byBackend = statsResult.by_backend || {};
  const backends = Object.keys(byBackend).filter(b => byBackend[b].dispatch_count > 0);
  if (backends.length > 0) {
    console.log('');
    console.log('## 按 Backend 分组 Token 用量');
    for (const backend of backends) {
      const b = byBackend[backend];
      console.log('');
      console.log(`### ${backend} (dispatches: ${b.dispatch_count})`);
      if (backend === 'codex' || backend === 'unknown') {
        // Codex/unknown：用 Total 列替代，稀疏字段显示 —
        console.log('| Backend | Dispatches | Total |');
        console.log('|---------|-----------|-------|');
        const totalStr = b.total_tokens !== null && b.total_tokens !== undefined ? b.total_tokens.toLocaleString() : '—';
        console.log(`| ${backend} | ${b.dispatch_count} | ${totalStr} |`);
      } else {
        // Claude：Input/Output/Cached 列
        console.log('| Backend | Dispatches | Input | Output | Cached | Model |');
        console.log('|---------|-----------|-------|--------|--------|-------|');
        const inStr = b.input_tokens !== null && b.input_tokens !== undefined ? b.input_tokens.toLocaleString() : '—';
        const outStr = b.output_tokens !== null && b.output_tokens !== undefined ? b.output_tokens.toLocaleString() : '—';
        const cachedStr = b.cached_tokens !== null && b.cached_tokens !== undefined ? b.cached_tokens.toLocaleString() : '—';
        const modelStr = b.model || '—';
        console.log(`| ${backend} | ${b.dispatch_count} | ${inStr} | ${outStr} | ${cachedStr} | ${modelStr} |`);
      }
      if (backend === 'codex') {
        console.log('> Codex token 当前仅 total；input/output/cached 拆分依赖 ZDR 改进');
      }
    }

    // 兜底标注（含旧 state 兜底条目）
    if (statsResult.backend_fallback_count > 0) {
      console.log('');
      console.log(`> 注：${statsResult.backend_fallback_count} 条历史记录按 claude 估算（无 backend 字段）`);
    }
  }

  // ── by_role_backend 二维交叉表（--verbose 时输出）──
  if (verbose) {
    const byRoleBackend = statsResult.by_role_backend || {};
    const rbKeys = Object.keys(byRoleBackend).filter(k => byRoleBackend[k].dispatch_count > 0);
    if (rbKeys.length > 0) {
      console.log('');
      console.log('## Role × Backend 交叉表（verbose）');
      console.log('| Role | Backend | Dispatches | Input | Output | Cached | Total |');
      console.log('|------|---------|-----------|-------|--------|--------|-------|');
      for (const key of rbKeys.sort()) {
        const b = byRoleBackend[key];
        const [role, backend] = key.split('.');
        const inStr = b.input_tokens != null ? b.input_tokens.toLocaleString() : '—';
        const outStr = b.output_tokens != null ? b.output_tokens.toLocaleString() : '—';
        const cachedStr = b.cached_tokens != null ? b.cached_tokens.toLocaleString() : '—';
        const totalStr = b.total_tokens != null ? b.total_tokens.toLocaleString() : '—';
        console.log(`| ${role} | ${backend} | ${b.dispatch_count} | ${inStr} | ${outStr} | ${cachedStr} | ${totalStr} |`);
      }
    }
  }
}

// ─── CLI: complete ───

export function cmdComplete(args) {
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js complete <change-name>');

  const state = stateLoad(changeName);

  if (!state.quality_metrics) {
    state.quality_metrics = {
      first_pass_rate: null, total_rework_loops: 0, automated_catches: 0,
      time_to_first_code_review_ms: null, total_wall_clock_ms: null,
      phases_completed: 0, phases_total: 0,
    };
  }

  const now = new Date().toISOString();
  if (state.created_at) {
    state.quality_metrics.total_wall_clock_ms = new Date(now) - new Date(state.created_at);
  }

  if (state.pipeline['code-review'] && state.pipeline['code-review'].completed_at && state.created_at) {
    state.quality_metrics.time_to_first_code_review_ms = new Date(state.pipeline['code-review'].completed_at) - new Date(state.created_at);
  }

  {
    const phasesWithFP = Object.values(state.pipeline).filter(p => p.first_pass !== null && p.first_pass !== undefined);
    if (phasesWithFP.length > 0) {
      const passCount = phasesWithFP.filter(p => p.first_pass === true).length;
      state.quality_metrics.first_pass_rate = Math.round((passCount / phasesWithFP.length) * 100) / 100;
    }
  }

  {
    let total = 0;
    for (const ph of Object.values(state.pipeline)) {
      if (ph.dispatch_history && ph.dispatch_history.length > 1) {
        total += ph.dispatch_history.length - 1;
      }
    }
    state.quality_metrics.total_rework_loops = total;
  }

  const allPhases = Object.keys(state.pipeline);
  state.quality_metrics.phases_total = allPhases.length;
  state.quality_metrics.phases_completed = allPhases.filter(p => state.pipeline[p].status !== 'pending').length;

  state.current_phase = 'completed';
  state.completed_at = now;
  stateSave(changeName, state);

  // Phase 3a：移除 rmSync(sharedDir) 清理 — 审计证据（codex-logs/、concerns.json）
  // 由 archive 流程接管清理/迁移。cmdComplete 仅完成 pipeline 收口，不越权删除。
  // 见 .harness/spec/changes/dispatch-agent-wrapper/specs/complete-state-cleanup/spec.md
  output({ change_name: changeName, action: 'completed', shared_state_retained: true });
}

// ─── CLI: parse-intent ───

export function cmdParseIntent(args) {
  const intentJson = getArg(args, '--intent-json');
  const rawInput = getArg(args, '--raw-input');

  if (!intentJson && !rawInput) {
    errExit('parse-intent requires --intent-json or --raw-input');
  }

  if (!intentJson) {
    const rawOnlyResult = {
      action: 'parse_intent',
      raw_input: rawInput,
      status: 'needs_llm_reasoning',
      message: '请在 SKILL.md 中使用 LLM 推理完成意图解析，然后用 --intent-json 传入结果',
    };
    console.log(JSON.stringify(rawOnlyResult, null, 2));
    return;
  }

  let intent;
  try {
    intent = JSON.parse(intentJson);
  } catch (e) {
    errExit('Invalid JSON in --intent-json: ' + e.message);
  }

  const validTaskTypes = ['development', 'docs', 'hotfix', 'refactor', 'test-only', 'config-change'];

  if (!intent.task_type || !validTaskTypes.includes(intent.task_type)) {
    errExit(`Invalid task_type: ${intent.task_type}. Must be one of: ${validTaskTypes.join(', ')}`);
  }

  if (intent.change_name && !/^[a-zA-Z0-9_-]+$/.test(intent.change_name)) {
    errExit(`Invalid change_name: ${intent.change_name}. Must be kebab-case (letters, digits, hyphens, underscores)`);
  }

  const VALID_CONTEXT_MODES = ['full', 'read_only', 'minimal'];
  const rawContextMode = intent.context_mode;
  const isStringMode = typeof rawContextMode === 'string';
  const isValidMode = isStringMode && VALID_CONTEXT_MODES.includes(rawContextMode);
  const context_mode = isValidMode ? rawContextMode : 'full';
  const contextModeDegraded = isStringMode && !isValidMode && rawContextMode !== '';

  const parsed = {
    action: 'parse_intent',
    raw_input: intent.raw_input || rawInput || '',
    task_type: intent.task_type,
    confidence: typeof intent.confidence === 'number' ? intent.confidence : 0.5,
    change_name: intent.change_name || null,
    title: intent.title || null,
    criteria: Array.isArray(intent.criteria) ? intent.criteria : [],
    modules: Array.isArray(intent.modules) ? intent.modules : [],
    complexity_hint: ['S', 'M', 'L', 'XL'].includes(intent.complexity_hint) ? intent.complexity_hint : null,
    sub_intents: Array.isArray(intent.sub_intents) ? intent.sub_intents : [],
    context_mode,
    parsed_at: new Date().toISOString(),
  };

  if (parsed.confidence < 0.7 && contextModeDegraded) {
    parsed.warning = `Low confidence - PM confirmation recommended; context_mode '${rawContextMode}' is invalid, degraded to 'full'`;
  } else if (parsed.confidence < 0.7) {
    parsed.warning = 'Low confidence - PM confirmation recommended';
  } else if (contextModeDegraded) {
    parsed.warning = `context_mode '${rawContextMode}' is invalid, degraded to 'full'`;
  }

  console.log(JSON.stringify(parsed, null, 2));
}

// ─── CLI: dispatch-prompt ───

export function cmdDispatchPrompt(args) {
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js dispatch-prompt <change-name>');

  const state = stateLoad(changeName);
  const phase = state.current_phase;
  const rules = parseRules(RULES_PATH);
  // Issue !162: quick flow dispatch phase has role=null in yaml (intent-based
  // routing). Fall back to resolveQuickFlowRole which maps intent_category to
  // a concrete role for quick flow + dispatch. Returns null for quick_change
  // with <=2 files (main session self-handles) — emit a structured hint instead
  // of erroring.
  const nextRole = getRole(rules, phase) || resolveQuickFlowRole(state, phase);

  // Rework 覆盖：若 state.pending_rework 存在，用 target_role 覆盖 nextRole（issue !232 Bug2 C3）
  // advance buildReworkResponse 写入 pending_rework，dispatch-prompt 读它定向派到制品作者
  const pendingRework = state.pending_rework || null;
  let effectiveRole = nextRole;
  let isRework = false;
  let reworkContext = null;
  if (pendingRework && pendingRework.target_role) {
    effectiveRole = pendingRework.target_role;
    isRework = true;
    reworkContext = {
      previous_phase: pendingRework.previous_phase,
      reason: pendingRework.reason,
      rework_count: pendingRework.rework_count,
      pua_debugging_required: pendingRework.pua_debugging_required,
    };
  }

  // issue !247: rework 期间 current_phase 已被 buildReworkResponse 推进到 target 角色
  // （developer/architect/tester，不是 phase_skill_map 里的 DAG 阶段）→ nextRole 为 null。
  // pendingRework.target_role 已把 effectiveRole 定向到制品作者，此时必须继续 dispatch，
  // 不能走"无子 agent 角色"的 hint 分支（否则 rework 无法派发 → 卡死）。
  if (!nextRole && !pendingRework) {
    // Legitimate null (e.g. quick_change main-session self-handle, or terminal
    // phase like complete). Emit structured hint so PM/orchestrator can react.
    output({
      role: null,
      change_name: changeName,
      phase,
      backend: _safeBackendInfo(),
      hint: state.flow_type === 'quick' && phase === 'dispatch'
        ? `quick flow + dispatch phase + intent_category='${state.intent?.intent_category || 'unknown'}' resolves to no sub-agent role (main session self-handles). Re-run /rd-auto advance when work is done.`
        : `No sub-agent role required for phase '${phase}' (flow_type='${state.flow_type}').`,
      next_action: 'main_session_handles',
    });
    return;
  }

  const agentFile = ROLE_AGENT_MAP[effectiveRole];
  if (!agentFile) errExit(`No agent definition for role '${effectiveRole}'. Known roles: ${Object.keys(ROLE_AGENT_MAP).join(', ')}`);

  const agentPath = join(CLAUDE_DIR, 'agents', agentFile);
  if (!existsSync(agentPath)) errExit(`Agent definition file not found: ${agentPath}`);

  const rawContent = readFileSync(agentPath, 'utf8');
  const agentDir = dirname(agentPath);
  const expandedContent = expandAgentIncludes(rawContent, agentDir);
  const agentLines = expandedContent.split('\n').length;

  const title = state.title || changeName;
  const prevSummary = getPreviousSummary(state, phase);

  if (agentLines < 50) {
    errExit(`Agent definition ${agentFile} is only ${agentLines} lines — too short, likely corrupted or empty. Expected 50+ lines.`);
  }

  const intent = {
    criteria: state.acceptance_criteria || [],
    context_mode: state.intent?.context_mode || 'full',
  };
  const contextPack = assembleContextPack(changeName, intent, intent.context_mode, phase);

  output({
    role: effectiveRole, agent_path: agentPath, change_name: changeName, title,
    phase,
    backend: _safeBackendInfo(),
    acceptance_criteria: state.acceptance_criteria || [],
    previous_summary: prevSummary,
    context_pack: contextPack,
    is_rework: isRework,
    rework_context: reworkContext,
    validation: {
      agent_file_exists: true, agent_line_count: agentLines,
      agent_min_threshold: 50, passed: agentLines >= 50,
      agent_file_content: expandedContent,
    },
  });
}

// 主会话分流的唯一信号源：backend.type ∈ {"claude","codex"}
// 用 _safeBackendInfo() 包装避免 backend detection 失败时整个 dispatch-prompt 崩

/**
 * fallback backend 信息（getBackendInfo 抛错时使用）。
 *
 * name 必须与 ClaudeBackend 实例 this.name 对齐（claude-backend.js 中 `this.name = 'Claude Code'`）。
 * 早期版本曾错写为 'ClaudeBackend'（类名），导致 fallback 路径上 backend.name 语义不一致。
 *
 * export 是为了让单测（test_safe_backend_info_fallback.py）可直接验证 fallback 值，
 * 不需要触发 detectBackend 真实失败。
 */
export function fallbackBackendInfo() {
  return { type: 'claude', name: 'Claude Code' };
}

function _safeBackendInfo() {
  try {
    const info = getBackendInfo();
    return { type: info.type, name: info.name };
  } catch (e) {
    debugLog('getBackendInfo failed —', e.message);
    return fallbackBackendInfo();
  }
}

// ─── CLI: recommend-mode ───

export function cmdRecommendMode(args) {
  const intentJson = getArg(args, '--intent-json');
  if (!intentJson) {
    errExit('recommend-mode requires --intent-json');
  }
  let intent;
  try {
    intent = JSON.parse(intentJson);
  } catch (e) {
    errExit('Invalid JSON in --intent-json: ' + e.message);
  }
  const result = recommendMode(intent);
  output(result);
}

// ─── CLI: verify-quick ───

/**
 * Phase 3a：联合 git diff/cached/untracked 三路判定
 *
 * 任一非空 → git_diff_non_empty=true。任一失败 debugLog 但不阻塞（视为该来源为空）。
 * 抽取为独立 helper 是为了单测（test_verify_quick_unified_diff.py 直接调）。
 */
export function hasWorkingTreeChanges(cwd = PROJECT_ROOT) {
  const sources = [
    { name: 'unstaged',  cmd: 'git diff --stat' },
    { name: 'staged',    cmd: 'git diff --cached --stat' },
    { name: 'untracked', cmd: 'git ls-files --others --exclude-standard' },
  ];
  for (const src of sources) {
    try {
      const out = execSync(src.cmd, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      if (out && out.trim() !== '') return true;
    } catch (e) {
      debugLog(`hasWorkingTreeChanges: ${src.name} check failed — ${e.message}`);
      // 不阻塞，视为该来源为空
    }
  }
  return false;
}

/**
 * Phase 3a：intent_category 白名单软降级
 *
 * 白名单 = { exploration, code_review, docs, quick_change, bug_fix }
 * intent_category 缺失视为 quick_change（容忍，向后兼容）。
 * feature / 其他值 → 不容忍（git_diff 是必要条件）。
 */
export function isIntentCategoryTolerant(state) {
  const cat = state?.intent?.intent_category || 'quick_change'; // 缺失默认
  const whitelist = new Set(['exploration', 'code_review', 'docs', 'quick_change', 'bug_fix']);
  return whitelist.has(cat);
}

export function cmdVerifyQuick(args) {
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js verify-quick <change-name>');

  const state = stateLoad(changeName);
  const concerns = [];
  let allArtifactsExist = true;

  for (const [phase, data] of Object.entries(state.pipeline || {})) {
    if (data.artifact_paths && data.artifact_paths.length > 0) {
      for (const ap of data.artifact_paths) {
        const fullPath = join(PROJECT_ROOT, ap);
        if (!existsSync(fullPath)) {
          concerns.push(`Missing artifact: ${ap} (from ${phase})`);
          allArtifactsExist = false;
        }
      }
    }
  }

  // Phase 3a：联合 diff 判定（unstaged + staged + untracked）
  const gitDiffNonEmpty = hasWorkingTreeChanges(PROJECT_ROOT);
  const tolerant = isIntentCategoryTolerant(state);
  const cat = state?.intent?.intent_category || 'quick_change';

  let exitStatus;
  if (!allArtifactsExist) {
    // artifacts 缺失始终 DONE_WITH_CONCERNS（无论 intent_category）
    exitStatus = 'DONE_WITH_CONCERNS';
  } else if (gitDiffNonEmpty) {
    exitStatus = 'DONE';
  } else if (tolerant) {
    // 软降级：artifacts_exist + intent_category 在白名单 → DONE，但 concerns 加软提示
    exitStatus = 'DONE';
    concerns.push(`git diff empty but intent_category=${cat} allows empty diff`);
  } else {
    // 硬约束失败：feature 类必须 git diff 非空
    exitStatus = 'DONE_WITH_CONCERNS';
    concerns.push('No file changes detected');
  }

  output({
    change_name: changeName, exit_status: exitStatus,
    details: concerns.length > 0 ? concerns : ['All checks passed'],
    artifacts_exist: allArtifactsExist,
    git_diff_non_empty: gitDiffNonEmpty,
    intent_category: cat,
    intent_tolerant: tolerant,
  });
}

// ─── CLI: upgrade-to-full ───

export function cmdUpgradeToFull(args) {
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js upgrade-to-full <change-name>');

  const state = stateLoad(changeName);
  if (state.flow_type !== 'quick') {
    errExit(`Cannot upgrade: change '${changeName}' is not quick flow (current: ${state.flow_type})`);
  }

  const intent = state.intent;
  const phases = getPipelinePhases('development');
  const pipeline = {};
  for (const p of phases) {
    pipeline[p] = { status: 'pending', rd_skill: null, first_pass: null, rework_reasons: [], artifact_paths: [] };
  }

  state.flow_type = 'development';
  state.hotfix_mode = false;
  state.docs_mode = false;
  state.pipeline = pipeline;
  state.current_phase = 'intake';

  state.quality_gates = {
    'QG-ARCH-001': 'pending', 'QG-DEV-001': 'pending',
    'QG-REV-001': 'pending', 'QG-REV-002': 'pending',
  };
  state.scores = { architect: null, reviewer: null, tester: null };
  state.rework_count = { architect: 0, developer: 0, tester: 0, reviewer: 0 };

  if (!state.adaptive_overrides) state.adaptive_overrides = { skipped_phases: [], forced_phases: [], pre_guidance_history: [] };
  state.adaptive_overrides.pre_guidance_history.push({
    phase: 'upgrade', role: 'system',
    guidance: `Upgraded from quick to development pipeline: sub-agent reported task_too_large`,
    injected_at: new Date().toISOString(),
  });

  state.quality_metrics.phases_total = phases.length;
  state.quality_metrics.phases_completed = 0;

  stateSave(changeName, state);

  output({
    change_name: changeName, action: 'upgraded_to_full',
    previous_flow_type: 'quick', new_flow_type: 'development',
    current_phase: 'intake',
    reason: 'sub-agent reported BLOCKED(task_too_large)',
    intent_preserved: !!intent,
  });
}

// ─── CLI: read-shared-state ───

export function cmdReadSharedState(args) {
  const changeName = args[0];
  const key = getArg(args, '--key') || null;
  const status = getArg(args, '--status') || null;

  if (!changeName) errExit('Usage: orchestrator.js read-shared-state <change-name> [--key <key>] [--status <status>]');

  const stateDir = getSharedStateDirFn(changeName);
  if (!existsSync(stateDir)) {
    output({ change_name: changeName, key: key, exists: false, data: null });
    return;
  }

  const data = {};
  if (key) {
    const filePath = join(stateDir, `${key}.json`);
    if (!existsSync(filePath)) {
      output({ change_name: changeName, key: key, exists: false, data: null });
      return;
    }
    let content = JSON.parse(readFileSync(filePath, 'utf8'));

    if (status && key === 'concerns') {
      content = filterConcernsByStatus(content, status);
    }

    data[key] = content;
  } else {
    const files = readdirSync(stateDir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        const k = f.slice(0, -5);
        data[k] = JSON.parse(readFileSync(join(stateDir, f), 'utf8'));
      }
    }
  }

  output({ change_name: changeName, key: key, status: status, exists: true, data: data });
}

// ─── CLI: write-shared-state ───

export function cmdWriteSharedState(args) {
  const changeName = args[0];
  const key = getArg(args, '--key');
  const jsonData = getArg(args, '--json');

  if (!changeName) errExit('Usage: orchestrator.js write-shared-state <change-name> --key <key> --json <json-data>');
  if (!key) errExit('--key is required');
  if (!jsonData) errExit('--json is required');

  const stateDir = getSharedStateDirFn(changeName);
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  let data;
  try {
    data = JSON.parse(jsonData);
  } catch (e) {
    errExit('Invalid JSON in --json: ' + e.message);
  }

  // concerns.json 是跨角色共享的机器读数据源（advance/collect-ai/resolve 都读），
  // 写入时必须归一化到规范分组 {p0,p1} 并校验每条必填字段，防止 AI 自由发挥
  // 输出裸数组/包裹/分组等任意格式（issue: resolve-concern 无法处理非规范格式）。
  if (key === 'concerns') {
    try {
      data = normalizeConcerns(data);
    } catch (e) {
      errExit(`concerns.json 校验失败: ${e.message}`);
    }
  }

  const filePath = join(stateDir, `${key}.json`);

  const tmpFile = `${filePath}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmpFile, filePath);

  output({ change_name: changeName, key: key, written: true, path: filePath });
}

// ─── CLI: resolve-concern ───

export function cmdResolveConcern(args) {
  const changeName = args[0];
  const concernId = getArg(args, '--concern-id');

  if (!changeName) errExit('Usage: orchestrator.js resolve-concern <change-name> --concern-id <id>');
  if (!concernId) errExit('--concern-id is required');

  const stateDir = getSharedStateDirFn(changeName);
  const filePath = join(stateDir, 'concerns.json');

  if (!existsSync(filePath)) {
    errExit(`concerns.json not found for ${changeName}`);
  }

  let content;
  try {
    content = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    errExit('Failed to parse concerns.json: ' + e.message);
  }

  // Tolerates wrapped {concerns}, flat arrays, and grouped {p0}/{p1} — the
  // same formats countOpenP0FromConcerns already accepts.
  const now = new Date().toISOString();
  const resolved = resolveConcernById(content, concernId, 'AI-Developer', now);

  if (!resolved) {
    errExit(`Concern ${concernId} not found`);
  }

  const tmpFile = `${filePath}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(content, null, 2), 'utf8');
  renameSync(tmpFile, filePath);

  output({ change_name: changeName, concern_id: concernId, resolved: true, resolved_at: now });
}

// ─── CLI: sync-interfaces ───

function extractInterfaceChanges(designMdPath) {
  if (!existsSync(designMdPath)) return [];

  const designContent = readFileSync(designMdPath, 'utf8');
  const interfaces = [];

  const routePattern = /(POST|GET|PUT|DELETE|PATCH)\s+([^\s#\n]+)/gi;
  let match;

  while ((match = routePattern.exec(designContent)) !== null) {
    interfaces.push({
      name: `${match[1].toUpperCase()} ${match[2].trim()}`,
      operation: match[1].toLowerCase(),
      changes: [{ type: 'create', description: `New interface defined in design.md` }],
      status: 'proposed'
    });
  }

  return interfaces;
}

export function cmdSyncInterfaces(args) {
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js sync-interfaces <change-name>');

  const specDir = join(PROJECT_ROOT, '.harness', 'spec', 'changes', changeName);
  const designPath = join(specDir, 'design.md');
  const sharedDir = getSharedStateDirFn(changeName);
  const outputPath = join(sharedDir, 'interface-changes.yaml');

  if (!existsSync(designPath)) {
    errExit(`design.md not found for ${changeName}`);
  }

  if (!existsSync(sharedDir)) mkdirSync(sharedDir, { recursive: true });

  const interfaces = extractInterfaceChanges(designPath);

  const yamlContent = `version: 1.0
created_by: AI-Architect
created_at: ${new Date().toISOString()}
interfaces:
${interfaces.map(i => `  - name: "${i.name}"
    operation: ${i.operation}
    changes:
      - type: ${i.changes[0].type}
        description: ${i.changes[0].description}
    status: ${i.status}`).join('\n')}
`;

  const tmpFile = `${outputPath}.tmp`;
  writeFileSync(tmpFile, yamlContent, 'utf8');
  renameSync(tmpFile, outputPath);

  output({
    change_name: changeName,
    interfaces_found: interfaces.length,
    interfaces: interfaces,
    output_path: outputPath
  });

  if (interfaces.length > 0) {
    console.log(`\nDetected ${interfaces.length} interface(s):`);
    interfaces.forEach(i => console.log(`  - ${i.name}`));
  }
}

// ─── CLI: archive-interfaces ───

export function cmdArchiveInterfaces(args) {
  const changeName = args[0];
  if (!changeName) errExit('Usage: orchestrator.js archive-interfaces <change-name>');

  const sharedDir = getSharedStateDirFn(changeName);
  const srcPath = join(sharedDir, 'interface-changes.yaml');

  if (!existsSync(srcPath)) {
    output({ change_name: changeName, archived: false, reason: 'interface-changes.yaml not found' });
    return;
  }

  const archiveDir = join(PROJECT_ROOT, '.harness', 'interfaces', changeName);
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });

  const destPath = join(archiveDir, 'interface-changes.yaml');
  copyFileSync(srcPath, destPath);

  const indexPath = join(PROJECT_ROOT, '.harness', 'interfaces', 'index.md');
  let indexContent = '# Interface Changes Index\n\n';
  if (existsSync(indexPath)) {
    const existingContent = readFileSync(indexPath, 'utf8');
    const headerMatch = existingContent.match(/^#.*?\n\n/);
    if (headerMatch) indexContent = headerMatch[0];
  }

  indexContent += `## ${changeName}\n\nArchived at: ${new Date().toISOString()}\n`;

  const tmpIndex = `${indexPath}.tmp`;
  writeFileSync(tmpIndex, indexContent, 'utf8');
  renameSync(tmpIndex, indexPath);

  output({
    change_name: changeName, archived: true,
    archive_path: destPath, index_updated: true
  });
}

// ─── CLI: parse-tasks-md ───

export function cmdParseTasksMd(args) {
  const changeDir = getArg(args, '--change-dir');
  if (!changeDir) errExit('Usage: orchestrator.js parse-tasks-md --change-dir <directory>');

  const workItems = parseTasksMdFn(changeDir);
  output({ work_items: workItems, count: workItems.length });
}

// ─── Intent Classification ───

let _icCache = null;
function parseIntentClassification() {
  if (_icCache) return _icCache;
  const defaults = {
    categoryRoleMap: [],
    confidenceThresholds: { HIGH: 0.85, MEDIUM: 0.70, LOW: 0.70 },
    followUpSuggestions: {},
    complexityThresholds: { quick_dispatch: 40, upgrade_to_full: 70, ask_pm: 55 },
    complexityWeights: { file_count: 35, module_impact: 25, code_complexity: 40 },
    complexityAnalysis: { lines_per_point: 12, complexity_per_point: 1.7, control_flow_weight: 2, function_weight: 3, indent_weight: 0.5 },
  };
  if (!existsSync(RULES_PATH)) return defaults;

  const yaml = loadRulesYaml(RULES_PATH);
  const ic = yaml?.intent_classification;
  if (!ic) return defaults;

  const categoryRoleMap = (ic.category_role_map || []).map(e => ({
    intent_category: e.intent_category,
    target_role: e.target_role,
    condition: e.condition || 'always',
  }));

  const confidenceThresholds = { ...defaults.confidenceThresholds, ...ic.confidence_thresholds };
  const complexityThresholds = { ...defaults.complexityThresholds, ...ic.complexity_thresholds };
  const complexityWeights = { ...defaults.complexityWeights, ...ic.complexity_weights };
  const complexityAnalysis = { ...defaults.complexityAnalysis, ...ic.complexity_analysis };
  const followUpSuggestions = ic.follow_up_suggestions || {};

  const result = { categoryRoleMap, confidenceThresholds, complexityThresholds, complexityWeights, complexityAnalysis, followUpSuggestions };
  _icCache = result;
  return result;
}

function routeIntent(intentCategory, affectedFiles) {
  const { categoryRoleMap } = parseIntentClassification();
  const numFiles = Array.isArray(affectedFiles) ? affectedFiles.length : (typeof affectedFiles === 'number' ? affectedFiles : 999);

  const matches = categoryRoleMap.filter(e => e.intent_category === intentCategory);
  if (matches.length === 0) return null;

  if (intentCategory === 'quick_change') {
    const selfEntry = matches.find(e => e.target_role === 'main_session_self' && /<=\s*2/.test(e.condition));
    if (selfEntry && numFiles <= 2) return 'main_session_self';
    const devEntry = matches.find(e => e.target_role === 'Developer');
    if (devEntry) return 'Developer';
  }

  if (intentCategory === 'complex_feature') return 'full pipeline';

  return matches[0].target_role;
}

function getConfidenceTier(confidence) {
  const { confidenceThresholds } = parseIntentClassification();
  if (confidence >= confidenceThresholds.HIGH) return 'HIGH';
  if (confidence >= confidenceThresholds.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

function getRoutingDecision(intent, complexity) {
  const { complexityThresholds, confidenceThresholds } = parseIntentClassification();
  const confidence = intent.confidence ?? 0.5;
  const targetRole = routeIntent(intent.intent_category, intent.affected_files);

  if (complexity >= complexityThresholds.upgrade_to_full) {
    return {
      action: 'upgrade_to_full', route_to: 'full pipeline',
      reason: `complexity ${complexity.toFixed(1)} >= ${complexityThresholds.upgrade_to_full}, upgrade to full pipeline recommended`,
    };
  }

  if (confidence < confidenceThresholds.LOW) {
    return {
      action: 'self_handle', route_to: targetRole,
      reason: `confidence ${confidence} < ${confidenceThresholds.LOW}, main session handles directly (complexity: ${complexity.toFixed(1)})`,
    };
  }

  if (complexity >= complexityThresholds.ask_pm && confidence < confidenceThresholds.MEDIUM) {
    return {
      action: 'needs_pm', route_to: targetRole,
      reason: `complexity ${complexity.toFixed(1)} in [${complexityThresholds.ask_pm}, ${complexityThresholds.upgrade_to_full}) and confidence ${confidence} < ${confidenceThresholds.MEDIUM}, PM confirmation needed`,
    };
  }

  if (complexity < complexityThresholds.quick_dispatch && confidence >= confidenceThresholds.MEDIUM) {
    return {
      action: 'auto_dispatch', route_to: targetRole,
      reason: `complexity ${complexity.toFixed(1)} < ${complexityThresholds.quick_dispatch} and confidence ${confidence} >= ${confidenceThresholds.MEDIUM}, auto dispatch`,
    };
  }

  if (complexity < complexityThresholds.upgrade_to_full && confidence >= confidenceThresholds.HIGH) {
    return {
      action: 'auto_dispatch', route_to: targetRole,
      reason: `complexity ${complexity.toFixed(1)} < ${complexityThresholds.upgrade_to_full} and confidence ${confidence} >= ${confidenceThresholds.HIGH}, auto dispatch`,
    };
  }

  if (confidence >= confidenceThresholds.MEDIUM && confidence < confidenceThresholds.HIGH) {
    return {
      action: 'needs_pm', route_to: targetRole,
      reason: `confidence ${confidence} in [${confidenceThresholds.MEDIUM}, ${confidenceThresholds.HIGH}), PM confirmation required (complexity: ${complexity.toFixed(1)})`,
    };
  }

  return {
    action: 'needs_pm', route_to: targetRole,
    reason: `complexity ${complexity.toFixed(1)} and confidence ${confidence} require PM judgment`,
  };
}

// ─── Complexity Estimation ───

const complexityAnalyzers = {
  file_count: (intent, weights) => {
    const numFiles = intent.affected_files?.length || 0;
    return Math.min(numFiles * 10, weights.file_count);
  },
  module_impact: (intent, weights) => {
    const numModules = intent.modules?.length || 0;
    return Math.min(numModules * 7, weights.module_impact);
  },
  code_complexity: (intent, weights) => {
    let codeScore = 0;
    if (intent.affected_files && intent.affected_files.length > 0) {
      codeScore = analyzeCodeComplexity(intent.affected_files);
    }
    return Math.min(codeScore, weights.code_complexity);
  },
};

function estimateComplexity(intent) {
  const { complexityWeights } = parseIntentClassification();
  let score = 0;

  for (const [key, weight] of Object.entries(complexityWeights)) {
    const analyzer = complexityAnalyzers[key];
    if (analyzer && typeof analyzer === 'function') {
      const dimensionScore = analyzer(intent, complexityWeights);
      score += dimensionScore;
    }
  }

  const totalWeight = Object.values(complexityWeights).reduce((sum, w) => sum + w, 0);
  const normalizedScore = totalWeight > 0 ? (score / totalWeight) * 100 : 0;

  return Math.min(normalizedScore, 100);
}

function analyzeCodeComplexity(files) {
  let totalLines = 0;
  let totalComplexity = 0;

  for (const file of files) {
    if (!existsSync(file)) {
      console.warn(`[complexity analysis] File not found: ${file}`);
      continue;
    }

    try {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n').length;
      const complexity = estimateFileComplexity(content);

      totalLines += lines;
      totalComplexity += complexity;
    } catch (e) {
      console.warn(`[complexity analysis] Failed to read file: ${file}`, e.message);
    }
  }

  const avgComplexity = files.length > 0 ? totalComplexity / files.length : 0;
  const lineFactor = Math.min(totalLines / 200, 1);
  const complexityFactor = Math.min(avgComplexity / 30, 1);

  return (lineFactor * 17) + (complexityFactor * 18);
}

function estimateFileComplexity(content) {
  const { complexityAnalysis } = parseIntentClassification();
  let complexity = 0;

  const codeWithoutComments = content
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '');

  const complexityPatterns = [
    { pattern: /\b(?:if|else\s+if|for|while|switch|case|catch|finally|try)\s*\(/g, weight: complexityAnalysis.control_flow_weight },
    { pattern: /\?/g, weight: complexityAnalysis.control_flow_weight },
    { pattern: /\b(?:function|def|fn)\s+\w+/g, weight: complexityAnalysis.function_weight },
    { pattern: /\b(?:public|private)\s+\w+\s+\w+\s*\(/g, weight: complexityAnalysis.function_weight },
  ];

  for (const { pattern, weight } of complexityPatterns) {
    const matches = codeWithoutComments.match(pattern);
    if (matches) complexity += matches.length * weight;
  }

  const lines = content.split('\n');
  let maxDepth = 0;
  for (const line of lines) {
    const indent = line.search(/\S/);
    if (indent > maxDepth) maxDepth = indent;
  }
  complexity += maxDepth * complexityAnalysis.indent_weight;

  return complexity;
}

function checkDuplicateDispatch(intentCategory, fileScope) {
  const activeTasks = stateListActive();
  const scopeSet = new Set(fileScope || []);

  for (const task of activeTasks) {
    if (task.current_phase === 'completed') continue;
    if (task.intent && task.intent.intent_category === intentCategory) {
      const taskFiles = new Set(task.intent.affected_files || []);
      const overlap = [...scopeSet].some(f => taskFiles.has(f));
      if (overlap || scopeSet.size === 0) {
        return { duplicate: true, existing_change: task.change_name, existing_phase: task.current_phase };
      }
    }
  }

  const tasksDir = getTasksDir();
  if (!existsSync(tasksDir)) return { duplicate: false };
  const allTasks = stateListAll();
  const now = Date.now();
  for (const task of allTasks) {
    if (!task.intent || task.intent.intent_category !== intentCategory) continue;
    const updated = task.updated_at ? new Date(task.updated_at).getTime() : 0;
    if (now - updated < 24 * 60 * 60 * 1000) {
      const taskFiles = new Set(task.intent.affected_files || []);
      const overlap = [...scopeSet].some(f => taskFiles.has(f));
      if (overlap || (scopeSet.size === 0 && task.intent.intent_category === intentCategory)) {
        return { duplicate: true, existing_change: task.change_name, existing_phase: task.current_phase, from_history: true };
      }
    }
  }

  return { duplicate: false };
}

// ─── CLI: quick-dispatch ───

export function cmdQuickDispatch(args) {
  const intentJson = getArg(args, '--intent-json');
  const changeName = getArg(args, '--change-name') || null;

  if (!intentJson) {
    errExit('quick-dispatch requires --intent-json');
  }

  let intent;
  try {
    intent = JSON.parse(intentJson);
  } catch (e) {
    errExit('Invalid JSON in --intent-json: ' + e.message);
  }

  const missingFields = [];
  if (!intent.intent_category) missingFields.push('intent_category');
  if (!intent.title) missingFields.push('title');
  if (!intent.criteria || (Array.isArray(intent.criteria) && intent.criteria.length === 0)) missingFields.push('criteria');

  if (missingFields.length > 0) {
    errExit(`Missing required fields in intent-json: ${missingFields.join(', ')}`);
  }

  if (!intent.task_type) intent.task_type = 'development';

  const confidence = typeof intent.confidence === 'number' ? intent.confidence : 0.5;
  const tier = getConfidenceTier(confidence);

  const complexity = estimateComplexity(intent);

  const routingDecision = getRoutingDecision(intent, complexity);

  const autoName = changeName || `quick-${intent.intent_category}-${Date.now()}`;
  const targetRole = routingDecision.route_to;

  switch (routingDecision.action) {
    case 'upgrade_to_full':
      return output({
        change_name: autoName, action: 'upgrade_to_full',
        confidence_tier: tier, complexity: complexity,
        target_role: 'full pipeline', upgrade_to_full: true,
        reason: routingDecision.reason, needs_pm: false,
        context_pack: assembleContextPack(null, intent, intent.context_mode || 'full'),
      });

    case 'self_handle':
      return output({
        change_name: autoName, action: 'self_handle',
        confidence_tier: tier, complexity: complexity,
        target_role: targetRole,
        reason: routingDecision.reason, needs_pm: false,
        context_pack: assembleContextPack(null, intent, intent.context_mode || 'full'),
      });

    case 'needs_pm': {
      const dup = checkDuplicateDispatch(intent.intent_category, intent.affected_files);
      if (dup.duplicate) {
        return output({
          change_name: dup.existing_change, action: 'duplicate_detected',
          confidence_tier: tier, complexity: complexity,
          target_role: targetRole,
          reason: `Duplicate dispatch detected: '${dup.existing_change}' is at phase ${dup.existing_phase}${dup.from_history ? ' (from recent history)' : ''}`,
          needs_pm: true,
          context_pack: assembleContextPack(null, intent, intent.context_mode || 'full'),
        });
      }

      return output({
        change_name: autoName, action: 'needs_pm_confirmation',
        confidence_tier: tier, complexity: complexity,
        target_role: targetRole ? targetRole.toLowerCase() : null,
        reason: routingDecision.reason, needs_pm: true,
        context_pack: assembleContextPack(null, intent, intent.context_mode || 'full'),
      });
    }

    case 'auto_dispatch': {
      const dup2 = checkDuplicateDispatch(intent.intent_category, intent.affected_files);
      if (dup2.duplicate) {
        return output({
          change_name: dup2.existing_change, action: 'duplicate_detected',
          confidence_tier: tier, complexity: complexity,
          target_role: targetRole,
          reason: `Duplicate dispatch detected: '${dup2.existing_change}' is at phase ${dup2.existing_phase}${dup2.from_history ? ' (from recent history)' : ''}`,
          needs_pm: true,
          context_pack: assembleContextPack(null, intent, intent.context_mode || 'full'),
        });
      }

      const state = stateInit(autoName, intent.title, Array.isArray(intent.criteria) ? intent.criteria : [intent.criteria], 'quick', false, {});
      state.intent = { ...intent, parsed_at: new Date().toISOString(), confidence_tier: tier, target_role: targetRole, complexity };
      stateSave(autoName, state);

      const contextPack = assembleContextPack(autoName, intent, intent.context_mode || 'full');

      const { followUpSuggestions } = parseIntentClassification();
      const followUps = followUpSuggestions[intent.intent_category] || [];

      return output({
        change_name: autoName, action: 'auto_dispatch',
        confidence_tier: tier, complexity: complexity,
        target_role: targetRole ? targetRole.toLowerCase() : null,
        reason: routingDecision.reason, needs_pm: false,
        pipeline: 'quick', flow_type: 'quick', current_phase: 'pending',
        context_pack: contextPack,
        follow_up_suggestions: followUps.slice(0, 3),
      });
    }

    default:
      errExit(`Unknown routing action: ${routingDecision.action}`);
  }
}
