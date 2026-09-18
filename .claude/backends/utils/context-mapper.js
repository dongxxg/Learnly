// utils/context-mapper.js — 上下文模式映射工具

/**
 * Uni-AURI 上下文模式映射到不同后端
 */
export const CONTEXT_MODES = {
  minimal: {
    description: '最小上下文',
    claude: 'minimal',
    codex: 'danger-full-access',
    fileLimit: 5,
    tokenEstimate: 200,
  },
  read_only: {
    description: '只读上下文',
    claude: 'read_only',
    codex: 'danger-full-access',
    fileLimit: 20,
    tokenEstimate: 4500,
  },
  full: {
    description: '完整上下文',
    claude: 'full',
    codex: 'danger-full-access',
    fileLimit: 50,
    tokenEstimate: 8000,
  },
};

/**
 * 映射上下文模式到 Codex 沙箱级别
 */
export function mapToCodexSandbox(contextMode) {
  const mode = CONTEXT_MODES[contextMode];
  if (!mode) {
    return 'danger-full-access';
  }
  return mode.codex;
}

/**
 * 映射上下文模式到文件列表限制
 */
export function getFileLimit(contextMode) {
  const mode = CONTEXT_MODES[contextMode];
  return mode ? mode.fileLimit : 20;
}

/**
 * 获取上下文模式描述
 */
export function getContextModeDescription(contextMode) {
  const mode = CONTEXT_MODES[contextMode];
  return mode ? mode.description : 'Unknown';
}

/**
 * 推荐上下文模式（基于任务类型）
 */
export function recommendContextMode(taskType, complexity = 'medium') {
  const recommendations = {
    // 探索类任务
    explore: 'read_only',

    // 设计类任务
    design: complexity === 'high' ? 'full' : 'read_only',

    // 实现类任务
    implement: 'full',

    // 测试类任务
    test: 'read_only',

    // 代码审查
    review: 'read_only',

    // 对抗评审
    debate: 'read_only',

    // 默认
    default: 'full',
  };

  return recommendations[taskType] || recommendations.default;
}

export default {
  CONTEXT_MODES,
  mapToCodexSandbox,
  getFileLimit,
  getContextModeDescription,
  recommendContextMode,
};
