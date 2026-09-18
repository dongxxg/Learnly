'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseArgs } = require('./lib/argv');
const { subRepoDirs } = require('./lib/harness-projects');

// --- CST date helper (统一走 lib/time.js) ---
const { todayCST, isDateMatch } = require('./lib/time');

// --- Auto-detect backend directory (claude/codex/codebuddy/qoder/zcode) ---
// 解析顺序（高 → 低）：
//   1. HARNESS_BACKEND env（用户/hook 显式指定）
//   2. 当前运行 client 对应目录（detectClient 识别 claude-code/codex/codebuddy/qoder）
//   3. 存在性 fallback 列表（codebuddy 等无 client 信号时）
// Bug: 原 fallback 优先级硬编码 .codebuddy>.codex>.claude，当机器同时存在
//   ~/.codebuddy 与 ~/.claude 时，Claude Code session 的 token 被错误地从
//   ~/.codebuddy 采集（当前 session 数据在 ~/.claude，结果 session_count=0、token 全 0）。
// 修复：当前 client 对应目录优先于存在性 fallback，避免读到别的 backend 的数据。
// 返回 client 名对应的 backend 逻辑名（不含点前缀，可作 backendDataDir 输入；
// detectCurrentBackend 也以它作为 by_backend 分组名）
function clientBackendDir(clientName) {
  switch (clientName) {
    case 'claude-code': return '.claude';
    case 'codex':       return '.codex';
    case 'codebuddy':   return '.codebuddy';
    case 'qoder':       return '.qoder';
    case 'zcode':       return '.zcode';
    default:            return null;  // cursor 等无映射 → 走存在性 fallback
  }
}

function backendDataDir(backendName) {
  const normalized = String(backendName || '').toLowerCase();
  if (normalized === 'zcode') {
    return process.env.ZCODE_PLUGIN_DATA || path.join(os.homedir(), '.zcode', 'uni-auri');
  }
  // qoder 配置 root 是 ~/.qoder（targets.json rootDir），但数据目录在 ~/.qoder-cn
  // （对齐 targets.json HARNESS_USAGE_DIR/PROJECTS_DIR 与 QoderBackend.getDataDir）
  if (normalized === 'qoder') {
    return path.join(os.homedir(), '.qoder-cn');
  }
  return path.join(os.homedir(), '.' + normalized);
}

function detectBackendDir(subdir) {
  // 1. HARNESS_BACKEND 显式指定优先
  const be = process.env.HARNESS_BACKEND;
  if (be) {
    const p = path.join(backendDataDir(be), subdir);
    if (fs.existsSync(p)) return p;
  }
  // 2. 当前运行 client 对应目录（修复：避免 claude-code 读到 .codebuddy）
  const clientDir = clientBackendDir(detectClient(process.env).name);
  if (clientDir) {
    const p = path.join(backendDataDir(clientDir.slice(1)), subdir);
    if (fs.existsSync(p)) return p;
  }
  // 3. 存在性 fallback：codebuddy/cursor 等无 client 信号时
  for (const bd of ['.zcode', '.qoder', '.codebuddy', '.codex', '.claude']) {
    const p = path.join(backendDataDir(bd.slice(1)), subdir);
    if (fs.existsSync(p)) return p;
  }
  return path.join(os.homedir(), '.claude', subdir);
}

// --- Detect current backend name (claude/codex/codebuddy/qoder/zcode) ---
// 复用 detectBackendDir 同优先级（HARNESS_BACKEND > client dir > 存在性 fallback），
// 返回 backend 名而非路径。用于 token_usage.backend 缺失时按当前客户端兜底（issue !226 Bug1）。
// 全部推断失败返回 null（调用方归 unknown），与 detectBackendDir 的路径兜底语义不同。
let _cachedCurrentBackend;
function detectCurrentBackend() {
  if (_cachedCurrentBackend !== undefined) return _cachedCurrentBackend;
  const be = process.env.HARNESS_BACKEND;
  if (be) { _cachedCurrentBackend = be; return be; }
  const clientDir = clientBackendDir(detectClient(process.env).name);
  if (clientDir) {
    const name = clientDir.slice(1); // '.claude' → 'claude'
    _cachedCurrentBackend = name;
    return name;
  }
  for (const bd of ['.zcode', '.qoder', '.codebuddy', '.codex', '.claude']) {
    if (fs.existsSync(path.join(backendDataDir(bd.slice(1)), 'usage'))) {
      const name = bd.slice(1);
      _cachedCurrentBackend = name;
      return name;
    }
  }
  _cachedCurrentBackend = null;
  return null;
}

// --- Phase-to-role mapping ---
// Design review note: intake/smoke phases map to null (system auto), not counted in role stats
// Issue !189 Bug1: design-review 实际角色是 developer（harness-rules.yaml:760-762），
// 原映射 architect 致 by_role 桶错位。
// Issue !194: quick-flow 的 dispatch/verify 阶段角色依赖 state.intent.intent_category
// 动态路由（见 advance.js resolveQuickFlowRole），静态表无法表达——dispatch 通过
// resolveDispatchRole(state) 动态查，verify 兜底 developer（最常见）。
const PHASE_ROLE_MAP = {
  explore: 'architect',
  propose: 'architect',
  'design-review': 'developer',
  implement: 'developer',
  test: 'tester',
  smoke: null,
  'code-review': 'reviewer',
  debate: 'reviewer',
  intake: null,
  // quick-flow 阶段
  verify: 'developer',
};

// Issue !194: quick-flow dispatch 阶段角色按 intent_category 路由
// 复刻 advance.js resolveQuickFlowRole 逻辑（不能 import ESM，此处内联副本）
function resolveDispatchRole(state) {
  if (!state || state.flow_type !== 'quick') return 'developer';
  const cat = state.intent && state.intent.intent_category;
  switch (cat) {
    case 'bug_fix':        return 'developer';
    case 'code_review':    return 'reviewer';
    case 'testing':        return 'tester';
    case 'explore_design': return 'architect';
    case 'quick_change': {
      const n = (state.intent && state.intent.affected_files || []).length;
      return n >= 3 ? 'developer' : null;  // <=2 files: 主会话自处理
    }
    default: return 'developer';  // 兜底
  }
}

// 根据 phase + state 解析角色：先查静态表，dispatch 阶段特殊处理（quick-flow 动态路由）
function resolvePhaseRole(phase, state) {
  if (phase === 'dispatch') return resolveDispatchRole(state);
  return PHASE_ROLE_MAP[phase] || null;
}

// --- SPEC terminal phases ---
const TERMINAL_PHASES = new Set(['archive', 'merge-prep', 'completed', 'complete']);

// --- Empty output structure ---
function emptyOutput(date, cwd) {
  const emptyTriggerBucket = () => ({ dispatch_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, by_role: {}, by_model: {} });
  // by_backend bucket：按 backend 分组聚合 token（Claude/Codex 各算各的，不求和）
  // 字段语义与 stats.js 对齐：null 表示「该 backend 下不可用」（如 codex 的 input/output/cached）
  const emptyBackendBucket = () => ({
    dispatch_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    model: null,
    _modelCounts: {},
    _seen: { input: false, output: false, cached: false, reasoning: false, total: false },
  });
  const harnessVersion = readHarnessVersion(cwd);
  const client = detectClient(process.env);

  return {
    date,
    harness_version: harnessVersion,
    client_name: client.name,
    client_version: client.version,
    tasks: [],
    summary: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_dispatches: 0,
      total_wall_clock_ms: 0,
      // Dispatch breakdown by trigger type (pipeline = AI自动调度, natural = 人工调度)
      dispatch_by_trigger: {
        pipeline: emptyTriggerBucket(),
        natural: emptyTriggerBucket(),
        // Issue !279: 主会话直出（无 dispatch）用量单列 main 桶。不计入 total_dispatches
        // 与 total_*（口径同 PM 确认：调度统计表单列，dispatch 口径不混入）。
        main: emptyTriggerBucket(),
      },
      // 新增维度：按 backend 分组聚合 token（Claude/Codex 不混合求和）
      by_backend: {},
      backend_fallback_count: 0,
      spec_stats: { total_changes: 0, closed_loop: 0, open: 0, by_phase: {} },
      concern_stats: { total: 0, p0_found: 0, p0_closed: 0, p1_found: 0, p1_closed: 0, p2_found: 0, p2_closed: 0, missing_author_skipped: 0, details: [] },
      // 采样缺口计数：usage.jsonl 中 tokens:null 的短命 subagent 记录数
      sampled_gap_count: 0,
      session_input_tokens: 0,
      session_output_tokens: 0,
      session_cache_creation_input_tokens: 0,
      session_cache_read_input_tokens: 0,
      session_total_tokens: 0,
      session_reasoning_tokens: 0,
      session_count: 0,
      session_by_project: {},
      session_by_model: {},
    },
  };
}

