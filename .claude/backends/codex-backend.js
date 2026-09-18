// codex-backend.js — Codex CLI 后端实现
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { RuleConverter } from './utils/rule-converter.js';
import { mapToCodexSandbox } from './utils/context-mapper.js';

// ─── Constants ───

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BACKENDS_DIR = __dirname;                 // .claude/backends/
const CLAUDE_DIR = join(BACKENDS_DIR, '..');    // .claude/
const REPO_ROOT = join(CLAUDE_DIR, '..');       // 仓库根
const RULES_PATH_DEFAULT = join(CLAUDE_DIR, 'reference', 'harness-rules.yaml');
const SHARED_STATE_ROOT = join(REPO_ROOT, '.harness', 'shared-state');

// 同步加载 YAML parser（ESM 不能直接 require，用 createRequire 包装）
const _require = createRequire(import.meta.url);
const _yamlParser = _require('../skills/rd-auto/scripts/lib/yaml-parser.js');

// ─── Helpers ───

/**
 * 把人类可读的时间字符串解析为毫秒
 * - "10m"  → 600000
 * - "1h"   → 3600000
 * - "30s"  → 30000
 * - "600"  → 600（裸数字按毫秒）
 */
export function parseHumanDuration(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (s === '') return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2] || 'ms';
  switch (unit) {
    case 'ms': return Math.round(num);
    case 's':  return Math.round(num * 1000);
    case 'm':  return Math.round(num * 60 * 1000);
    case 'h':  return Math.round(num * 60 * 60 * 1000);
    default:   return null;
  }
}

/**
 * 加载 rules 的 dispatch.timeout 段（避免循环依赖 transitions.js → state-store.js）
 */
function loadDispatchTimeouts(rulesPath) {
  try {
    const text = readFileSync(rulesPath, 'utf8');
    const yaml = _yamlParser.parseYaml(text);
    return yaml?.dispatch?.timeout ?? null;
  } catch {
    return null;
  }
}

/**
 * 解析 dispatch timeout 配置：phase overrides → default fallback
 */
export function resolveTimeoutMs(phase, rulesPath = RULES_PATH_DEFAULT) {
  const cfg = loadDispatchTimeouts(rulesPath);
  if (!cfg) return 10 * 60 * 1000; // 10 minutes fallback
  const overrides = cfg.overrides || {};
  if (phase && overrides[phase]) {
    const ms = parseHumanDuration(overrides[phase]);
    if (ms != null) return ms;
  }
  if (cfg.default) {
    const ms = parseHumanDuration(cfg.default);
    if (ms != null) return ms;
  }
  return 10 * 60 * 1000;
}

/**
 * Codex CLI 后端实现
 */
export class CodexBackend {
  constructor(options = {}) {
    this.type = 'codex';
    this.name = 'Codex CLI';
    this.version = this._getVersion();
    this._rulesCache = null;
    this._sessionId = null;
    this._ruleConverter = null;

    // 初始化规则转换器
    if (options.rulesPath) {
      this._ruleConverter = new RuleConverter(options.rulesPath);
    }
  }

  /**
   * 获取 Codex CLI 版本
   */
  _getVersion() {
    try {
      const output = execSync('codex --version', { encoding: 'utf8', stdio: 'pipe' });
      return output.trim() || 'unknown';
    } catch {
      return 'unknown (not installed)';
    }
  }

