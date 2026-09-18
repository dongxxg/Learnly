// lib/normalize-result.js — 把不同 backend 的 dispatch 返回值归一化到统一格式
//
// 统一格式（snake_case）：
//   {
//     exit_status: "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED",
//     summary?: string,
//     artifacts?: string[],
//     score?: number,
//     p0_count?: number,
//     concerns?: Array,
//     escalate_reason?: string,   // 仅 BLOCKED 时
//     raw?: object                // 调试用：原始返回（不写 pipeline-state）
//   }
//
// 输入：
//   - claude 模式：sub-agent JSON 输出，已是 snake_case {exit_status, summary, ...}
//   - codex/qoder 模式：headless backend 返回 {exitStatus, output, summary?, ...}

/**
 * 归一化 dispatch 结果
 * @param {"claude"|"codebuddy"|"codex"|"qoder"|"zcode"} backendType
 * @param {object} rawResult
 * @returns {object} 统一格式
 */
export function normalizeDispatchResult(backendType, rawResult) {
  if (!rawResult || typeof rawResult !== 'object') {
    return {
      exit_status: 'DONE_WITH_CONCERNS',
      summary: '',
      concerns: [{ level: 'P2', type: 'empty-dispatch-result' }],
    };
  }

  if (backendType === 'claude' || backendType === 'codebuddy') {
    return _normalizeClaude(rawResult);
  }
  if (backendType === 'codex' || backendType === 'qoder') {
    return _normalizeHeadless(rawResult, backendType);
  }
  // 未知 backend，原样保留 exit_status（如果存在），否则降级
  return {
    exit_status: rawResult.exit_status || 'DONE_WITH_CONCERNS',
    summary: rawResult.summary || '',
    concerns: [{ level: 'P2', type: 'unknown-backend', backend: backendType }],
  };
}

function _normalizeClaude(raw) {
  const result = {
    exit_status: raw.exit_status || raw.exitStatus || 'DONE_WITH_CONCERNS',
  };
  if (raw.summary != null) result.summary = raw.summary;
  if (raw.artifacts != null) result.artifacts = raw.artifacts;
  if (raw.score != null) result.score = raw.score;
  if (raw.p0_count != null) result.p0_count = raw.p0_count;
  if (Array.isArray(raw.concerns)) result.concerns = raw.concerns;
  return result;
}

function _normalizeHeadless(raw, backendType) {
  // 错误路径：error 字段优先（dispatchSubAgent 失败时设置）
  if (raw.error) {
    return {
      exit_status: raw.exitStatus === 'BLOCKED' ? 'BLOCKED' : (raw.exitStatus || 'BLOCKED'),
      escalate_reason: _formatEscalateReason(raw.error, backendType),
      concerns: raw.concerns || [{ level: 'P1', type: `${backendType}-dispatch-error` }],
    };
  }

  const exitStatus = raw.exitStatus || raw.exit_status || 'DONE_WITH_CONCERNS';
  const result = { exit_status: exitStatus };

  // summary：codex _parseOutput 提取自 JSON；如果未提取到，退化用 output 前 200 字
  if (raw.summary != null) {
    result.summary = raw.summary;
  } else if (raw.output) {
    result.summary = raw.output.slice(0, 200);
  }

  if (raw.artifacts != null) result.artifacts = raw.artifacts;
  if (raw.score != null) result.score = raw.score;
  if (raw.p0_count != null) result.p0_count = raw.p0_count;
  if (Array.isArray(raw.concerns)) result.concerns = raw.concerns;

  return result;
}

function _formatEscalateReason(error, backendType = 'headless') {
  if (typeof error === 'string') return error.slice(0, 300);
  if (error && typeof error === 'object') {
    const type = error.type || 'unknown';
    const msg = (error.message || '').slice(0, 200);
    return `${backendType} dispatch failed: type=${type}${msg ? ` message=${msg}` : ''}`;
  }
  return `${backendType} dispatch failed (unknown error)`;
}

export default { normalizeDispatchResult };