// 把单条 dispatch 的 token_usage（pipeline-state）或 entry.tokens（usage.jsonl）聚合到 by_backend
// backend 兜底：缺失 → 按当前客户端估算（detectCurrentBackend，issue !226 Bug1），仍失败 → 'unknown'；
// 未知值 → 'unknown' + stderr 告警（去重，与 stats.js 一致）
const _warnedUnknownBackendsCollectAi = new Set();
function aggregateByBackend(summary, backend, normalized) {
  if (!backend) {
    // issue !226 Bug1: 缺失 backend 按当前客户端估算，不再硬编码 claude
    backend = detectCurrentBackend() || 'unknown';
    summary.backend_fallback_count++;
  } else if (!['claude', 'codex', 'codebuddy', 'qoder', 'zcode'].includes(backend)) {
    if (!_warnedUnknownBackendsCollectAi.has(backend)) {
      _warnedUnknownBackendsCollectAi.add(backend);
      console.error(`[harness] Warning: Unknown backend value: ${backend} (aggregated into 'unknown' group)`);
    }
    backend = 'unknown';
  }
  if (!summary.by_backend[backend]) summary.by_backend[backend] = {
    dispatch_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
    model: null,
    _modelCounts: {},
    _seen: { input: false, output: false, cached: false, reasoning: false, total: false },
  };
  const b = summary.by_backend[backend];
  b.dispatch_count++;
  if (normalized.input !== null) { b.input_tokens += normalized.input; b._seen.input = true; }
  if (normalized.output !== null) { b.output_tokens += normalized.output; b._seen.output = true; }
  if (normalized.cached !== null) { b.cached_tokens += normalized.cached; b._seen.cached = true; }
  if (normalized.reasoning !== null) { b.reasoning_tokens += normalized.reasoning; b._seen.reasoning = true; }
  if (normalized.total !== null) { b.total_tokens += normalized.total; b._seen.total = true; }
  if (normalized.model) {
    b._modelCounts[normalized.model] = (b._modelCounts[normalized.model] || 0) + 1;
  }
}

// 把 pipeline-state.json 的 token_usage（Claude transcript 格式 / Codex 单值）归一化
// 与 stats.js normalizeTokenUsage 对齐（重复实现以避免 cross-module import）
function normalizeTokenUsageForReport(rawTokens, backend) {
  const be = (backend || detectCurrentBackend() || 'unknown').toLowerCase();
  const t = rawTokens || {};
  if (be === 'codex' || be === 'qoder') {
    // !262: dispatch 层透传后 codex 也有结构化明细（input/cached/output/reasoning）；
    // 无明细时保持 total-only（旧数据兜底），不在此丢弃已存在的字段。
    return {
      input: typeof t.input_tokens === 'number' ? t.input_tokens : null,
      output: typeof t.output_tokens === 'number' ? t.output_tokens : null,
      cached: typeof t.cache_read_input_tokens === 'number' ? t.cache_read_input_tokens : null,
      reasoning: typeof t.reasoning_output_tokens === 'number' ? t.reasoning_output_tokens : null,
      total: typeof t.total === 'number' ? t.total : null,
      model: typeof t.model === 'string' ? t.model : null,
    };
  }
  if (be === 'claude' || be === 'codebuddy') {
    return {
      input: typeof t.input_tokens === 'number' ? t.input_tokens : null,
      output: typeof t.output_tokens === 'number' ? t.output_tokens : null,
      cached: typeof t.cache_read_input_tokens === 'number' ? t.cache_read_input_tokens : null,
      reasoning: null,
      total: null,
      model: typeof t.model === 'string' ? t.model : null,
    };
  }
  if (be === 'zcode') {
    // Issue #282: zcode token_usage 已从 model-io 日志聚合落盘（claude 格式明细；
    // 显式 --tokens 透传时为 {total} 单值）——映射真实字段，不再全 null。
    // 与 stats.js normalizeTokenUsage zcode 分支保持同步（同款内联副本）。
    return {
      input: typeof t.input_tokens === 'number' ? t.input_tokens : null,
      output: typeof t.output_tokens === 'number' ? t.output_tokens : null,
      cached: typeof t.cache_read_input_tokens === 'number' ? t.cache_read_input_tokens : null,
      reasoning: typeof t.reasoning_output_tokens === 'number' ? t.reasoning_output_tokens : null,
      total: typeof t.total === 'number' ? t.total : null,
      model: typeof t.model === 'string' ? t.model : null,
    };
  }
  // unknown backend
  return { input: null, output: null, cached: null, reasoning: null, total: null, model: null };
}

// Finalize by_backend bucket：dominant model + 未见过非 null 的字段设 null
function finalizeByBackend(summary) {
  for (const bucket of Object.values(summary.by_backend)) {
    const entries = Object.entries(bucket._modelCounts || {});
    if (entries.length > 0) {
      bucket.model = entries.sort((a, b) => b[1] - a[1])[0][0];
    }
    delete bucket._modelCounts;
    const seen = bucket._seen || {};
    if (!seen.input) bucket.input_tokens = null;
    if (!seen.output) bucket.output_tokens = null;
    if (!seen.cached) bucket.cached_tokens = null;
    if (!seen.reasoning) bucket.reasoning_tokens = null;
    if (!seen.total) bucket.total_tokens = null;
    delete bucket._seen;
  }
}

// usage.jsonl 条目归一化（字段名：input/output/cache_read/cache_creation/total/model）
// 与 pipeline-state 的 normalizeTokenUsageForReport 区别：字段名不同（无 _input_tokens 后缀）
function normalizeUsageJsonlTokens(tokens, backend) {
  const be = (backend || detectCurrentBackend() || 'unknown').toLowerCase();
  const t = tokens || {};
  if (be === 'codex' || be === 'qoder') {
    // !262: 与 pipeline-state 归一化对齐——codex 明细透传后不再丢弃；无明细时 total-only 兜底。
    return {
      input: typeof t.input === 'number' ? t.input : null,
      output: typeof t.output === 'number' ? t.output : null,
      cached: typeof t.cache_read === 'number' ? t.cache_read : null,
      reasoning: null,
      total: typeof t.total === 'number' ? t.total : null,
      model: typeof t.model === 'string' ? t.model : null,
    };
  }
  if (be === 'claude' || be === 'codebuddy') {
    return {
      input: typeof t.input === 'number' ? t.input : null,
      output: typeof t.output === 'number' ? t.output : null,
      cached: typeof t.cache_read === 'number' ? t.cache_read : null,
      reasoning: null,
      total: null,
      model: typeof t.model === 'string' ? t.model : null,
    };
  }
  if (be === 'zcode') {
    // Issue #282: record-usage zcode 分支已写入真实 tokens（聚合明细 {input/output/
    // cache_read/cache_creation/model} 或显式 --tokens 的 {total}）——映射真实字段。
    return {
      input: typeof t.input === 'number' ? t.input : null,
      output: typeof t.output === 'number' ? t.output : null,
      cached: typeof t.cache_read === 'number' ? t.cache_read : null,
      reasoning: null,
      total: typeof t.total === 'number' ? t.total : null,
      model: typeof t.model === 'string' ? t.model : null,
    };
  }
  return { input: null, output: null, cached: null, reasoning: null, total: null, model: null };
}

