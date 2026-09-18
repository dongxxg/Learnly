// qoder-backend.js — Qoder CN CLI backend implementation
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveTimeoutMs } from './codex-backend.js';

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const QODER_ROLE_NAMES = {
  architect: 'Architect',
  developer: 'Developer',
  tester: 'Tester',
  reviewer: 'Reviewer',
  debate: 'Debate',
};

function qoderRoleName(role) {
  const value = String(role || '');
  return QODER_ROLE_NAMES[value.toLowerCase()] || value;
}

function qoderPermissionMode(options) {
  if (options.permissionMode === 'plan' || options.permissionMode === 'auto') {
    return options.permissionMode;
  }
  return options.contextMode === 'minimal' || options.contextMode === 'read_only'
    ? 'plan'
    : 'auto';
}

/** Build the documented Qoder CN headless invocation. */
export function buildQoderArgs(role, prompt, options = {}) {
  const cwd = options.cwd || process.env.QODER_PROJECT_DIR || process.cwd();
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  return [
    '--agent', qoderRoleName(role),
    '--print',
    '--output-format', 'json',
    '--permission-mode', qoderPermissionMode(options),
    '--max-turns', String(maxTurns),
    '-w', cwd,
    prompt,
  ];
}

function parseJson(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : null;
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
}

function fencedJson(value) {
  if (typeof value !== 'string') return null;
  const matches = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const parsed = parseJson(matches[i][1]);
    if (parsed) return parsed;
  }
  return null;
}

function unwrapResult(value) {
  let current = value;
  for (let i = 0; i < 3; i++) {
    if (!current || typeof current !== 'object' || current.result == null) break;
    const next = parseJson(current.result) || fencedJson(current.result);
    if (!next) break;
    current = next;
  }
  return current;
}

function tokenCount(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const explicitTotal = usage.total_tokens ?? usage.total;
  if (explicitTotal != null && Number.isFinite(Number(explicitTotal))) return Number(explicitTotal);
  // Qoder 尚未公布稳定的 token 拆分 schema。只接受 CLI 明确给出的 total，
  // 不猜测 input/output/cache 字段的计费或去重关系。
  return null;
}

function classifyQoderError(error, stderr = '') {
  if (error?.code === 'ENOENT') return 'command_not_found';
  if (error?.code === 'ETIMEDOUT') return 'timeout';
  const message = `${error?.message || ''}\n${stderr}`.toLowerCase();
  if (/auth|login|log in|unauthorized|credential|token expired/.test(message)) return 'auth_failure';
  if (/rate.?limit|too many requests|quota|429/.test(message)) return 'rate_limit';
  if (/network|econn|enotfound|dns|socket|timed?\s*out|connection/.test(message)) return 'network_error';
  return 'cli_error';
}

function aggregateUsage(events) {
  const usages = events.map((event) => event?.usage).filter(Boolean);
  if (!usages.length) return null;
  if (usages.length === 1) return usages[0];
  const total = {};
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === 'number') total[key] = (total[key] || 0) + value;
    }
  }
  return total;
}

function resultFromEvents(events, rawOutput) {
  const resultEvent = [...events].reverse().find((event) => event?.type === 'result') || events.at(-1) || {};
  const payload = unwrapResult(resultEvent);
  const nested = payload === resultEvent ? null : payload;
  const body = nested || resultEvent;
  const usage = resultEvent.usage || body?.usage || aggregateUsage(events);
  const exitStatus = nested?.exit_status || nested?.exitStatus ||
    resultEvent.exit_status || resultEvent.exitStatus || 'DONE_WITH_CONCERNS';
  const summary = nested?.summary || resultEvent.summary ||
    (typeof resultEvent.result === 'string' ? resultEvent.result : rawOutput.trim());
  const parsed = {
    ...body,
    exitStatus,
    summary,
    output: rawOutput,
  };
  const sessionId = resultEvent.session_id || nested?.session_id;
  if (sessionId) parsed.session_id = sessionId;
  if (body?.artifacts) parsed.artifacts = body.artifacts;
  const tokensUsed = resultEvent.tokens_used ?? nested?.tokens_used ?? tokenCount(usage);
  if (tokensUsed != null) parsed.tokens_used = Number(tokensUsed);
  if (usage) parsed.usage = usage;
  if (typeof resultEvent.result === 'string' && !nested) {
    parsed.exitStatus = 'BLOCKED';
    parsed.error = {
      type: 'unparseable',
      message: 'Qoder result did not contain the required structured worker JSON',
    };
    parsed.concerns = [{ level: 'P1', type: 'unparseable' }];
  }
  return parsed;
}