  /**
   * 检测当前是否运行在 Codex CLI 环境
   */
  detect() {
    try {
      execSync('codex --version', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取/生成会话 ID
   */
  getSessionId() {
    if (this._sessionId) return this._sessionId;

    // 尝试从环境变量获取
    if (process.env.CODEX_SESSION_ID) {
      this._sessionId = process.env.CODEX_SESSION_ID;
      return this._sessionId;
    }

    // 生成新的会话 ID
    this._sessionId = `codex-${Date.now()}-${randomUUID().slice(0, 8)}`;
    return this._sessionId;
  }

  /**
   * 获取 Codex 数据目录
   */
  getDataDir() {
    // 使用与 Claude Code 兼容的路径
    const projectSlug = process.env.CODEX_PROJECT_DIR?.replace(/[^a-zA-Z0-9]/g, '-') ||
                        process.env.CLAUDE_PROJECT_DIR?.replace(/[^a-zA-Z0-9]/g, '-') ||
                        'unknown';
    return join(homedir(), '.claude', 'projects', projectSlug);
  }

  /**
   * 派发子代理（通过 Codex CLI）
   *
   * options:
   *   - skipBuildPrompt (bool, default false): true 时直接把传入 prompt 作为 codex exec 输入
   *   - phase (string): 用于查 rules.dispatch.timeout.overrides[phase]
   *   - timeoutMs (number): 显式覆盖（用于测试）
   *   - changeName (string): 用于 codex-logs 落盘
   *   - round (number): 用于 codex-logs 文件名
   *   - contextMode (string): sandbox 级别（read_only/full）
   *   - acceptanceCriteria (string[])
   *   - previousSummary (string)
   *   - cwd (string): codex exec 工作目录（Phase 3c: fanout worktree 隔离，默认 CLAUDE_PROJECT_DIR）
   */
  async dispatchSubAgent(role, prompt, options = {}) {
    const opts = options || {};
    const phase = opts.phase || null;
    const changeName = opts.changeName || null;
    const round = opts.round != null ? opts.round : 1;

    // 计算 timeout
    const timeoutMs = opts.timeoutMs != null
      ? Number(opts.timeoutMs)
      : resolveTimeoutMs(phase, opts.rulesPath || RULES_PATH_DEFAULT);

    // 决定 prompt 输入
    let combinedPrompt;
    let promptWarnings = null;  // C010: local variable (not instance) to avoid Promise.all race
    if (opts.skipBuildPrompt) {
      // pipeline 模式：finalPrompt 已组装好，直接用
      combinedPrompt = prompt;
      // C003: defensive validation — skipBuildPrompt requires prompt to already contain
      // role definition and rules. If missing, surface warning to result JSON (not just stderr).
      const validation = this._validateSkipBuildPrompt(combinedPrompt);
      if (!validation.valid) {
        process.stderr.write(
          `[codex-backend] WARNING: skipBuildPrompt=true but prompt missing: ${validation.missing.join(', ')}. ` +
          `Check fanout-dispatch-agent.js template filling.\n`
        );
        promptWarnings = validation.missing;
      }
    } else {
      // 兼容旧路径：组装 agent + acceptance + ...
      const agentPath = join(process.env.CLAUDE_PROJECT_DIR || '.', process.env.HARNESS_ROOT || '.claude', 'agents', `${role}.md`);
      let agentContent = '';
      if (existsSync(agentPath)) {
        agentContent = readFileSync(agentPath, 'utf8');
      }
      combinedPrompt = this._buildPrompt(role, agentContent, prompt, opts);
    }

    // 错误归类 + 重试封装（Phase 3b: async spawn）
    const callCodex = async (timeout) => {
      const codexArgs = [
        'exec',
        '--json',                                   // Phase 3a: 切 JSONL 协议（turn.completed.usage 精确 token 提取）
        // Codex CLI 0.153+ removed --full-auto; approval behavior is now driven
        // by the sandbox level selected below.
        '--sandbox', this._mapContextMode(opts.contextMode),
        combinedPrompt,
      ];
      // Phase 3b: spawn 异步（替代 execFileSync），允许 fanout Promise.all 真并行
      // Issue !172: stdio:'pipe' 让子进程 stdin 成为管道、写入端在父进程常开，
      // codex exec 等 stdin EOF 永久阻塞。改 stdin 为 'ignore'（prompt 走 argv，不读 stdin）。
      return await new Promise((resolve, reject) => {
        const child = spawn('codex', codexArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: opts.cwd || process.env.CLAUDE_PROJECT_DIR || '.',
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          const err = new Error(`codex exec timeout after ${timeoutMs}ms`);
          err.code = 'ETIMEDOUT';
          err.stderr = stderr;
          err.stdout = stdout;
          reject(err);
        }, timeoutMs);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (signal === 'SIGTERM' && code === null) return; // 已被 timeout reject
          if (code !== 0) {
            const err = new Error(`codex exit ${code}`);
            err.status = code;
            err.code = code;
            err.stderr = stderr;
            err.stdout = stdout;
            reject(err);
          } else {
            resolve(stdout);
          }
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          // ENOENT（command not found）等 spawn 自身错误
          reject(e);
        });
      });
    };

    // 重试策略：timeout / network_error（含 econnreset）按 CODEX_MAX_RETRY（默认 3）
    // + 指数退避（CODEX_RETRY_BACKOFF_BASE 秒 × 2^n）重试，日志记录 phase/类型/错误/退避。
    const maxRetries = Math.max(0, parseInt(process.env.CODEX_MAX_RETRY || '3', 10) || 0);
    const backoffBaseMs = Math.max(0, parseInt(process.env.CODEX_RETRY_BACKOFF_BASE || '2', 10) || 0) * 1000;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const retryLog = [];

    let rawOutput = '';
    let caughtError = null;
    let classified = null;
    try {
      rawOutput = await callCodex(timeoutMs);
    } catch (err) {
      caughtError = err;
      classified = this._classifyError(err, phase, timeoutMs);

      const retryable = () => classified.type === 'timeout' || classified.type === 'network_error';
      for (let attempt = 1; retryable() && attempt <= maxRetries; attempt++) {
        const backoffMs = backoffBaseMs * Math.pow(2, attempt - 1);
        retryLog.push({
          attempt,
          phase,
          type: classified.type,
          error: this._sanitizeError(err, classified.type).message,
          backoffMs,
          at: new Date().toISOString(),
        });
        if (backoffMs > 0) await sleep(backoffMs);
        try {
          rawOutput = await callCodex(timeoutMs);
          caughtError = null;
          classified = null;
          break;
        } catch (errN) {
          err = errN;
          caughtError = errN;
          classified = this._classifyError(errN, phase, timeoutMs);
        }
      }

      if (caughtError) {
        // 仍失败 → 落盘（含重试日志）+ 返回 BLOCKED（携带 phase/重试记录供恢复）
        this._writeCodexLog(changeName, role, round, '', caughtError, null, retryLog);
        return {
          exitStatus: 'BLOCKED',
          error: this._sanitizeError(caughtError, classified.type),
          output: '',
          concerns: [{ level: 'P1', type: classified.type, phase }],
          retries: { count: retryLog.length, attempts: retryLog },
          phase,
          ...(promptWarnings ? { prompt_warnings: promptWarnings } : {}),
        };
      }
    }

    // 成功路径：解析 output
    const parsed = this._parseOutput(rawOutput, role);

    // C003: surface prompt validation warnings to result JSON (not stderr-dependent)
    if (promptWarnings) {
      parsed.prompt_warnings = promptWarnings;
    }

    // 重试后成功也留痕（消费方可见曾发生连接抖动及其退避耗时）
    if (retryLog.length > 0) {
      parsed.retries = { count: retryLog.length, attempts: retryLog };
    }

    // 落盘（成功也落）
    this._writeCodexLog(changeName, role, round, rawOutput, null, parsed);

    return parsed;
  }