// --- Main ---
function main() {
  const args = parseArgs(process.argv, {
    options: { date: todayCST(), cwd: '', user: '' },
  });

  if (args.options.cwd) {
    try {
      process.chdir(args.options.cwd);
    } catch (e) {
      process.stderr.write(`[collect-ai] failed to chdir to "${args.options.cwd}": ${e.message}\n`);
      process.exit(1);
    }
  }

  const targetDate = args.options.date;
  const cwd = process.cwd();
  // Issue !239: 主仓 + .harness-projects 子仓的 tasks 目录都扫，子仓 pipeline dispatch 补采。
  // 全局 token/session（collectUsageJsonl / collectSessionTokens）仍在下方只主仓采一次。
  const tasksDirs = [path.join(cwd, '.harness', 'tasks')];
  for (const sub of subRepoDirs(cwd)) {
    tasksDirs.push(path.join(sub, '.harness', 'tasks'));
  }

  // Issue !190: 今日有 dispatch 活动的 change_name 集合，用于过滤 concern_stats，
  // 避免历史 concerns 污染业务日报。
  const activeChangeNames = new Set();

  const output = emptyOutput(targetDate, cwd);

  // 按物理路径去重：主仓可能被 .harness-projects 重复列出，避免 dispatch 重复累加
  const scannedTasksDirs = new Set();
  // Issue !239 P2-2: concern_stats 只读主仓 shared-state，activeChangeNames 只在主仓累积，
  // 避免子仓同名 change 误激活主仓 concerns（子仓 dispatch 仍计入 summary/tasks）
  const isMainTasksDir = path.resolve(tasksDirs[0]);
  for (const tasksDir of tasksDirs) {
    try {
      const real = fs.realpathSync(tasksDir);
      if (scannedTasksDirs.has(real)) continue;
      scannedTasksDirs.add(real);
    } catch (_) { /* tasks dir 不存在 */ }
    if (!fs.existsSync(tasksDir)) continue;

    let subdirs;
    try {
      subdirs = fs.readdirSync(tasksDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (e) {
      subdirs = [];
    }

    // Issue !218/!219：扫描 archive/ 子目录下的已归档 change，避免 dispatch 漏采
    const archiveDir = path.join(tasksDir, 'archive');
    if (fs.existsSync(archiveDir)) {
      try {
        const archived = fs.readdirSync(archiveDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join('archive', d.name));
        subdirs = subdirs.concat(archived);
      } catch (e) {
        // ignore
      }
    }

    for (const dirName of subdirs) {
      const stateFile = path.join(tasksDir, dirName, 'pipeline-state.json');
      if (!fs.existsSync(stateFile)) continue;

      let state;
      try {
        const raw = fs.readFileSync(stateFile, 'utf-8');
        state = JSON.parse(raw);
      } catch (e) {
        process.stderr.write(`[collect-ai] WARNING: skipping ${dirName}/pipeline-state.json: ${e.message}\n`);
        continue;
      }

      if (!state.pipeline) continue;

      // --- SPEC stats (global snapshot, not date-filtered) ---
      // Must be before the dispatch-matching continue (C1 from design-review)
      const currentPhase = state.current_phase || '';
      const completedAt = state.completed_at || null;
      output.summary.spec_stats.total_changes += 1;
      if (TERMINAL_PHASES.has(currentPhase) || completedAt) {
        output.summary.spec_stats.closed_loop += 1;
      } else {
        output.summary.spec_stats.open += 1;
      }
      if (currentPhase) {
        output.summary.spec_stats.by_phase[currentPhase] = (output.summary.spec_stats.by_phase[currentPhase] || 0) + 1;
      }

      // Collect matching dispatches from all phases
      const taskDispatches = [];
      for (const [phaseName, phaseData] of Object.entries(state.pipeline)) {
        const history = phaseData && phaseData.dispatch_history;
        if (!Array.isArray(history)) {
          // Issue !271 根因3：部分 codex/Auto 流水线的 pipeline-state 只有阶段级
          // started_at/completed_at、无 dispatch_history 数组 → 原逻辑整段跳过漏采。
          // 兜底：有真实角色（intake/smoke 等自动阶段 role 为 null 不计）、锚定日命中
          // 目标日的阶段计 1 条 dispatch，token 记 null 不凭空补数。
          const anchor = phaseData && (phaseData.started_at || phaseData.completed_at);
          if (!anchor || !resolvePhaseRole(phaseName, state)) continue;
          if (!isDateMatch(anchor, targetDate)) continue;
          taskDispatches.push({
            phase: phaseName,
            started_at: phaseData.started_at || phaseData.completed_at,
            completed_at: phaseData.completed_at || null,
            token_usage: null,
            exit_status: phaseData.exit_status || null,
          });
          continue;
        }

        for (const dispatch of history) {
          // Issue #282: started_at 为 null 的 dispatch 不再整条丢弃（mark-dispatch --end
          // 无对应 --start 时写 started_at:null，limt 实测 code-review dispatch 因此漏统）。
          // 日期归档改用 started_at ?? completed_at：completed_at 命中目标日期仍计入
          // dispatch 计数；token_usage 缺失时按 0 计（不凭空补数）。
          const dateAnchor = dispatch.started_at || dispatch.completed_at;
          if (!dateAnchor) continue; // 两个时间戳都缺 → 无法归档日期，跳过
          if (!isDateMatch(dateAnchor, targetDate)) continue;

          // Issue !210: 归一化 token_usage——残缺对象（如 {backend:"claude"} 无真实 token 字段）
          // 归成 null，避免污染报表 JSON 和 by_role/by_model 聚合
          const rawTokens = dispatch.token_usage;
          const normalizedTokens = (rawTokens && typeof rawTokens === 'object' &&
            (rawTokens.input_tokens != null || rawTokens.output_tokens != null ||
             rawTokens.cache_read_input_tokens != null || rawTokens.cache_creation_input_tokens != null ||
             rawTokens.total != null))
            ? rawTokens
            : null;

          taskDispatches.push({
            phase: phaseName,
            // schema Dispatch.started_at 必为 string（不可 null）：无 started_at 时以
            // completed_at 兜底（与 usage.jsonl 虚拟任务的 started_at: d.started_at || d.ts 同款）
            started_at: dispatch.started_at || dispatch.completed_at,
            completed_at: dispatch.completed_at || null,
            token_usage: normalizedTokens,
            exit_status: dispatch.exit_status || null,
          });
        }
      }

      if (taskDispatches.length === 0) continue;

      // Issue !190: 记录"今日有 dispatch 活动"的 change_name，供 concern_stats 过滤。
      // shared-state 目录用 change_name（不是 task dirName），故必须有 state.change_name 才能关联。
      if (state.change_name && path.resolve(tasksDir) === isMainTasksDir) {
        activeChangeNames.add(state.change_name);
      }

      // Build task entry
      const taskEntry = {
        change_name: state.change_name || dirName,
        caller: state.caller || '',
        title: state.title || state.change_name || dirName,
        current_phase: state.current_phase || '',
        phases_completed: (state.quality_metrics && state.quality_metrics.phases_completed) || 0,
        phases_total: (state.quality_metrics && state.quality_metrics.phases_total) || 0,
        scores: state.scores || {},
        quality_metrics: normalizeQualityMetrics(state.quality_metrics),
        dispatches: taskDispatches,
      };
      output.tasks.push(taskEntry);

      // Aggregate into summary
      for (const d of taskDispatches) {
        const role = resolvePhaseRole(d.phase, state);
        const tokens = d.token_usage || {};
        let inputTokens = tokens.input_tokens || 0;
        let outputTokens = tokens.output_tokens || 0;
        let cacheReadTokens = tokens.cache_read_input_tokens || 0;
        let cacheCreationTokens = tokens.cache_creation_input_tokens || 0;

        // Issue #234 Fix: codex backend 只存 {total: N}，需拆分兜底
        const hasDetailedSplit = tokens.input_tokens != null || tokens.output_tokens != null;
        if (!hasDetailedSplit && tokens.total > 0) {
          // codex 单值 total：output 通常远小于 total，把 total 全部当 input 累加
          inputTokens = tokens.total;
          outputTokens = 0;
        }

        output.summary.total_input_tokens += inputTokens;
        output.summary.total_output_tokens += outputTokens;
        output.summary.total_dispatches += 1;

        // Pipeline trigger aggregation
        const pipelineTrigger = output.summary.dispatch_by_trigger.pipeline;
        pipelineTrigger.dispatch_count += 1;
        pipelineTrigger.input_tokens += inputTokens;
        pipelineTrigger.output_tokens += outputTokens;
        pipelineTrigger.cache_read_tokens += cacheReadTokens;
        pipelineTrigger.cache_creation_tokens += cacheCreationTokens;

        // by_backend 聚合：从 token_usage.backend 读取，缺失按当前客户端兜底（issue !226 Bug1）
        const backend = tokens.backend || null;
        const normalized = normalizeTokenUsageForReport(tokens, backend);
        aggregateByBackend(output.summary, backend, normalized);

        if (role) {
          if (!pipelineTrigger.by_role[role]) {
            pipelineTrigger.by_role[role] = { dispatch_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
          }
          pipelineTrigger.by_role[role].dispatch_count += 1;
          pipelineTrigger.by_role[role].input_tokens += inputTokens;
          pipelineTrigger.by_role[role].output_tokens += outputTokens;
          pipelineTrigger.by_role[role].cache_read_tokens += cacheReadTokens;
          pipelineTrigger.by_role[role].cache_creation_tokens += cacheCreationTokens;
        }

        // Model aggregation (pipeline trigger)
        const model = tokens.model || 'unknown';
        if (!pipelineTrigger.by_model[model]) {
          pipelineTrigger.by_model[model] = { dispatch_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
        }
        pipelineTrigger.by_model[model].dispatch_count += 1;
        pipelineTrigger.by_model[model].input_tokens += inputTokens;
        pipelineTrigger.by_model[model].output_tokens += outputTokens;
        pipelineTrigger.by_model[model].cache_read_tokens += cacheReadTokens;
        pipelineTrigger.by_model[model].cache_creation_tokens += cacheCreationTokens;

        // Aggregate wall clock per dispatch
        if (d.started_at && d.completed_at) {
          const startMs = new Date(d.started_at).getTime();
          const endMs = new Date(d.completed_at).getTime();
          if (!isNaN(startMs) && !isNaN(endMs)) {
            output.summary.total_wall_clock_ms += (endMs - startMs);
          }
        }
      }
    }
  }

  // For wall clock: prefer quality_metrics total_wall_clock_ms when available across tasks
  // （主仓 + 子仓全部 tasks 汇总后计算，须在扫描循环外）
  let qualityWallClock = 0;
  let hasQualityWallClock = false;
  for (const task of output.tasks) {
    if (task.quality_metrics && task.quality_metrics.total_wall_clock_ms != null) {
      qualityWallClock += task.quality_metrics.total_wall_clock_ms;
      hasQualityWallClock = true;
    }
  }
  if (hasQualityWallClock) {
    output.summary.total_wall_clock_ms = qualityWallClock;
  }

  // --- Concern stats (global snapshot from shared-state) ---
  // Issue !157+!159: --user 过滤只统计当前用户的 concerns，避免把他人 P0/P1 算到自己头上
  // Issue !190: 只统计今日有 dispatch 活动的 change，避免历史 concerns 污染业务日报
  collectConcernStats(cwd, output, args.options.user || '', activeChangeNames, targetDate);

  // --- Usage tracking from ~/.claude/usage/usage.jsonl ---
  collectUsageJsonl(targetDate, output);

  // --- Session token stats (all local Claude Code sessions today) ---
  collectSessionTokens(targetDate, output);

  // --- Codex session token stats (Issue !242) ---
  collectCodexSessionTokens(targetDate, output);

  // --- ZCode model-io session token stats (Issue #277) ---
  collectZcodeSessionTokens(targetDate, output);

  // --- Finalize by_backend buckets（dominant model + null 语义）---
  finalizeByBackend(output.summary);

  // Codex CLI 会带 reasoning_output_tokens，但 daily-report schema 的 Dispatch.TokenUsage
  // 是 additionalProperties:false。聚合侧已消费该字段，仅在最终 JSON 输出前剥离。
  for (const task of output.tasks) {
    for (const dispatch of task.dispatches || []) {
      if (dispatch.token_usage && typeof dispatch.token_usage === 'object') {
        delete dispatch.token_usage.reasoning_output_tokens;
      }
    }
  }

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

// --- Collect concern stats from .harness/shared-state/*/concerns.json ---
// Issue !157+!159: userFilter 非空时按 concern.author 过滤，只统计当前用户的 concerns。
//   - concern.author 缺失 → 不计入个人统计（!186 起由 fail-open 收紧为 skip），
//     warn 一次 + 计数进 concern_stats.missing_author_skipped，由 render-report
//     在日报明示「N 条未计入」（Issue !278：静默 skip 会让用户误以为零问题）
//   - userFilter 为空串 → 不过滤（向后兼容，保持现有行为）
// --- Issue !259: concern status 读侧容错 ---
// status 词表只在写入路径强制（write-shared-state → normalizeConcerns，仅认
// open/resolved/deferred/dismissed）；AI 用 Write/Edit 直改 concerns.json 可绕过，
// 产出 "fixed" 等非规范词。读取侧（本函数群）按下面的同义词集归一化，仅影响内存
// 判断，不回写文件。
// ⚠ keep-in-sync：与 $HARNESS_ROOT/skills/rd-auto/scripts/lib/concerns.js 的
// RESOLVED_SYNONYMS 保持同步（collect-ai 是 CJS、rd-auto lib 是 ESM，不共享
// import，内联复制）；tests/collect-ai-status.test.mjs 做漂移对账。
// 不含 wontfix（语义近 dismissed，不并入 resolved）；deferred/dismissed 维持
// 不计 closed（推迟 ≠ 解决）。
const RESOLVED_SYNONYMS = ['resolved', 'fixed', 'closed', 'done', '已修复', '已解决', '已关闭'];
const CANONICAL_STATUS_VALUES = ['open', 'resolved', 'deferred', 'dismissed'];

function isResolvedStatus(status) {
  return RESOLVED_SYNONYMS.includes(String(status).trim().toLowerCase());
}

// Issue !190: activeChangeNames 非空时只统计今日活跃 change 的 concerns，避免历史污染。
//   - activeChangeNames 为 null/undefined → 不过滤（向后兼容）
//   - concernDir 不在集合内 → 跳过
function collectConcernStats(cwd, output, userFilter, activeChangeNames, targetDate) {
  const sharedStateDir = path.join(cwd, '.harness', 'shared-state');
  if (!fs.existsSync(sharedStateDir)) return;

  let concernSubdirs;
  try {
    concernSubdirs = fs.readdirSync(sharedStateDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    return;
  }

  const filterByUser = !!(userFilter && userFilter.trim());
  const targetUser = userFilter ? userFilter.trim() : '';
  // Issue !190: 只在「今日有 dispatch 活动」时按活跃 change 过滤（防历史污染）。
  // 注意 new Set() 是 truthy，空 Set 必须用 size>0 判断，否则当日无 dispatch 时
  // 会把所有 concerns 过滤掉，导致日报 P0/P1/P2 全为 0。
  const filterByChange = !!activeChangeNames && activeChangeNames.size > 0;
  // 无今日活跃 change 时，退化为按 concern.created_at 近 7 天过滤（时间窗），
  // 避免把历史/已归档 change 的评审问题计入当日日报；created_at 缺失的保留（不丢 P0）。
  const CONCERN_WINDOW_DAYS = 7;
  let windowStartMs = null;
  if (targetDate) {
    const dayEnd = new Date(targetDate + 'T23:59:59').getTime();
    if (!isNaN(dayEnd)) windowStartMs = dayEnd - CONCERN_WINDOW_DAYS * 24 * 3600 * 1000;
  }
  let warnedMissingAuthor = false;
  // Issue !259: 非规范 status 词的一次性告警（沿用 warnedMissingAuthor 模式）
  let warnedNonCanonicalStatus = false;
  let warnedUnknownStatus = false;

  for (const concernDir of concernSubdirs) {
    // Issue !190: 只统计今日活跃 change 的 concerns
    if (filterByChange && !activeChangeNames.has(concernDir)) continue;

    const concernsFile = path.join(sharedStateDir, concernDir, 'concerns.json');
    if (!fs.existsSync(concernsFile)) continue;

    let concernsData;
    try {
      concernsData = JSON.parse(fs.readFileSync(concernsFile, 'utf-8'));
    } catch (e) {
      continue;
    }

    // dual-schema 兼容（issue !151 Bug 3）：
    //   - 新 schema {concerns: [...]}（concerns-schema.json，ID ^C[0-9]+$）
    //   - 老 schema {p0: [...], p1: [...]}（按 severity 分组，ID P0-001，老 shared-state 数据沿用）
    // 老数据每条已含 severity: 'P0'/'P1' + status: 'open'/'resolved'，合并后能被后续解析逻辑识别。
    let concerns = concernsData.concerns;
    if (!Array.isArray(concerns)) {
      const p0 = Array.isArray(concernsData.p0) ? concernsData.p0 : [];
      const p1 = Array.isArray(concernsData.p1) ? concernsData.p1 : [];
      concerns = [...p0, ...p1];
    }
    if (!concerns.length) continue;

    for (const c of concerns) {
      // Issue !157+!159: 按 author 字段过滤
      // Issue !186: 收紧 fail-open——无 author 的 concerns 在 --user 过滤模式下
      // 不计入个人日报（旧数据兼容期已过；保留 warn 提示用户升级写入端）。
      // 原 fail-open 行为会把无 author 的历史/框架 concerns 全算到当前 user 头上。
      if (filterByUser) {
        if (c.author === undefined || c.author === null || c.author === '') {
          if (!warnedMissingAuthor) {
            process.stderr.write(
              `[collect-ai] WARNING: concerns in ${concernDir}/concerns.json missing "author" field. `
              + `Skipping them (--user filter). Please upgrade Reviewer/Debate agents to write \`author\` field. `
              + `(see $HARNESS_ROOT/skills/rd-auto/references/shared-state.md)\n`
            );
            warnedMissingAuthor = true;
          }
          // Issue !278: skip 不再静默——计数供日报明示「N 条未计入」
          output.summary.concern_stats.missing_author_skipped += 1;
          continue;  // !186: 跳过无 author，不再 fail-open
        } else if (String(c.author).trim() !== targetUser) {
          // 他人的 concern：跳过
          continue;
        }
      }

      // 无今日活跃 change 时：按 created_at 近 7 天过滤（时间窗），超窗跳过；缺 created_at 保留
      if (!filterByChange && windowStartMs !== null && c.created_at) {
        const createdMs = new Date(c.created_at).getTime();
        if (!isNaN(createdMs) && createdMs < windowStartMs) continue;
      }

      const severity = (c.severity || '').toUpperCase();
      const status = String(c.status || '').trim().toLowerCase();
      output.summary.concern_stats.total += 1;

      // Issue !259: 非规范 status 词一次性告警（读侧容错计 closed/未决，但词表本身要修）
      if (status && !CANONICAL_STATUS_VALUES.includes(status)) {
        if (isResolvedStatus(status)) {
          // 同义词（fixed/closed/done/已修复…）：计 closed，但提示用 resolve-concern 修正
          if (!warnedNonCanonicalStatus) {
            process.stderr.write(
              `[collect-ai] WARNING: concerns in ${concernDir}/concerns.json use non-canonical resolved status `
              + `(e.g. "${status}"). Counted as closed this time, but fix it via `
              + `\`node $HARNESS_ROOT/skills/rd-auto/scripts/orchestrator.js resolve-concern <change-name> --concern-id <id>\` `
              + `— do NOT edit concerns.json directly. `
              + `(see $HARNESS_ROOT/skills/rd-auto/references/shared-state.md)\n`
            );
            warnedNonCanonicalStatus = true;
          }
        } else if (!warnedUnknownStatus) {
          // 未知词（如 wontfix）：按未决（open）处理
          process.stderr.write(
            `[collect-ai] WARNING: concerns in ${concernDir}/concerns.json carry unknown status "${status}" `
            + `(valid: ${CANONICAL_STATUS_VALUES.join('/')}). Treated as open (not closed). `
            + `Fix the wording via resolve-concern / write-shared-state — do NOT edit concerns.json directly.\n`
          );
          warnedUnknownStatus = true;
        }
      }

      // Issue !259: resolved 同义词（RESOLVED_SYNONYMS）容错计 closed；未知词落到未决分支
      const resolved = isResolvedStatus(status);
      if (severity === 'P0') {
        output.summary.concern_stats.p0_found += 1;
        if (resolved) {
          output.summary.concern_stats.p0_closed += 1;
        }
      } else if (severity === 'P1') {
        output.summary.concern_stats.p1_found += 1;
        if (resolved) {
          output.summary.concern_stats.p1_closed += 1;
        }
      } else if (severity === 'P2') {
        output.summary.concern_stats.p2_found += 1;
        if (resolved) {
          output.summary.concern_stats.p2_closed += 1;
        }
      }
      // 落实到人：未关闭且带 author 的 P0/P1/P2 记入 details（带 severity），
      // 供日报质量概览按级分清单落实到人；description 超长截断防报表膨胀。
      if (!resolved && c.author) {
        output.summary.concern_stats.details.push({
          change: concernDir,
          author: String(c.author),
          severity,
          description: String(c.description || c.summary || '').slice(0, 120),
        });
      }
    }
  }
}

// --- Project slug to short name ---
// Slug: -work-repos-aios-rd-harness → short: rd-harness
// Rule: skip first 3 non-empty segments (path prefix like work/repos/aios or home/user/repos),
// join remaining segments as project name
function slugToShortName(slug) {
  const parts = slug.split('-').filter(Boolean);
  if (parts.length <= 3) return slug.replace(/^-/, '');
  const projectParts = parts.slice(3);
  return projectParts.join('-') || parts[parts.length - 1];
}

// --- Collect session tokens from all local Claude-Code-layout sessions ---
// 多 backend 融合采集：同机混用 claude + codebuddy/qoder 时，单目录采集会漏计
// 其他 backend 的主会话 token。这里遍历所有已安装 backend 的 projects 目录
// （Claude 兼容 JSONL 布局），各自聚合到项目桶；非 claude backend 的桶名加
// "<backend>:" 前缀区分（claude 主轨道保持原桶名，渲染向后兼容）。
// codex 主会话为 rollout 布局（无 message.usage），由 collectCodexSessionTokens
// 独立采集；~/.codex/projects 若存在也扫（解析不出 usage 自然无数据，无害）。
// 注：不再按 backend=codex 早退（!242 旧保护）——融合语义下 codex 用户当日混用
// Claude 的会话本就应计入，历史旧会话由 targetDate 日期过滤天然排除。
// Issue #277: zcode 主会话数据在 ~/.zcode/cli/rollout（model-io 布局），由下方
// collectZcodeSessionTokens 独立采集，不在本函数早退（融合语义同上）。
const SESSION_LAYOUT_BACKENDS = ['claude', 'codebuddy', 'qoder', 'codex', 'zcode'];

// 从 projects 目录路径反推所属 backend（与 backendDataDir 前缀比对），
// 匹配不上（自定义目录）返回 null → 桶名不加前缀
function inferSessionBackend(projectsDir) {
  for (const b of SESSION_LAYOUT_BACKENDS) {
    const root = backendDataDir(b);
    if (projectsDir === root || projectsDir.startsWith(root + path.sep)) return b;
  }
  return null;
}

function collectSessionTokens(targetDate, output) {
  // 候选目录：HARNESS_PROJECTS_DIR（显式注入，当前 backend）优先，
  // 其余为各 backend 数据目录下的 projects 子目录——存在才采、realpath 去重
  const expandHome = (p) => p.replace(/\$HOME/g, os.homedir());
  const candidates = [];
  const seenRoots = new Set();
  const pushCandidate = (dir, backend) => {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (_) { return; } // 目录不存在 → 跳过
    if (seenRoots.has(real)) return;
    seenRoots.add(real);
    candidates.push({ dir: real, backend });
  };

  if (process.env.HARNESS_PROJECTS_DIR) {
    const dir = expandHome(process.env.HARNESS_PROJECTS_DIR);
    pushCandidate(dir, inferSessionBackend(dir));
  }
  for (const b of SESSION_LAYOUT_BACKENDS) {
    pushCandidate(path.join(backendDataDir(b), 'projects'), b);
  }
  if (candidates.length === 0) return;

  // 跨 project 目录/backend 去重：session_id（文件名去 .jsonl）全局唯一，
  // 同一 session 文件出现在多个目录（复制/符号链接/跨 backend）只计一次。
  const seenSessionIds = new Set();

  // 同一 assistant 消息的 usage 去重键（message.id）。
  //
  // 为什么需要：Claude Code 在**流式响应过程中会把同一条消息多次落盘**——同一
  // message.id 出现 2~4 次，timestamp 相差仅数百毫秒、usage 字段完全相同
  // （实测：1139 条含 usage 条目 → 去重后 444 条，cache_read 虚高 2.61×）。
  // 逐条累加会把同一次 API 调用重复计入，使 Token 用量虚高数倍。
  //
  // 同时覆盖「子代理转录与主会话含同一条消息」的重复：message.id 跨文件唯一，
  // 被计入一次后其余副本自动跳过。
  const seenUsageMessageIds = new Set();

  for (const cand of candidates) {
    const projectsDir = cand.dir;
    const prefix = cand.backend && cand.backend !== 'claude' ? `${cand.backend}:` : '';

    let projectDirs;
    try {
      projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
    } catch (e) {
      continue;
    }

  for (const projectDir of projectDirs) {
    const projectPath = path.join(projectsDir, projectDir.name);
    const shortName = prefix + slugToShortName(projectDir.name);
    let files;
    try {
      // Issue !266: 新版 Claude Code 把 subagent 转录存于 <session-id>/subagents/agent-*.jsonl，
      // 顶层只扫主会话会漏计 subagent token（实测少计 ~58%）。
      // subagent 文件 token 计入所属项目/模型聚合，但不计入 session_count/project count
      // （主会话文件已代表该会话计一次），sessionKey 用相对路径避免与主会话文件名撞车。
      const entries = fs.readdirSync(projectPath, { withFileTypes: true });
      files = [];
      for (const ent of entries) {
        if (ent.isFile() && ent.name.endsWith('.jsonl')) {
          files.push({
            fullPath: path.join(projectPath, ent.name),
            sessionKey: ent.name.replace(/\.jsonl$/, ''),
            isSubagent: false,
          });
        } else if (ent.isDirectory()) {
          const subDir = path.join(projectPath, ent.name, 'subagents');
          let subFiles;
          try {
            subFiles = fs.readdirSync(subDir, { withFileTypes: true });
          } catch (_) { continue; }
          for (const sf of subFiles) {
            if (sf.isFile() && sf.name.endsWith('.jsonl')) {
              files.push({
                fullPath: path.join(subDir, sf.name),
                sessionKey: `${ent.name}/subagents/${sf.name}`,
                isSubagent: true,
              });
            }
          }
        }
      }
    } catch (e) {
      continue;
    }

    // Per-project accumulator
    let projectSessionCount = 0;
    let projectInput = 0;
    let projectOutput = 0;
    let projectCacheRead = 0;
    let projectCacheCreation = 0;

    for (const file of files) {
      const filePath = file.fullPath;
      // 跨 project 去重：同一 session 文件可能在多个 project 目录出现（符号链接/
      // 共享路径）。去重键带 backend 前缀——镜像去重针对同一 backend 内的跨 project
      // 目录；不同 backend 下同名文件是各自独立的会话（UUID 碰撞可忽略），不得互斥。
      const sessionId = `${cand.backend || 'custom'}:${file.sessionKey}`;
      if (seenSessionIds.has(sessionId)) continue;

      let content;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (e) {
        continue;
      }

      let sessionMatched = false;
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (e) {
          continue;
        }

        // Date filter: use entry.timestamp (UTC → CST)
        if (entry.timestamp && !isDateMatch(entry.timestamp, targetDate)) continue;
        // If no timestamp, skip (can't determine date)
        if (!entry.timestamp) continue;

        sessionMatched = true;

        const usage = entry.message && entry.message.usage;
        if (!usage) continue;

        // usage 去重：同一 message.id 只计一次（流式重写 / 跨文件副本）。
        // 无 message.id 的条目无法判重，按原样计入（不因缺字段丢量）。
        const usageMsgId = entry.message && entry.message.id;
        if (usageMsgId) {
          if (seenUsageMessageIds.has(usageMsgId)) continue;
          seenUsageMessageIds.add(usageMsgId);
        }

        const uInput = usage.input_tokens || 0;
        const uOutput = usage.output_tokens || 0;
        const uCacheRead = usage.cache_read_input_tokens || 0;
        const uCacheCreation = usage.cache_creation_input_tokens || 0;

        output.summary.session_input_tokens += uInput;
        output.summary.session_output_tokens += uOutput;
        output.summary.session_cache_creation_input_tokens += uCacheCreation;
        output.summary.session_cache_read_input_tokens += uCacheRead;

        projectInput += uInput;
        projectOutput += uOutput;
        projectCacheRead += uCacheRead;
        projectCacheCreation += uCacheCreation;

        // Model aggregation for session tokens
        const model = (entry.message && entry.message.model) || 'unknown';
        if (!output.summary.session_by_model[model]) {
          output.summary.session_by_model[model] = { count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
        }
        output.summary.session_by_model[model].count += 1;
        output.summary.session_by_model[model].input_tokens += uInput;
        output.summary.session_by_model[model].output_tokens += uOutput;
        output.summary.session_by_model[model].cache_read_tokens += uCacheRead;
        output.summary.session_by_model[model].cache_creation_tokens += uCacheCreation;
      }

      if (sessionMatched) {
        seenSessionIds.add(sessionId);
        // Issue !266: subagent 转录 token 已计入上方聚合，但不重复计会话数
        if (!file.isSubagent) {
          output.summary.session_count += 1;
          projectSessionCount += 1;
        }
      }
    }

    // Store per-project breakdown
    if (projectSessionCount > 0) {
      output.summary.session_by_project[shortName] = {
        slug: projectDir.name,
        count: projectSessionCount,
        input_tokens: projectInput,
        output_tokens: projectOutput,
        cache_read_tokens: projectCacheRead,
        cache_creation_tokens: projectCacheCreation,
      };
    }
  }
  } // end for cand（多 backend 目录）
}

// --- Collect codex session tokens from sessions/YYYY/MM/DD/rollout-*.jsonl ---
// Issue !242：codex backend 主会话 token/模型采集（原 collectSessionTokens 只解析 Claude projects 布局）。
// 事件结构（本机 orca codex 0.145.0-alpha.18 实测，非 OpenAI 官方 schema）：
//   token —— {"type":"event_msg","timestamp":"...Z","payload":{"type":"token_count","info":{
//             "total_token_usage":{...},"last_token_usage":{...}}}}
//             total_token_usage = 会话生命周期累计值；resume/fork 生成的新文件基线继承全部历史
//             last_token_usage = 单次请求增量（resume 继承的历史不出现在 last 中）
//   model —— {"type":"turn_context","payload":{"model":"..."}}
// 路径：$CODEX_HOME 优先（orca 会重定向 sessions 根），fallback ~/.codex；按本地日期 YYYY/MM/DD 组织。
// 聚合（Issue !268）：逐事件 total_token_usage 差值。官方 codex 的 token_count 有多个发射点
// （core/src/session/mod.rs send_token_count_event）：响应完成（last=真实增量）、auto-compact/
// rollback 后 recompute（last=上下文估算合成值）、限流重试 update_rate_limits（last 原样重发）、
// 超窗 set_total_tokens_full（last=填满窗口的合成值）——Σlast 会把合成/重发值当增量计入，
// 实测放大数倍；只有 total 单调递增、合成事件 Δ=0 自动剔除。跨天会话按事件 timestamp 只累加
// 当日 Δ。文件首个 total 事件无前置基线：新会话 last==total 无差；resume 新文件 total 已继承
// 历史，用 last（当日真实增量）校正；旧 schema 无 last 时退化为 total 全额（resume 继承无法剔除）。
// 首事件与后续事件的 total 均按组件字段和（input+output+cacheWrite）封顶——resume/fork 大历史
// 首轮触发 auto-compact 时首事件即 recompute 合成值（组件全 0、total=估算），封顶后计 0。
// 口径统一：codex input_tokens 已含 cached_input_tokens，这里拆为 (input - cached) 计入
// session_input_tokens，与 Claude 口径一致（input 不含 cache_read），渲染层三项相加即总量。
// 回放簇剔除（gaozm 2026-09-04 实证）：Codex Desktop 升级（0.145→0.151）后 subagent fork
// （thread_source=subagent，forked_from_id 指向旧版本父线程）把父线程全部历史一次性回放
// 写盘——数千条 token_count 挤在秒级窗口（真实往返为秒级/次，物理上不可能是真实请求），
// 且每条均盖迁移时刻时间戳，逐事件 Δtotal 会把继承历史全额计入当日（单文件实测 ~6 亿虚增）。
// 判据：文件内相邻 token_count 事件间隔 ≤2s 且连续 ≥30 条 → 回放簇，簇内不计当日增量
// （但推进 total 差值基线，保证簇后真实事件 Δ 正确）；簇内全是回放（无真实事件）的文件整跳过。
// --- Codex Desktop 升级回放簇检测 ---
// 判据（见 collectCodexSessionTokens 头注释）：文件行序上相邻 token_count 事件
// timestamp 间隔 ≤ REPLAY_BURST_GAP_MS 且连续条数 ≥ REPLAY_BURST_MIN_LEN 的簇 → 回放。
// 返回与 events 等长的布尔数组（true=回放事件）。真实请求最快也有服务端往返
// （秒级/次），2s 间隔对真实会话安全；≥30 条不可能来自真实交互。
// ts 缺失/无法解析视为间隔断裂（打断簇），防纯 null 时间戳文件被整簇误杀。
const REPLAY_BURST_GAP_MS = 2000;
const REPLAY_BURST_MIN_LEN = 30;
function detectReplayBursts(events) {
  const flags = new Array(events.length).fill(false);
  let start = 0;
  for (let i = 1; i <= events.length; i++) {
    const prev = events[i - 1];
    const cur = i < events.length ? events[i] : null;
    const gap = cur && prev && prev.ts && cur.ts
      ? Date.parse(cur.ts) - Date.parse(prev.ts)
      : NaN;
    // 同簇条件：间隔可解析且 ≤ GAP；否则在 i 处切断
    const inCluster = i < events.length && Number.isFinite(gap) && gap >= 0 && gap <= REPLAY_BURST_GAP_MS;
    if (inCluster) continue;
    if (i - start >= REPLAY_BURST_MIN_LEN) {
      for (let k = start; k < i; k++) flags[k] = true;
    }
    start = i;
  }
  return flags;
}

function collectCodexSessionTokens(targetDate, output) {
  const rawHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexHome = rawHome.replace(/\\/g, '/'); // Windows 反斜杠 → path.join 兼容
  const parts = targetDate.split('-');
  if (parts.length !== 3) return;
  const dayDir = path.join(codexHome, 'sessions', parts[0], parts[1], parts[2]);
  if (!fs.existsSync(dayDir)) return;

  let files;
  try {
    files = fs.readdirSync(dayDir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
  } catch (e) {
    return;
  }
  if (files.length === 0) return;

  const projectBucket = {
    slug: 'codex',
    count: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0,
    model: null, total_tokens: 0, reasoning_tokens: 0,
  };
  const modelBuckets = output.summary.session_by_model;
  let sessionCount = 0;

  const num = (v) => (typeof v === 'number' ? v : 0);

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(dayDir, file), 'utf-8');
    } catch (e) {
      continue;
    }

    let model = null;
    const events = []; // {ts, last, total} — 按文件行序
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (e) {
        continue;
      }
      // token_count 由 event_msg 包装（type 在内层 payload）；turn_context 直接在外层
      const et = (entry.payload && typeof entry.payload === 'object' && entry.payload.type) || entry.type;
      if (et === 'turn_context') {
        const mm = entry.payload && entry.payload.model;
        if (typeof mm === 'string' && mm) model = mm;
      } else if (et === 'token_count') {
        const info = entry.payload && entry.payload.info;
        if (!info) continue;
        events.push({
          ts: entry.timestamp || null,
          last: info.last_token_usage || null,
          total: info.total_token_usage || null,
        });
      }
    }

    // 当日事件（UTC timestamp → CST 匹配）；跨天会话只计当日增量
    // 回放簇剔除：簇内事件不计当日（下方 isDay 置假）——见函数头注释
    const replay = detectReplayBursts(events);
    const dayEvents = events.filter((ev, i) => !replay[i] && ev.ts && isDateMatch(ev.ts, targetDate));
    // 当日无（非回放）token_count 事件的会话（纯协作/中断/昨日已结束/整文件回放）跳过
    if (dayEvents.length === 0) continue;

    // 增量聚合：主口径 = 逐事件 total 差值（见上方聚合注释，Issue !268）。
    // 逐字段 Δ 均 max(0) 钳制；total Δ 额外按字段差值之和封顶——防御超窗 set_total_tokens_full
    // 事件（total 重置为 context window、其余字段清零）的虚增。
    // 回放簇事件跳过当日累加，但 total 基线照常推进（簇后真实事件 Δ 才不含继承历史）。
    const agg = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, total: 0 };
    let prevTotal = null; // 文件内上一条带 total 的事件（跨天也作为差值基线）
    for (let evIdx = 0; evIdx < events.length; evIdx++) {
      const ev = events[evIdx];
      const isDay = ev.ts && !replay[evIdx] && isDateMatch(ev.ts, targetDate);
      if (ev.total && prevTotal !== null) {
        // 非首条 total 事件：逐字段差值，当日事件累加
        const d = {
          input: Math.max(0, num(ev.total.input_tokens) - num(prevTotal.input_tokens)),
          output: Math.max(0, num(ev.total.output_tokens) - num(prevTotal.output_tokens)),
          cached: Math.max(0, num(ev.total.cached_input_tokens) - num(prevTotal.cached_input_tokens)),
          cacheWrite: Math.max(0, num(ev.total.cache_write_input_tokens) - num(prevTotal.cache_write_input_tokens)),
          reasoning: Math.max(0, num(ev.total.reasoning_output_tokens) - num(prevTotal.reasoning_output_tokens)),
          total: Math.max(0, num(ev.total.total_tokens) - num(prevTotal.total_tokens)),
        };
        if (isDay) {
          agg.input += d.input;
          agg.output += d.output;
          agg.cached += d.cached;
          agg.cacheWrite += d.cacheWrite;
          agg.reasoning += d.reasoning;
          // total 差值按组件字段和（input 已含 cached）封顶，防御超窗填满等
          // 字段清零/重置事件的虚增；正常事件组件和 == total 差值，min 无副作用
          agg.total += Math.min(d.total, d.input + d.output + d.cacheWrite);
        }
      } else if (isDay && prevTotal === null) {
        // 文件首条事件（prevTotal 为 null）：
        // 优先 last——新会话 last==total 无差；resume 新文件 total 含继承历史，
        // last 恰为当日真实增量。total 按组件和封顶：resume/fork 大历史首轮即触发
        // auto-compact 时首事件可能是 recompute 合成值（组件全 0、total=上下文估算），
        // 封顶后计 0；orca 内部分发样本（last=total、组件全 0）同理计 0
        const src = ev.last || ev.total;
        if (src) {
          agg.input += num(src.input_tokens);
          agg.output += num(src.output_tokens);
          agg.cached += num(src.cached_input_tokens);
          agg.cacheWrite += num(src.cache_write_input_tokens);
          agg.reasoning += num(src.reasoning_output_tokens);
          agg.total += Math.min(
            num(src.total_tokens),
            num(src.input_tokens) + num(src.output_tokens) + num(src.cache_write_input_tokens)
          );
        }
      }
      if (ev.total) {
        // total 下跳（真实 codex data 单调递增，下跳只可能来自非模型事件——如 orca
        // 内部分发样本夹在真实事件之间）：不推进基线，避免下一真实事件 Δ 虚增全量；
        // 该事件自身 Δ 分量被 max(0) 钳为 0，天然不计
        const down = prevTotal !== null
          && num(ev.total.total_tokens) < num(prevTotal.total_tokens);
        if (!down) prevTotal = ev.total;
      }
    }

    // 口径拆分：codex input_tokens 已含 cached_input_tokens，
    // 拆为净 input（不含 cache read）+ cache read，与 Claude 口径对齐
    const cachedInInput = Math.min(agg.cached, agg.input);
    const inputNet = agg.input - cachedInInput;

    sessionCount += 1;
    projectBucket.count += 1;
    projectBucket.input_tokens += inputNet;
    projectBucket.output_tokens += agg.output;
    projectBucket.cache_read_tokens += agg.cached;
    projectBucket.cache_creation_tokens += agg.cacheWrite;
    projectBucket.reasoning_tokens += agg.reasoning;
    projectBucket.total_tokens += agg.total;
    if (model) projectBucket.model = model;

    const mKey = model || 'unknown';
    if (!modelBuckets[mKey]) {
      modelBuckets[mKey] = {
        count: 0, input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        model: null, total_tokens: 0, reasoning_tokens: 0,
      };
    }
    const mb = modelBuckets[mKey];
    mb.count += 1;
    mb.input_tokens += inputNet;
    mb.output_tokens += agg.output;
    mb.cache_read_tokens += agg.cached;
    mb.cache_creation_tokens += agg.cacheWrite;
    mb.reasoning_tokens += agg.reasoning;
    mb.total_tokens += agg.total;
    if (model) mb.model = model;
  }

  if (sessionCount === 0) return;

  output.summary.session_count += sessionCount;
  output.summary.session_input_tokens += projectBucket.input_tokens;
  output.summary.session_output_tokens += projectBucket.output_tokens;
  output.summary.session_cache_read_input_tokens += projectBucket.cache_read_tokens;
  output.summary.session_cache_creation_input_tokens += projectBucket.cache_creation_tokens;
  output.summary.session_reasoning_tokens = (output.summary.session_reasoning_tokens || 0) + projectBucket.reasoning_tokens;
  output.summary.session_total_tokens = (output.summary.session_total_tokens || 0) + projectBucket.total_tokens;

  // project 槽位统一聚合到 'codex'（codex session 无 project 目录维度）
  const existing = output.summary.session_by_project.codex;
  if (existing) {
    existing.count += projectBucket.count;
    existing.input_tokens += projectBucket.input_tokens;
    existing.output_tokens += projectBucket.output_tokens;
    existing.cache_read_tokens += projectBucket.cache_read_tokens;
    existing.cache_creation_tokens += projectBucket.cache_creation_tokens;
    existing.total_tokens += projectBucket.total_tokens;
    existing.reasoning_tokens += projectBucket.reasoning_tokens;
    if (projectBucket.model) existing.model = projectBucket.model;
  } else {
    output.summary.session_by_project.codex = projectBucket;
  }
}

// --- ZCode model-io record parsing (Issue #277) ---
// 解析单行 zcode model-io 记录（~/.zcode/cli/rollout/model-io-sess_*.jsonl，每行一次
// 模型调用，camelCase schema）。字段映射：inputTokens→input_tokens、
// cacheReadTokens→cache_read_input_tokens、cacheWriteTokens→cache_creation_input_tokens。
// request 字段含完整请求体（数百 KB/行），解析后只取 usage/model/时间戳。
// ⚠ keep-in-sync：与 .claude/skills/rd-auto/scripts/lib/cli-commands.js 的
// parseZcodeModelIoRecord 保持同步（CJS/ESM 不共享 import，内联副本模式同 !259
// RESOLVED_SYNONYMS）；tests/zcode-modelio.test.mjs 做漂移对账。
function parseZcodeModelIoRecord(line) {
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
    // 归因隔离信号：querySource 与 model.role 任一标记 subagent 即算
    // （subagent 布局两种并存：独立文件 / 混在主会话文件，不能只认文件名）
    is_subagent: obj.querySource === 'subagent' || (obj.model && obj.model.role) === 'subagent',
  };
}

// --- Collect zcode session tokens from ~/.zcode/cli/rollout/model-io-sess_*.jsonl ---
// Issue #277：zcode backend 主会话 token/模型采集（原 collectSessionTokens 只解析
// Claude projects 布局，zcode 的 model-io 录制格式未被识别，日报 session_* 全 0）。
// 会话级总量按定义全量采集（主会话 + subagent 全部文件——口径与 dispatch 归因不同：
// dispatch 归因在 rd-auto cli-commands.js extractZcodeSubagentTokenUsage 做 subagent
// + 时间窗隔离，勿混）。
// 聚合：顶层 session_* 标量 + session_by_project['zcode'] + session_by_model
// （project 槽位统一 'zcode'——model-io 文件名不含项目维度，同 codex 模式）。
function collectZcodeSessionTokens(targetDate, output) {
  const rolloutDir = process.env.ZCODE_ROLLOUT_DIR
    ? process.env.ZCODE_ROLLOUT_DIR.replace(/\$HOME/g, os.homedir())
    : path.join(os.homedir(), '.zcode', 'cli', 'rollout');
  if (!fs.existsSync(rolloutDir)) return;

  let files;
  try {
    files = fs.readdirSync(rolloutDir).filter((f) => f.startsWith('model-io-sess_') && f.endsWith('.jsonl'));
  } catch (e) {
    return;
  }
  if (files.length === 0) return;

  const projectBucket = {
    slug: 'zcode',
    count: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0,
    model: null, total_tokens: 0, reasoning_tokens: 0,
  };
  const modelBuckets = output.summary.session_by_model;
  let sessionCount = 0;

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(rolloutDir, file), 'utf-8');
    } catch (e) {
      continue;
    }

    let sessionMatched = false;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const rec = parseZcodeModelIoRecord(line);
      if (!rec) continue;
      // 日期过滤按 startedAt（UTC → CST；isDateMatch 内部 new Date(number) 直接可用）
      if (!isDateMatch(rec.started_at_ms, targetDate)) continue;
      sessionMatched = true;

      projectBucket.input_tokens += rec.input_tokens;
      projectBucket.output_tokens += rec.output_tokens;
      projectBucket.cache_read_tokens += rec.cache_read_input_tokens;
      projectBucket.cache_creation_tokens += rec.cache_creation_input_tokens;
      projectBucket.total_tokens += rec.total_tokens;
      if (rec.model) projectBucket.model = rec.model;

      const mKey = rec.model || 'unknown';
      if (!modelBuckets[mKey]) {
        modelBuckets[mKey] = {
          count: 0, input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_creation_tokens: 0,
          model: null, total_tokens: 0, reasoning_tokens: 0,
        };
      }
      const mb = modelBuckets[mKey];
      mb.count += 1;
      mb.input_tokens += rec.input_tokens;
      mb.output_tokens += rec.output_tokens;
      mb.cache_read_tokens += rec.cache_read_input_tokens;
      mb.cache_creation_tokens += rec.cache_creation_input_tokens;
      mb.total_tokens += rec.total_tokens;
      if (rec.model) mb.model = rec.model;
    }
    // 一个 model-io 文件 = 一个会话（main/subagent 各自算一个）
    if (sessionMatched) {
      sessionCount += 1;
      projectBucket.count += 1;
    }
  }

  if (sessionCount === 0) return;

  output.summary.session_count += sessionCount;
  output.summary.session_input_tokens += projectBucket.input_tokens;
  output.summary.session_output_tokens += projectBucket.output_tokens;
  output.summary.session_cache_read_input_tokens += projectBucket.cache_read_tokens;
  output.summary.session_cache_creation_input_tokens += projectBucket.cache_creation_tokens;
  output.summary.session_total_tokens = (output.summary.session_total_tokens || 0) + projectBucket.total_tokens;

  const existing = output.summary.session_by_project.zcode;
  if (existing) {
    existing.count += projectBucket.count;
    existing.input_tokens += projectBucket.input_tokens;
    existing.output_tokens += projectBucket.output_tokens;
    existing.cache_read_tokens += projectBucket.cache_read_tokens;
    existing.cache_creation_tokens += projectBucket.cache_creation_tokens;
    if (projectBucket.total_tokens) existing.total_tokens = (existing.total_tokens || 0) + projectBucket.total_tokens;
    if (projectBucket.model) existing.model = projectBucket.model;
  } else {
    output.summary.session_by_project.zcode = projectBucket;
  }
}

