// claude-backend.js — Claude Code 后端实现
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Claude Code 后端实现
 * 封装现有的 Claude Code 特定功能
 */
export class ClaudeBackend {
  constructor() {
    this.type = 'claude';
    this.name = 'Claude Code';
    this.version = this._getVersion();
  }

  /**
   * 获取 Claude Code 版本
   */
  _getVersion() {
    return process.env.CLAUDE_CODE_VERSION || 'unknown';
  }

  /**
   * 检测当前是否运行在 Claude Code 环境
   */
  detect() {
    return !!process.env.CLAUDE_CODE_SESSION_ID;
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId() {
    return process.env.CLAUDE_CODE_SESSION_ID || null;
  }

  /**
   * 获取 Claude Code 数据目录
   */
  getDataDir() {
    const projectSlug = process.env.CLAUDE_PROJECT_DIR?.replace(/[^a-zA-Z0-9]/g, '-');
    if (!projectSlug) {
      return join(homedir(), '.claude', 'projects', 'unknown');
    }
    return join(homedir(), '.claude', 'projects', projectSlug);
  }

  /**
   * 派发子代理
   *
   * 注意：在 Claude Code 中，实际的 Agent 调用由主会话执行。
   * 此方法主要用于准备 prompt，实际调用通过返回结果提示主会话。
   */
  async dispatchSubAgent(role, prompt, options) {
    // Claude Code 后端不直接执行，返回提示让主会话调用 Agent 工具
    return {
      exitStatus: 'PENDING',
      message: 'Please use Agent tool with the prepared prompt',
      role,
      prompt,
      options,
    };
  }

  /**
   * 注入规则
   *
   * Claude Code 通过 SessionStart hook 自动注入，
   * 此方法返回已注入状态。
   */
  async injectRules(rules) {
    // Claude Code 的规则注入在 session-start.sh 中完成
    // 这里只返回 true 表示规则已通过 hook 注入
    return true;
  }

  /**
   * 门禁检查
   *
   * Claude Code 通过 PreToolUse hooks 执行门禁，
   * 此方法返回需要检查的提示。
   */
  async enforceGates(command, tool) {
    // Claude Code 的门禁在 hooks 中执行
    // 这里返回默认允许，实际检查由 hook 完成
    return {
      allowed: true,
      note: 'Gate enforcement handled by PreToolUse hooks',
    };
  }

  /**
   * 记录使用情况
   */
  async recordUsage(record) {
    // Claude Code 的 usage 记录在 PostToolUse hook 中完成
    // 这里可以扩展为直接写入 usage.jsonl
    const usageFile = join(homedir(), '.claude', 'usage', 'usage.jsonl');
    // 实现由调用方决定
  }

  /**
   * 获取 transcript 路径
   */
  getTranscriptPath() {
    const sessionId = this.getSessionId();
    if (!sessionId) return null;

    const projectSlug = process.env.CLAUDE_PROJECT_DIR?.replace(/[^a-zA-Z0-9]/g, '-');
    if (!projectSlug) return null;

    const candidates = [
      join(homedir(), '.claude', 'projects', projectSlug, `${sessionId}.jsonl`),
      join(homedir(), '.claude', 'projects', projectSlug, 'tool-results', `${sessionId}.jsonl`),
    ];

    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return null;
  }

  /**
   * 从 transcript 提取 token 消耗
   */
  extractTokenUsage(transcriptPath, startLine) {
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

      for (let i = startLine; i < lines.length; i++) {
        try {
          const obj = JSON.parse(lines[i]);
          const u = obj.message?.usage;
          if (!u) continue;

          const model = obj.message?.model || 'unknown';
          inputTokens += u.input_tokens || 0;
          outputTokens += u.output_tokens || 0;
          cacheReadTokens += u.cache_read_input_tokens || 0;
          cacheCreationTokens += u.cache_creation_input_tokens || 0;

          models[model] = (models[model] || 0) +
            (u.input_tokens || 0) + (u.output_tokens || 0);
        } catch {
          // 忽略解析错误
        }
      }

      if (inputTokens === 0 && outputTokens === 0) return null;

      const dominantModel = Object.entries(models)
        .sort((a, b) => b[1] - a[1])[0];

      return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: cacheCreationTokens,
        model: dominantModel ? dominantModel[0] : 'unknown',
        provider: 'anthropic',
      };
    } catch {
      return null;
    }
  }
}

export default ClaudeBackend;