  /**
   * 错误归类
   */
  _classifyError(err, phase, timeoutMs) {
    const msg = `${err.message || ''} ${err.stderr || ''} ${err.stdout || ''}`.toLowerCase();
    const code = err.status ?? err.code;

    // ENOENT
    if (code === 'ENOENT' || /not found|no such file|command not found/.test(msg)) {
      return { type: 'command_not_found', phase, timeoutMs };
    }
    // timeout（execFileSync 抛出 err.code === 'ETIMEDOUT' 或 message 含 'timed out'）
    if (err.code === 'ETIMEDOUT' || /timed?out/i.test(msg)) {
      return { type: 'timeout', phase, timeoutMs };
    }
    // 鉴权关键词
    if (/401|403|unauthorized|forbidden|invalid api key|api[_-]?key.*missing|auth/i.test(msg)) {
      return { type: 'auth_failure', phase, timeoutMs };
    }
    // 网络关键词
    if (/network|econnreset|econnrefused|etimedout|fetch|timeout.*retry|connection/.test(msg)) {
      return { type: 'network_error', phase, timeoutMs };
    }

    return { type: 'unknown_error', phase, timeoutMs };
  }

  /**
   * 错误对象脱敏（去掉完整 stderr，只保留归类 + 短摘要）
   */
  _sanitizeError(err, type) {
    const summary = (err.message || '').split('\n')[0].slice(0, 200);
    return { type, message: summary };
  }