// --- Resolve caller identity: git username > OS username ---
function resolveCaller() {
  try {
    const { execSync } = require('node:child_process');
    const gitUser = execSync('git config user.name', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (gitUser) return gitUser;
  } catch (_) { /* not in a git repo or git not available */ }
  try {
    return os.userInfo().username;
  } catch (_) {
    return 'unknown';
  }
}

// --- Read harness version from .harness/.harness-version ---
// 只取首行：与 session-start.sh / submit-harness-issue.sh / upgrade-harness SKILL.md
// 的 `head -1` 契约对齐（bump-version.sh 写入 3 行：version / force / signature）。
function readHarnessVersion(cwd) {
  const versionFile = path.join(cwd, '.harness', '.harness-version');
  try {
    const raw = fs.readFileSync(versionFile, 'utf-8');
    return raw.split('\n', 1)[0].trim() || null;
  } catch (_) {
    return null;
  }
}

// --- Normalize quality_metrics: 类型守卫，null / NaN / Infinity / 非数值 → 0 ---
// schema additionalProperties:false 锁死字段集；这里只做类型守卫，不枚举字段名，
// 避免 "schema 加字段 → normalize 漏字段" 的双向不同步。
function normalizeQualityMetrics(qm) {
  const src = qm || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
  }
  return out;
}

