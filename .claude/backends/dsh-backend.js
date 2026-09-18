// dsh-backend.js — DeepSeek Harness (DSH) 桌面 Agent 后端实现。
//
// DSH（DeepSeek Harness，本机 ~/.dsh 与 DSH_* 环境变量标识）是桌面应用：
//   - 项目级规则通过根目录 AGENTS.md / CLAUDE.md 自动注入（无 SessionStart hook 机制）
//   - 子代理 dispatch 由主会话调用内置 subagent 工具完成（后端本身不直接执行）
//   - 会话转录以 zstd 压缩的 jsonl 写在 DSH_SESSION_JSONL（事件流，usage 见
//     assistant/message 与 assistant/chunk 事件）
// 因此本类的契约与 ZcodeBackend/ClaudeBackend 同源：dispatch 留在主会话，
// 差异在标识、环境变量名、数据目录与转录解析。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 是否为 DSH 转录路径（.jsonl.zstd / .jsonl.zst / .zstd / .zst）。 */
function isCompressedTranscript(path) {
  return /\.zstd$|\.zst$/i.test(path);
}

/** 归一化单个 usage 对象到 token 计数（容忍 DeepSeek 与 OpenAI 两种字段命名）。 */
function normalizeUsage(usage) {
  return {
    inputTokens: Number(usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
    outputTokens: Number(usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
    cacheReadTokens: Number(usage.cacheReadTokens ?? usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? 0) || 0,
    cacheCreationTokens: Number(usage.cacheCreationTokens ?? usage.prompt_cache_miss_tokens ?? usage.cache_creation_input_tokens ?? 0) || 0,
    reasoningTokens: Number(usage.reasoningTokens ?? usage.reasoning_tokens ?? 0) || 0,
  };
}

/**
 * DeepSeek Harness 后端。
 * 所有方法与其它后端（claude/zcode）同语义；transcript 解析针对 DSH 事件流。
 */
export class DshBackend {
  constructor() {
    this.type = 'dsh';
    this.name = 'DeepSeek Harness';
    this.version = process.env.DSH_VERSION || 'unknown';
  }

  /** 检测当前是否运行在 DeepSeek Harness 环境。 */
  detect() {
    return Boolean(process.env.DSH_SESSION_ID) ||
      process.env.HARNESS_BACKEND?.toLowerCase() === 'dsh';
  }

  /** 获取当前会话 ID。 */
  getSessionId() {
    return process.env.DSH_SESSION_ID || null;
  }

  /** 获取 DSH 数据目录（$DSH_HOME，缺省 ~/.dsh）。 */
  getDataDir() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
  }

  /**
   * 派发子代理。
   * DSH 无公开 headless CLI，实际调用由主会话的内置 subagent 工具完成；
   * 此方法返回准备好的 prompt，供主会话调用。
   */
  async dispatchSubAgent(role, prompt, options = {}) {
    return {
      exitStatus: 'PENDING',
      message: 'Please use the DeepSeek Harness subagent tool with the prepared prompt',
      role,
      prompt,
      options,
    };
  }

  /** 注入规则：DSH 通过根 AGENTS.md/CLAUDE.md 自动注入，无需额外动作。 */
  async injectRules() {
    return true;
  }

  /** 门禁检查：由 Uni-AURI 的 git hooks 与共享脚本（hooks/shared/*.sh）执行。 */
  async enforceGates() {
    return {
      allowed: true,
      note: 'Gate enforcement handled by Uni-AURI git hooks and shared scripts',
    };
  }

  /** 记录使用情况：usage 从 DSH 会话转录提取（见 extractTokenUsage）。 */
  async recordUsage() {
    // 当前用法统计统一走 getTranscriptPath + extractTokenUsage。
  }

  /** 获取会话转录路径（DSH_SESSION_JSONL，zstd 压缩的 jsonl 事件流）。 */
  getTranscriptPath() {
    return process.env.DSH_SESSION_JSONL || null;
  }

  /**
   * 从 DSH 转录提取 token 消耗。
   * 转录为 zstd 压缩的 jsonl 事件流，usage 出现在 assistant/message 的
   * data.message.usage 与 assistant/chunk 的 data.chunk.usage（同一步两份，
   * 按 turn:step 去重，assistant/message 优先）。解析失败/无 usage 返回 null。
   */
  extractTokenUsage(transcriptPath, startLine = 0) {
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    let text;
    try {
      if (isCompressedTranscript(transcriptPath)) {
        text = execFileSync('zstd', ['-dc', transcriptPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 512 * 1024 * 1024,
        });
      } else {
        text = readFileSync(transcriptPath, 'utf8');
      }
    } catch {
      return null; // zstd 缺失或解压失败 → 视为不可用，不抛错
    }

    const lines = text.split(/\r?\n/).filter(Boolean).slice(startLine);
    // 按 turn:step 去重（assistant/message 与 assistant/chunk 各报一次 usage）
    const perStep = new Map();
    const models = new Map();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (!obj || typeof obj !== 'object') continue;
        const data = obj.data;
        const stepKey = data && data.turn != null && data.step != null
          ? data.turn + ':' + data.step
          : null;
        // assistant/message 优先；chunk 仅当该 step 尚无记录时计入
        const chunkUsage = data?.chunk?.usage;
        const messageUsage = data?.message?.usage ?? obj.message?.usage;
        const usage = obj.type === 'assistant/message'
          ? (messageUsage ?? chunkUsage)
          : (chunkUsage ?? messageUsage);
        if (!usage || typeof usage !== 'object') continue;
        // 仅在实际入账（未被去重）时累计 model，避免被丢弃的 chunk 污染 model 占比
        let recorded = false;
        if (stepKey != null) {
          if (obj.type === 'assistant/message' || !perStep.has(stepKey)) {
            perStep.set(stepKey, usage);
            recorded = true;
          }
        } else {
          perStep.set('__seq_' + (obj.seq ?? Math.random()), usage);
          recorded = true;
        }
        if (recorded) {
          const model = data?.message?.model || obj.message?.model || 'deepseek';
          const u = normalizeUsage(usage);
          models.set(model, (models.get(model) || 0) + u.inputTokens + u.outputTokens);
        }
      } catch {
        // 单行解析失败忽略
      }
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let reasoningTokens = 0;
    for (const usage of perStep.values()) {
      const u = normalizeUsage(usage);
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
      cacheReadTokens += u.cacheReadTokens;
      cacheCreationTokens += u.cacheCreationTokens;
      reasoningTokens += u.reasoningTokens;
    }
    if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheCreationTokens === 0) {
      return null;
    }
    const dominantModel = [...models.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      reasoning_tokens: reasoningTokens,
      model: dominantModel ? dominantModel[0] : 'deepseek',
      provider: 'deepseek',
    };
  }
}

export default DshBackend;
