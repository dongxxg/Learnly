// utils/token-parser.js — 统一 Token 统计解析工具

/**
 * 统一的 Token 使用记录格式
 */
export const TOKEN_PRICING = {
  anthropic: {
    'claude-opus-4-20250514': { input: 15.0, output: 75.0, unit: 'USD per 1M tokens' },
    'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, unit: 'USD per 1M tokens' },
    'claude-haiku-4-20250514': { input: 0.8, output: 4.0, unit: 'USD per 1M tokens' },
    'claude-opus-4-8': { input: 15.0, output: 75.0, unit: 'USD per 1M tokens' },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0, unit: 'USD per 1M tokens' },
    'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, unit: 'USD per 1M tokens' },
    default: { input: 3.0, output: 15.0, unit: 'USD per 1M tokens' },
  },
  openai: {
    'gpt-4o': { input: 2.5, output: 10.0, unit: 'USD per 1M tokens' },
    'gpt-4o-mini': { input: 0.15, output: 0.60, unit: 'USD per 1M tokens' },
    'gpt-4-turbo': { input: 10.0, output: 30.0, unit: 'USD per 1M tokens' },
    'o1-preview': { input: 15.0, output: 60.0, unit: 'USD per 1M tokens' },
    'o1-mini': { input: 1.5, output: 4.0, unit: 'USD per 1M tokens' },
    default: { input: 2.5, output: 10.0, unit: 'USD per 1M tokens' },
  },
};

/**
 * 规范化 Token 使用记录到统一格式
 */
export function normalizeTokenUsage(raw, provider) {
  const normalized = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    model: 'unknown',
    provider: provider || 'unknown',
    cost_usd: 0,
  };

  // Anthropic 格式
  if (provider === 'anthropic' || raw.input_tokens !== undefined) {
    normalized.input_tokens = raw.input_tokens || 0;
    normalized.output_tokens = raw.output_tokens || 0;
    normalized.cache_read_input_tokens = raw.cache_read_input_tokens || 0;
    normalized.cache_creation_input_tokens = raw.cache_creation_input_tokens || 0;
    normalized.model = raw.model || 'unknown';
  }

  // OpenAI 格式
  if (provider === 'openai' || raw.prompt_tokens !== undefined) {
    normalized.input_tokens = raw.prompt_tokens || 0;
    normalized.output_tokens = raw.completion_tokens || 0;
    normalized.model = raw.model || 'unknown';
  }

  // 计算成本
  normalized.cost_usd = estimateCost(normalized);

  return normalized;
}

/**
 * 估算 Token 成本
 */
export function estimateCost(tokenUsage) {
  const { model, provider, input_tokens, output_tokens } = tokenUsage;

  const pricing = TOKEN_PRICING[provider]?.[model] || TOKEN_PRICING[provider]?.default;

  if (!pricing) {
    return 0;
  }

  const inputCost = (input_tokens / 1_000_000) * pricing.input;
  const outputCost = (output_tokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * 从多种格式解析 Token 使用记录
 */
export function parseTokenUsage(raw) {
  // 检测格式类型
  if (raw.input_tokens !== undefined || raw.prompt_tokens !== undefined) {
    // 已是某种标准格式
    const provider = raw.provider || detectProviderFromFormat(raw);
    return normalizeTokenUsage(raw, provider);
  }

  // 其他格式可以在这里扩展
  return null;
}

/**
 * 根据字段检测提供商
 */
function detectProviderFromFormat(raw) {
  if (raw.input_tokens !== undefined && raw.cache_read_input_tokens !== undefined) {
    return 'anthropic';
  }
  if (raw.prompt_tokens !== undefined) {
    return 'openai';
  }
  return 'unknown';
}

/**
 * 合并多个 Token 使用记录
 */
export function mergeTokenUsage(records) {
  const merged = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    models: {},
    providers: {},
    total_cost_usd: 0,
  };

  for (const record of records) {
    const normalized = parseTokenUsage(record);
    if (!normalized) continue;

    merged.input_tokens += normalized.input_tokens;
    merged.output_tokens += normalized.output_tokens;
    merged.cache_read_input_tokens += normalized.cache_read_input_tokens;
    merged.cache_creation_input_tokens += normalized.cache_creation_input_tokens;
    merged.total_cost_usd += normalized.cost_usd;

    // 统计模型使用
    if (!merged.models[normalized.model]) {
      merged.models[normalized.model] = 0;
    }
    merged.models[normalized.model] += normalized.input_tokens + normalized.output_tokens;

    // 统计提供商使用
    if (!merged.providers[normalized.provider]) {
      merged.providers[normalized.provider] = 0;
    }
    merged.providers[normalized.provider] += normalized.input_tokens + normalized.output_tokens;
  }

  return merged;
}

export default {
  TOKEN_PRICING,
  normalizeTokenUsage,
  estimateCost,
  parseTokenUsage,
  mergeTokenUsage,
};