// --- Detect AI client (claude-code / codex / codebuddy / qoder / zcode / cursor / cline) from env ---
// Order matters: more specific signals first. Returns {name, version} or {name:null, version:null}.
function detectClient(env) {
  const e = env || process.env;

  if ((e.HARNESS_BACKEND || '').toLowerCase() === 'zcode' || e.ZCODE_PLUGIN_ROOT || e.ZCODE_PLUGIN_DATA) {
    return { name: 'zcode', version: null };
  }

  // CodeBuddy: session/project 信号（与 CodebuddyBackend.detect/getDataDir 同源）。
  // CodeBuddy 兼容 Claude Code（可能同时带 CLAUDE_* 变量），宿主信号更具体，须先判。
  if (e.CODEBUDDY_SESSION_ID || e.CODEBUDDY_PROJECT_DIR) {
    return { name: 'codebuddy', version: (e.CODEBUDDY_VERSION || '').trim() || null };
  }

  // Claude Code: CLAUDECODE=1 + CLAUDE_CODE_VERSION (e.g. "2.1.153 (Claude Code)")
  if (e.CLAUDECODE === '1' || e.CLAUDE_CODE_VERSION) {
    const raw = (e.CLAUDE_CODE_VERSION || '').trim();
    // Strip suffixes like " (Claude Code)" — take the first whitespace-separated token
    const version = raw.split(/\s+/)[0] || null;
    return { name: 'claude-code', version: version || null };
  }

  // OpenAI Codex CLI: CODEX env vars
  if (e.CODEX || e.CODEX_VERSION || e.CODEX_HOME) {
    const version = (e.CODEX_VERSION || '').trim() || null;
    return { name: 'codex', version };
  }

  // Qoder CN CLI: project/session signals exposed to hooks and wrapper processes.
  if (e.QODER_PROJECT_DIR || e.QODER_SESSION_ID || e.QODER_VERSION) {
    const version = (e.QODER_VERSION || '').trim() || null;
    return { name: 'qoder', version };
  }

  // Cursor: CURSOR_TRACE_ID or Cursor-defined env vars
  if (e.CURSOR_TRACE_ID || e.CURSOR_VSCODE) {
    return { name: 'cursor', version: (e.CURSOR_VERSION || '').trim() || null };
  }

  // Cline (VS Code extension) — no stable env signal; leave null for now
  return { name: null, version: null };
}