/** Parse Qoder JSON, stream JSON/JSONL, or plain output containing fenced JSON. */
export function parseQoderOutput(output) {
  const rawOutput = String(output ?? '');
  const whole = parseJson(rawOutput);
  if (whole) {
    const events = Array.isArray(whole) ? whole : [whole];
    return resultFromEvents(events, rawOutput);
  }

  const events = rawOutput
    .split(/\r?\n/)
    .map((line) => parseJson(line))
    .filter(Boolean);
  if (events.length) return resultFromEvents(events, rawOutput);

  const fenced = fencedJson(rawOutput);
  if (fenced) return resultFromEvents([fenced], rawOutput);

  return {
    exitStatus: 'BLOCKED',
    error: { type: 'unparseable', message: 'Qoder output was not valid JSON or fenced worker JSON' },
    summary: rawOutput.trim(),
    output: rawOutput,
    concerns: [{ level: 'P1', type: 'unparseable' }],
  };
}

export class QoderBackend {
  constructor(options = {}) {
    this.type = 'qoder';
    this.name = 'Qoder CN CLI';
    this.command = options.command || 'qoderclicn';
    this.commandArgs = Array.isArray(options.commandArgs) ? options.commandArgs : [];
    this.version = this._getVersion();
  }

  _getVersion() {
    try {
      return execFileSync(this.command, [...this.commandArgs, '--version'], { encoding: 'utf8', stdio: 'pipe' }).trim() || 'unknown';
    } catch {
      return 'unknown (not installed)';
    }
  }

  detect() {
    try {
      execFileSync(this.command, [...this.commandArgs, '--version'], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  getSessionId() {
    return process.env.QODER_SESSION_ID || null;
  }

  getDataDir() {
    return join(homedir(), '.qoder-cn', 'projects');
  }

  async dispatchSubAgent(role, prompt, options = {}) {
    const args = buildQoderArgs(role, prompt, options);
    const timeoutMs = Number(
      options.timeoutMs ?? resolveTimeoutMs(options.phase, options.rulesPath),
    ) || DEFAULT_TIMEOUT_MS;
    const runOnce = () => new Promise((resolve) => {
      const child = spawn(this.command, [...this.commandArgs, ...args], {
        cwd: options.cwd || process.env.QODER_PROJECT_DIR || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let forceKillTimer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // 等待 close 后才允许重试，避免旧写进程与新进程重叠；宽限后强制终止。
        forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => {
        if (timedOut) error.code = 'ETIMEDOUT';
        const type = classifyQoderError(error, stderr);
        finish({
          exitStatus: 'BLOCKED',
          error: { type, message: error.message },
          output: stdout,
          concerns: [{ level: 'P1', type }],
        });
      });
      child.on('close', (code) => {
        if (timedOut) {
          const message = `qoderclicn timeout after ${timeoutMs}ms`;
          return finish({
            exitStatus: 'BLOCKED',
            error: { type: 'timeout', message },
            output: stdout,
            concerns: [{ level: 'P1', type: 'timeout' }],
          });
        }
        if (code === 0) return finish(parseQoderOutput(stdout));
        const message = (stderr || `qoderclicn exit ${code}`).trim().slice(0, 500);
        const type = classifyQoderError(new Error(message), stderr);
        finish({
          exitStatus: 'BLOCKED',
          error: { type, message },
          output: stdout,
          concerns: [{ level: 'P1', type }],
        });
      });
    });
    let result = await runOnce();
    const retryable = result?.error?.type === 'network_error' || result?.error?.type === 'timeout';
    if (retryable && options.retry !== false) result = await runOnce();
    return result;
  }

  async injectRules() {
    return true;
  }

  async enforceGates() {
    return { allowed: true, note: 'Gate enforcement handled by Qoder hooks' };
  }

  async recordUsage() {
    // Headless usage is returned directly by dispatchSubAgent/parseQoderOutput.
  }

  getTranscriptPath() {
    // Qoder does not document a stable on-disk transcript path.
    return null;
  }

  extractTokenUsage(transcriptPath, startLine = 0) {
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    try {
      const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/).slice(startLine);
      const events = lines.map(parseJson).filter(Boolean);
      const usage = aggregateUsage(events);
      if (!usage) return null;
      return { ...usage, provider: 'qoder' };
    } catch {
      return null;
    }
  }
}

export default QoderBackend;