  /**
   * 把原始 output + 错误对象写入 codex-logs
   * 文件名: <role>-<round>-<YYYYMMDDHHMMSS>.txt
   *
   * Phase 3a：原始 output 现在是 codex exec --json 的 JSONL 文本。
   * 同时追加 reconstructed agent_message（拼接自 JSONL 事件）+ parsed JSON（便于审计）。
   */
  _writeCodexLog(changeName, role, round, output, error = null, parsed = null, meta = null) {
    if (!changeName) return false;
    const dir = join(SHARED_STATE_ROOT, changeName, 'codex-logs');
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const ts = _formatTimestamp(new Date());
      const file = join(dir, `${role}-${round}-${ts}.txt`);
      const lines = [];
      lines.push(`# Codex dispatch log`);
      lines.push(`# change: ${changeName}`);
      lines.push(`# role: ${role}`);
      lines.push(`# round: ${round}`);
      lines.push(`# timestamp: ${ts}`);
      lines.push('');
      lines.push('## raw_output');
      lines.push(output || '');

      // reconstructed agent_message（仅当 raw_output 是 JSONL 时追加）
      if (output && output.trim().startsWith('{')) {
        try {
          const jsonlResult = this._parseJsonlOutput(output, role);
          if (jsonlResult && jsonlResult.has_turn_completed) {
            lines.push('');
            lines.push('## reconstructed_agent_message');
            lines.push(jsonlResult.reconstructed_text || '(empty)');
            if (jsonlResult.tokens_used != null) {
              lines.push('');
              lines.push('## usage');
              lines.push(JSON.stringify({
                tokens_used: jsonlResult.tokens_used,
                ...jsonlResult.usage,
              }, null, 2));
            }
          }
        } catch (e) {
          // reconstructed 失败不影响主流程
          // 静默吞错：log writer 不能反向影响 dispatch 主流程
        }
      }

      if (error) {
        lines.push('');
        lines.push('## error');
        lines.push(JSON.stringify({
          message: error.message,
          code: error.code,
          status: error.status,
          stderr: error.stderr?.slice(0, 2000),
        }, null, 2));
      }
      if (parsed) {
        lines.push('');
        lines.push('## parsed');
        lines.push(JSON.stringify(parsed, null, 2));
      }
      if (meta) {
        lines.push('');
        lines.push('## retry_meta');
        lines.push(JSON.stringify(meta, null, 2));
      }
      writeFileSync(file, lines.join('\n'), 'utf8');
      return file;
    } catch {
      return false;
    }
  }

  /**
   * 构建完整的 Codex prompt（fallback for non-pipeline callers）
   */
  _buildPrompt(role, agentContent, taskPrompt, options) {
    const parts = [];

    // 1. 角色定义
    if (agentContent) {
      parts.push('=== 角色定义 ===');
      parts.push(agentContent);
      parts.push('');
    }

    // 2. 任务描述
    parts.push('=== 任务 ===');
    parts.push(taskPrompt);
    parts.push('');

    // 3. 验收标准
    if (options.acceptanceCriteria && options.acceptanceCriteria.length > 0) {
      parts.push('=== 验收标准 ===');
      parts.push(options.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n'));
      parts.push('');
    }

    // 4. 上下文
    if (options.previousSummary) {
      parts.push('=== 前序工作摘要 ===');
      parts.push(options.previousSummary);
      parts.push('');
    }

    // 5. 规则（如果已缓存）
    if (this._rulesCache) {
      parts.push('=== 框架规则 ===');
      parts.push(this._rulesCache);
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * C003: Validate that a skipBuildPrompt prompt already contains role definition and rules.
   *
   * When skipBuildPrompt=true, the caller (e.g. fanout-dispatch-agent.js) is responsible
   * for assembling a complete prompt. This method checks that the prompt contains
   * the expected markers. Returns { valid, missing } — does NOT throw.
   *
   * Checks for both template format (<agent_definition> / <relevant_rules>) and
   * _buildPrompt format (=== 角色定义 === / === 框架规则 ===).
   *
   * @param {string} prompt
   * @returns {{ valid: boolean, missing: string[] }}
   */
  _validateSkipBuildPrompt(prompt) {
    if (!prompt || typeof prompt !== 'string') return { valid: false, missing: ['prompt_empty'] };
    const missing = [];
    const hasAgentDef = prompt.includes('<agent_definition>') || prompt.includes('=== 角色定义 ===');
    if (!hasAgentDef) missing.push('agent_definition');
    const hasRules = prompt.includes('<relevant_rules>') || prompt.includes('=== 框架规则 ===');
    if (!hasRules) missing.push('relevant_rules');
    return { valid: missing.length === 0, missing };
  }

  /**
   * 映射上下文模式到 Codex 沙箱级别
   */
  _mapContextMode(contextMode) {
    return mapToCodexSandbox(contextMode);
  }

  /**
   * 解析 Codex 输出 — 强制 JSON 尾块解析（P0 修复）
   *
   * Phase 3a 双路径策略（D4）：
   *   1. 优先用 _parseJsonlOutput 解析 JSONL 事件流（codex exec --json 输出）
   *   2. JSONL 路径成功（含 turn.completed 事件）→ 用拼接的 agent_message text 跑 _extractLastJsonBlock
   *   3. JSONL 路径失败 → 回退到旧 plain text 逻辑（_extractLastJsonBlock + _extractTokensUsed）
   *
   * 反启发式：禁止用 output.includes('Done'/'Failed'/'ERROR') 判断 exitStatus。
   */
  _parseOutput(output, role) {
    const rawOutput = output || '';

    // 优先 JSONL 路径
    const jsonlResult = this._parseJsonlOutput(rawOutput, role);
    if (jsonlResult && jsonlResult.has_turn_completed) {
      // JSONL 路径：从 reconstructed agent_message text 提取 sub-agent JSON
      const reconstructed = jsonlResult.reconstructed_text || '';
      const json = _extractLastJsonBlock(reconstructed);

      // 错误事件优先（rate_limit / auth / network）
      if (jsonlResult.exitStatus === 'BLOCKED') {
        const result = {
          exitStatus: 'BLOCKED',
          output: reconstructed || rawOutput,
          error: jsonlResult.error,
          concerns: jsonlResult.concerns || [{ level: 'P1', type: 'codex-error-event' }],
        };
        if (jsonlResult.tokens_used != null) result.tokens_used = jsonlResult.tokens_used;
        // !262: 透传 usageDetail（input/cached/output/reasoning）供 dispatch-agent → mark-dispatch 结构化落盘
        if (jsonlResult.usage) result.usage = jsonlResult.usage;
        return result;
      }

      if (!json) {
        const result = {
          exitStatus: 'DONE_WITH_CONCERNS',
          output: reconstructed || rawOutput,
          concerns: [{ level: 'P2', type: 'unparseable-codex-output' }],
        };
        if (jsonlResult.tokens_used != null) result.tokens_used = jsonlResult.tokens_used;
        // !262: 透传 usageDetail（input/cached/output/reasoning）供 dispatch-agent → mark-dispatch 结构化落盘
        if (jsonlResult.usage) result.usage = jsonlResult.usage;
        return result;
      }

      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch {
        const result = {
          exitStatus: 'DONE_WITH_CONCERNS',
          output: reconstructed || rawOutput,
          concerns: [{ level: 'P2', type: 'unparseable-codex-output' }],
        };
        if (jsonlResult.tokens_used != null) result.tokens_used = jsonlResult.tokens_used;
        // !262: 透传 usageDetail（input/cached/output/reasoning）供 dispatch-agent → mark-dispatch 结构化落盘
        if (jsonlResult.usage) result.usage = jsonlResult.usage;
        return result;
      }

      const exitStatus = parsed.exit_status || parsed.exitStatus || 'DONE_WITH_CONCERNS';
      const result = {
        exitStatus,
        output: reconstructed || rawOutput,
      };
      if (parsed.summary != null) result.summary = parsed.summary;
      if (parsed.artifacts != null) result.artifacts = parsed.artifacts;
      if (parsed.score != null) result.score = parsed.score;
      if (parsed.p0_count != null) result.p0_count = parsed.p0_count;
      if (Array.isArray(parsed.concerns)) result.concerns = parsed.concerns;
      if (jsonlResult.tokens_used != null) result.tokens_used = jsonlResult.tokens_used;
      if (jsonlResult.usage) result.usage = jsonlResult.usage;
      return result;
    }

    // Plain text fallback（旧路径，保留）
    const json = _extractLastJsonBlock(rawOutput);

    if (!json) {
      return {
        exitStatus: 'DONE_WITH_CONCERNS',
        output: rawOutput,
        concerns: [{ level: 'P2', type: 'unparseable-codex-output' }],
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      return {
        exitStatus: 'DONE_WITH_CONCERNS',
        output: rawOutput,
        concerns: [{ level: 'P2', type: 'unparseable-codex-output' }],
      };
    }

    // 兼容两种字段命名：snake_case (claude 风格) 与 camelCase (旧 codex 风格)
    const exitStatus = parsed.exit_status || parsed.exitStatus || 'DONE_WITH_CONCERNS';
    const summary = parsed.summary || undefined;
    const artifacts = parsed.artifacts || undefined;
    const score = parsed.score != null ? parsed.score : undefined;
    const p0Count = parsed.p0_count != null ? parsed.p0_count : (parsed.p0Count != null ? parsed.p0Count : undefined);
    const concerns = Array.isArray(parsed.concerns) ? parsed.concerns : undefined;

    const result = {
      exitStatus,
      output: rawOutput,
    };
    if (summary != null) result.summary = summary;
    if (artifacts != null) result.artifacts = artifacts;
    if (score != null) result.score = score;
    if (p0Count != null) result.p0_count = p0Count;
    if (concerns != null) result.concerns = concerns;
    const tokensUsed = _extractTokensUsed(rawOutput);
    if (tokensUsed != null) result.tokens_used = tokensUsed;
    return result;
  }

  /**
   * 解析 codex exec --json 的 JSONL 事件流（Phase 3a）
   *
   * 逐行 JSON.parse，跳过非 JSON 行。提取：
   *   - 最后一个 turn.completed 事件的 usage（input/output/cached/reasoning tokens）
   *   - 拼接所有 item.completed.type=agent_message 的 text（按出现顺序）
   *   - 检测 item.completed.type=error 事件（rate_limit / auth / network）
   *
   * @param {string} rawJsonl codex exec --json 原始 stdout（JSONL）
   * @param {string} role 当前 dispatch 的角色（debugging 用）
   * @returns {object|null} 解析结果，含 has_turn_completed / reconstructed_text / tokens_used / usage / exitStatus? / error? / concerns?
   *   返回 null 或 has_turn_completed=false 时，调用方应回退 plain text 解析。
   *
   *   注意：本函数**只负责 JSONL 事件流解析**（usage / error / reconstructed_text），
   *   不提取 sub-agent JSON。sub-agent JSON 提取由调用方 _parseOutput 通过
   *   _extractLastJsonBlock(reconstructed_text) 统一负责，避免职责重叠（C002 修复）。
   */
  _parseJsonlOutput(rawJsonl, role) {
    const text = rawJsonl || '';
    if (!text.trim()) return null;

    const lines = text.split('\n');
    let lastTurnCompleted = null;        // 最后一个 turn.completed 事件
    let hasTurnCompleted = false;
    const agentMessages = [];             // 按出现顺序收集 agent_message text
    const errorEvents = [];               // 收集所有 error 事件

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        // 非 JSON 行（codex 偶尔输出 separator/comment）→ 跳过
        continue;
      }
      if (!evt || typeof evt !== 'object') continue;

      // turn.completed 事件
      if (evt.type === 'turn.completed') {
        hasTurnCompleted = true;
        lastTurnCompleted = evt;
        continue;
      }

      // item.completed 事件（含 agent_message / reasoning / error 等子类型）
      if (evt.type === 'item.completed' && evt.item && typeof evt.item === 'object') {
        const itemType = evt.item.type;
        if (itemType === 'agent_message' && typeof evt.item.text === 'string') {
          agentMessages.push(evt.item.text);
        } else if (itemType === 'error' && evt.item.message) {
          errorEvents.push({
            message: evt.item.message,
            code: evt.item.code,
            kind: _classifyCodexErrorEvent(evt.item.message),
          });
        }
        // 其他子类型（reasoning / tool_call / web_search 等）暂不提取
      }
    }

    // 拼接 agent_message text
    const reconstructedText = agentMessages.join('\n');

    // 提取 usage（input + output 求和作为 tokens_used）
    let tokensUsed = null;
    let usageDetail = null;
    if (lastTurnCompleted && lastTurnCompleted.usage) {
      const u = lastTurnCompleted.usage;
      const inputTokens = u.input_tokens || 0;
      const outputTokens = u.output_tokens || 0;
      tokensUsed = inputTokens + outputTokens;
      usageDetail = {
        input_tokens: inputTokens,
        cached_input_tokens: u.cached_input_tokens || 0,
        output_tokens: outputTokens,
        reasoning_output_tokens: u.reasoning_output_tokens || 0,
      };
    }

    // 错误事件归类
    let exitStatus = null;
    let error = null;
    let concerns = null;
    if (errorEvents.length > 0) {
      const first = errorEvents[0];
      exitStatus = 'BLOCKED';
      error = {
        type: first.kind || 'codex_error_event',
        message: first.message,
      };
      concerns = errorEvents.map(e => ({
        level: 'P1',
        type: e.kind || 'codex_error_event',
        message: e.message,
      }));
    }

    // 注：sub-agent JSON 提取由调用方 _parseOutput 通过 _extractLastJsonBlock(reconstructed_text) 负责，
    // 本函数不重复提取（C002 修复：职责分离 — JSONL 解析器 vs sub-agent JSON 提取器）

    return {
      has_turn_completed: hasTurnCompleted,
      reconstructed_text: reconstructedText,
      tokens_used: tokensUsed,
      usage: usageDetail,
      ...(exitStatus ? { exitStatus } : {}),
      ...(error ? { error } : {}),
      ...(concerns ? { concerns } : {}),
    };
  }

  /**
   * 注入规则到 Codex 上下文
   */
  async injectRules(rules) {
    if (this._ruleConverter) {
      // 使用规则转换器
      this._rulesCache = this._ruleConverter.toCodexPrompt();
    } else {
      // 直接缓存
      this._rulesCache = rules;
    }
    return true;
  }

  /**
   * 门禁检查
   */
  async enforceGates(command, tool) {
    // Codex 有自己的沙箱，这里检查额外的 Uni-AURI 约束

    // 检查危险命令（映射 git-guard 和 tasks-guard 逻辑）
    const dangerousPatterns = [
      /\bgit\s+clean\b/,           // git clean
      /\bgit\s+reset\s+--hard\b/,  // git reset --hard
      /\brm\s+-rf.*\.harness\b/,    // rm -rf .harness
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return {
          allowed: false,
          reason: 'Command blocked by Uni-AURI gate',
          suggestion: 'This command is protected. Use orchestrator commands instead.',
        };
      }
    }

    return { allowed: true };
  }

  /**
   * 记录使用情况
   */
  async recordUsage(record) {
    const usageDir = join(homedir(), '.claude', 'usage');
    if (!existsSync(usageDir)) {
      mkdirSync(usageDir, { recursive: true });
    }

    const usageFile = join(usageDir, 'usage.jsonl');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      session_id: this.getSessionId(),
      backend: 'codex',
      ...record,
    }) + '\n';

    // 追加到文件（issue !181：原代码只构造 line 未 appendFileSync，token 永不落盘）
    try {
      appendFileSync(usageFile, line, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 获取 transcript 路径
   *
   * Codex CLI 没有 transcript 概念，这里返回 null
   * Token 统计需要通过其他方式获取
   */
  getTranscriptPath() {
    return null;
  }

  /**
   * 从 Codex 输出提取 token 消耗
   *
   * Codex CLI 可能不输出 token 信息，这里返回 null
   * 实际实现需要根据 Codex 的具体输出格式调整
   */
  extractTokenUsage(transcriptPath, startLine) {
    // Codex CLI 暂不支持直接获取 token 消耗
    // 可以通过 API 调用记录来获取
    return null;
  }
}

// ─── Module-level helpers ───

/**
 * 从 codex exec 输出末尾解析 'tokens used' 行
 *
 * codex CLI 在 stdout 末尾会打印两行：
 *   tokens used
 *   9,379
 *
 * 兼容三种格式：
 *   - 上述两行模式（codex 0.142.5 实际格式）
 *   - 单行 "tokens used: 9379" / "tokens used 9379"
 *   - "tokens: 9379"
 * 数字可含千分位逗号，会被剥离
 *
 * 返回整数 token 数；解析失败返回 null
 */
export function _extractTokensUsed(text) {
  if (!text || typeof text !== 'string') return null;
  // 三种正则，按优先级（先匹配置信度高的）
  const patterns = [
    /tokens\s+used\s*:?\s*\n\s*([\d,]+)/i,           // 两行模式
    /tokens\s+used\s*:?\s+([\d,]+)/i,                  // 单行 "tokens used: N"
    /\btokens\s*:?\s+([\d,]+)/i,                       // 兜底 "tokens: N"
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (!Number.isNaN(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * 从 markdown 输出中提取最后一个 JSON 代码块
 * 优先级：```json fenced > ``` fenced > 裸 {...}
 * 返回 null 表示未找到
 */
export function _extractLastJsonBlock(text) {
  if (!text) return null;
  // 1. ```json\n...\n``` 或 ```\n...\n```
  const fencedRe = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let lastFenced = null;
  let m;
  while ((m = fencedRe.exec(text)) !== null) {
    lastFenced = m[1].trim();
  }
  if (lastFenced) {
    // 校验是合法 JSON
    try {
      JSON.parse(lastFenced);
      return lastFenced;
    } catch {
      // fall through to bare {...}
    }
  }
  // 2. 裸 {...}（取最后一个能 parse 通的）
  // 使用平衡括号扫描，避免中间嵌套出错
  const candidates = _findBalancedJsonObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      JSON.parse(candidates[i]);
      return candidates[i];
    } catch {
      // continue
    }
  }
  return null;
}

function _findBalancedJsonObjects(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0;
      let inString = false;
      let escape = false;
      let j = i;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (inString) {
          if (escape) escape = false;
          else if (ch === '\\') escape = true;
          else if (ch === '"') inString = false;
        } else if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            results.push(text.slice(i, j + 1));
            break;
          }
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return results;
}

function _formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/**
 * 把 codex JSONL item.completed.type=error 事件的 message 归类
 *
 * 用于 _parseJsonlOutput 把 error 转成 concerns.type（rate_limit / auth_failure /
 * network_error / unknown_error）。与 _classifyError 的关键词集合保持一致。
 */
function _classifyCodexErrorEvent(message) {
  const msg = String(message || '').toLowerCase();
  if (/rate.?limit|429|too many requests|quota/.test(msg)) return 'rate_limit';
  if (/401|403|unauthorized|forbidden|invalid api key|api[_-]?key.*missing|auth/.test(msg)) return 'auth_failure';
  if (/network|econnreset|econnrefused|etimedout|fetch|connection/.test(msg)) return 'network_error';
  return 'unknown_error';
}

export default CodexBackend;