// --- Collect usage data from usage.jsonl ---
// Records written by PostToolUse hook (post-tool-use-agent-usage.sh)
// and by rd-auto mark-dispatch --end.
// HARNESS_USAGE_DIR 重定向到目标 backend（如 $HOME/.codebuddy/usage），
// Claude Code 未设则回退到 ~/.claude/usage 默认布局。
function collectUsageJsonl(targetDate, output) {
  const usageDir = process.env.HARNESS_USAGE_DIR
    ? process.env.HARNESS_USAGE_DIR.replace(/\$HOME/g, os.homedir())
    : detectBackendDir('usage');
  const usageFile = path.join(usageDir, 'usage.jsonl');
  if (!fs.existsSync(usageFile)) return;

  let content;
  try {
    content = fs.readFileSync(usageFile, 'utf-8');
  } catch (e) {
    return;
  }

  const usageDispatches = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      continue;
    }

    // Date filter: ts is UTC, convert to CST
    if (!isDateMatch(entry.ts, targetDate)) continue;

    // trigger 过滤：pipeline-trigger 条目跳过，避免与 pipeline-state.json 重复计数。
    // pipeline-state.json 是 pipeline dispatch 的唯一来源；
    // usage.jsonl 只统计 natural-trigger（人工 dispatch）。
    if (entry.trigger === 'pipeline') continue;

    // Issue !279: 主会话直出 → 单列 main 桶，不混 natural、不计 total_*/by_backend/虚拟任务
    if (entry.trigger === 'main') {
      const mainTrigger = output.summary.dispatch_by_trigger.main;
      const mTok = entry.tokens || {};
      const mIn = mTok.input || 0, mOut = mTok.output || 0;
      const mCr = mTok.cache_read || 0, mCc = mTok.cache_creation || 0;
      mainTrigger.dispatch_count += 1;
      mainTrigger.input_tokens += mIn;
      mainTrigger.output_tokens += mOut;
      mainTrigger.cache_read_tokens += mCr;
      mainTrigger.cache_creation_tokens += mCc;
      const mRole = entry.role || 'main-session';
      if (!mainTrigger.by_role[mRole]) {
        mainTrigger.by_role[mRole] = { dispatch_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
      }
      const mrb = mainTrigger.by_role[mRole];
      mrb.dispatch_count += 1; mrb.input_tokens += mIn; mrb.output_tokens += mOut;
      mrb.cache_read_tokens += mCr; mrb.cache_creation_tokens += mCc;
      const mModel = mTok.model || 'unknown';
      if (!mainTrigger.by_model[mModel]) {
        mainTrigger.by_model[mModel] = { dispatch_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
      }
      const mbm = mainTrigger.by_model[mModel];
      mbm.dispatch_count += 1; mbm.input_tokens += mIn; mbm.output_tokens += mOut;
      mbm.cache_read_tokens += mCr; mbm.cache_creation_tokens += mCc;
      continue;
    }

    const role = entry.role || 'unknown';
    // 采样缺口检测：短命 subagent 的 tokens 字段为 null，token 数据不可用
    if (entry.tokens === null) {
      output.summary.sampled_gap_count += 1;
    }
    const tokens = entry.tokens || {};
    const inputTokens = tokens.input || 0;
    const outputTokens = tokens.output || 0;
    const cacheReadTokens = tokens.cache_read || 0;
    const cacheCreationTokens = tokens.cache_creation || 0;
    const durationMs = entry.duration_ms || 0;

    // Aggregate into summary totals
    output.summary.total_input_tokens += inputTokens;
    output.summary.total_output_tokens += outputTokens;
    output.summary.total_dispatches += 1;
    output.summary.total_wall_clock_ms += durationMs;

    // Natural trigger aggregation
    const naturalTrigger = output.summary.dispatch_by_trigger.natural;
    naturalTrigger.dispatch_count += 1;
    naturalTrigger.input_tokens += inputTokens;
    naturalTrigger.output_tokens += outputTokens;
    naturalTrigger.cache_read_tokens += cacheReadTokens;
    naturalTrigger.cache_creation_tokens += cacheCreationTokens;

    // by_backend 聚合（新）：usage.jsonl 已写 backend 字段（record-usage）
    // usage.jsonl 的 tokens 字段格式：{input, output, cache_read, cache_creation, model}（claude）
    // 或 {total}（codex）；需映射到 normalized 视图
    const entryBackend = entry.backend || null;
    const entryNormalized = normalizeUsageJsonlTokens(tokens, entryBackend);
    aggregateByBackend(output.summary, entryBackend, entryNormalized);

    if (!naturalTrigger.by_role[role]) {
      naturalTrigger.by_role[role] = { dispatch_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    }
    naturalTrigger.by_role[role].dispatch_count += 1;
    naturalTrigger.by_role[role].input_tokens += inputTokens;
    naturalTrigger.by_role[role].output_tokens += outputTokens;
    naturalTrigger.by_role[role].cache_read_tokens += cacheReadTokens;
    naturalTrigger.by_role[role].cache_creation_tokens += cacheCreationTokens;

    // Model aggregation (natural trigger)
    const model = tokens.model || 'unknown';
    if (!naturalTrigger.by_model[model]) {
      naturalTrigger.by_model[model] = { dispatch_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
    }
    naturalTrigger.by_model[model].dispatch_count += 1;
    naturalTrigger.by_model[model].input_tokens += inputTokens;
    naturalTrigger.by_model[model].output_tokens += outputTokens;
    naturalTrigger.by_model[model].cache_read_tokens += cacheReadTokens;
    naturalTrigger.by_model[model].cache_creation_tokens += cacheCreationTokens;

    usageDispatches.push(entry);
  }

  // Create a virtual task entry for render-report.js active tasks list
  if (usageDispatches.length > 0) {
    const triggerBreakdown = {};
    for (const d of usageDispatches) {
      const t = d.trigger || 'unknown';
      triggerBreakdown[t] = (triggerBreakdown[t] || 0) + 1;
    }
    const triggerStr = Object.entries(triggerBreakdown).map(([k, v]) => `${k}:${v}`).join(', ');

    output.tasks.push({
      change_name: 'agent-dispatch',
      caller: resolveCaller(),
      title: `人工调度 (${triggerStr})`,
      current_phase: 'usage-tracking',
      phases_completed: 1,
      phases_total: 1,
      scores: {},
      quality_metrics: {},
      dispatches: usageDispatches.map((d) => ({
        phase: `usage-${d.trigger || 'natural'}`,
        started_at: d.started_at || d.ts,
        completed_at: d.completed_at || null,
        token_usage: d.tokens ? {
          input_tokens: d.tokens.input || 0,
          output_tokens: d.tokens.output || 0,
          cache_read_input_tokens: d.tokens.cache_read || 0,
          cache_creation_input_tokens: d.tokens.cache_creation || 0,
          model: d.tokens.model || null,
        } : null,
        exit_status: null,
      })),
      _usage_source: true,
    });
  }
}

// Issue !259: require.main 守卫——允许测试（tests/collect-ai-status.test.mjs）require
// 本文件拿到导出而不触发 main()。
if (require.main === module) {
  main();
}

// 纯判断逻辑导出（供 tests/collect-ai-status.test.mjs 对账，与 lib/concerns.js 同步）。
// parseZcodeModelIoRecord：供 tests/zcode-modelio.test.mjs 与 cli-commands.js 副本做
// 漂移对账（keep-in-sync，Issue #277/#282）。
module.exports = { RESOLVED_SYNONYMS, isResolvedStatus, parseZcodeModelIoRecord };
