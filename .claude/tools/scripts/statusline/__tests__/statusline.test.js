'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.resolve(__dirname, '..', 'statusline-command.cjs');
const {
  formatTokens,
  calcCacheRate,
  parseUsage,
  parseTranscriptUsage,
  parseUsageByRole,
  buildContextDisplay,
  buildDuration,
  lookupContextWindow,
  calcGenSpeed,
  buildApprovalDisplay,
  buildPipelineDisplay,
  displayWidth,
  truncateDisplayWidth,
} = require(MODULE);

// === formatTokens ===

function testFormatTokensZero() {
  assert.equal(formatTokens(0), '0');
}

function testFormatTokensSmall() {
  assert.equal(formatTokens(999), '999');
}

function testFormatTokensK() {
  assert.equal(formatTokens(1500), '1.5K');
  assert.equal(formatTokens(1000), '1.0K');
  assert.equal(formatTokens(9999), '10.0K');
}

function testFormatTokensM() {
  assert.equal(formatTokens(1_500_000), '1.5M');
  assert.equal(formatTokens(1_000_000), '1.0M');
}

function testFormatTokensInvalid() {
  assert.equal(formatTokens(undefined), '0');
  assert.equal(formatTokens(null), '0');
  assert.equal(formatTokens(NaN), '0');
  assert.equal(formatTokens(-100), '0');
  assert.equal(formatTokens('500'), '0'); // strings rejected
}

// === calcCacheRate ===
//
// 命中率 = cache_read / (cache_read + input)。
// input 是未命中部分（Anthropic API 把 input/cached/cache_creation 三者分开计），
// 不再用 cache_creation 当分母（cache_creation 几乎永远是 0，会让结果恒等于 100%）。

function testCalcCacheRateZeroDenominator() {
  // No input-side tokens → null (avoids meaningless "0%")
  assert.equal(calcCacheRate({ cache_read: 0, input: 0 }), null);
  assert.equal(calcCacheRate({}), null);
  assert.equal(calcCacheRate(null), null);
}

function testCalcCacheRateAllHit() {
  // input=0 表示全部命中
  assert.equal(calcCacheRate({ cache_read: 100, input: 0 }), 100);
}

function testCalcCacheRateAllMiss() {
  // cache_read=0 表示全部未命中
  assert.equal(calcCacheRate({ cache_read: 0, input: 100 }), 0);
}

function testCalcCacheRateMixed() {
  assert.equal(calcCacheRate({ cache_read: 80, input: 20 }), 80);
  assert.equal(calcCacheRate({ cache_read: 33, input: 67 }), 33);
}

function testCalcCacheRateRounding() {
  // 1/3 ≈ 33.33 → 33
  assert.equal(calcCacheRate({ cache_read: 1, input: 2 }), 33);
  // 2/3 ≈ 66.67 → 67
  assert.equal(calcCacheRate({ cache_read: 2, input: 1 }), 67);
}

// === parseUsage ===

function testParseUsageEmpty() {
  assert.deepEqual(parseUsage([]), { input: 0, output: 0, cache_read: 0, cache_creation: 0 });
  assert.deepEqual(parseUsage(null), { input: 0, output: 0, cache_read: 0, cache_creation: 0 });
}

function testParseUsageAggregate() {
  const lines = [
    JSON.stringify({ tokens: { input: 100, output: 50, cache_read: 10, cache_creation: 5 } }),
    JSON.stringify({ tokens: { input: 200, output: 80, cache_read: 20, cache_creation: 10 } }),
  ];
  const agg = parseUsage(lines);
  assert.equal(agg.input, 300);
  assert.equal(agg.output, 130);
  assert.equal(agg.cache_read, 30);
  assert.equal(agg.cache_creation, 15);
}

function testParseUsageSkipsBadLines() {
  const lines = [
    JSON.stringify({ tokens: { input: 100 } }),
    'not valid json',
    '',
    JSON.stringify({ tokens: { input: 200 } }),
    '{ broken',
  ];
  const agg = parseUsage(lines);
  assert.equal(agg.input, 300); // only the 2 valid lines
}

function testParseUsageMissingTokensField() {
  const lines = [
    JSON.stringify({ role: 'developer' }), // no tokens field
    JSON.stringify({ tokens: { input: 50 } }),
  ];
  const agg = parseUsage(lines);
  assert.equal(agg.input, 50);
}

function testParseUsageLimit() {
  // Generate 300 lines; only the last 200 should be summed.
  const lines = [];
  for (let i = 0; i < 300; i++) {
    lines.push(JSON.stringify({ tokens: { input: 1 } }));
  }
  const agg = parseUsage(lines, 200);
  assert.equal(agg.input, 200);
}

function testParseUsageDefaultLimit() {
  // Default limit=200
  const lines = [];
  for (let i = 0; i < 250; i++) {
    lines.push(JSON.stringify({ tokens: { input: 1 } }));
  }
  const agg = parseUsage(lines);
  assert.equal(agg.input, 200);
}

function testParseUsageSessionFilter() {
  // 按 session_id 过滤：只累加匹配 session 的行，忽略其他 session
  const lines = [
    JSON.stringify({ session_id: 'sess-A', tokens: { input: 100, output: 50 } }),
    JSON.stringify({ session_id: 'sess-B', tokens: { input: 9999, output: 9999 } }),
    JSON.stringify({ session_id: 'sess-A', tokens: { input: 200, output: 80 } }),
    JSON.stringify({ session_id: 'sess-C', tokens: { input: 9999 } }),
  ];
  const agg = parseUsage(lines, 200, 'sess-A');
  assert.equal(agg.input, 300);   // 100 + 200，sess-B/C 被过滤
  assert.equal(agg.output, 130);  // 50 + 80
}

function testParseUsageSessionFilterIgnoresLimit() {
  // sessionIdFilter 提供时，limit 不再生效（扫所有行找匹配）
  const lines = [];
  for (let i = 0; i < 250; i++) {
    lines.push(JSON.stringify({ session_id: 'old-session', tokens: { input: 1 } }));
  }
  lines.push(JSON.stringify({ session_id: 'curr', tokens: { input: 42 } }));
  // 默认 limit=200 会把前 50 行挤出窗口，但 curr 行在末尾会被读到
  // 关键是 old-session 的累加应该被过滤（不是被 limit 截断）
  const agg = parseUsage(lines, 200, 'curr');
  assert.equal(agg.input, 42);  // 只 curr，old-session 全被过滤
}

function testParseUsageNoSessionFilterBackwardCompat() {
  // 不传 sessionIdFilter：保持原有 limit 行为（向后兼容）
  const lines = [];
  for (let i = 0; i < 250; i++) {
    lines.push(JSON.stringify({ session_id: 'any', tokens: { input: 1 } }));
  }
  const agg = parseUsage(lines);  // 不传第三参数
  assert.equal(agg.input, 200);  // limit=200 截断
}

// === buildContextDisplay ===
//
// 新逻辑：按 model.id 查 MODEL_CONTEXT_WINDOWS 真实 size（payload 写死 200K 不分模型）。
// usedTokens 优先用 total_input_tokens（当前窗口占用）；缺失时回退 used_percentage × realSize。

function testContextDisplayMissing() {
  assert.equal(buildContextDisplay(null, 'glm-5.2'), '');
  assert.equal(buildContextDisplay({}, 'glm-5.2'), '');
  assert.equal(buildContextDisplay({ used_percentage: null }, 'glm-5.2'), '');
  assert.equal(buildContextDisplay({ context_window_size: 0 }, 'unknown-model'), '');
}

// glm-5.2 实际是 1M 窗口。Claude Code payload 写死 200K，导致失真。
// 修复后应显示 ctx:80K/1M(8%)（基于真实 size 1_000_000 重算）
function testContextDisplayKnownModelUsesMapping() {
  const out = buildContextDisplay(
    { total_input_tokens: 80000, context_window_size: 200000, used_percentage: 40 },
    'glm-5.2'
  );
  assert.ok(out.includes('ctx:80K/1M(8%)'), `glm-5.2 should use 1M size, got: ${out}`);
  assert.ok(out.includes('\x1b[32m'), `8% should be green, got: ${JSON.stringify(out)}`);
}

// 未知模型回退到 payload size
function testContextDisplayUnknownModelFallback() {
  const out = buildContextDisplay(
    { total_input_tokens: 5000, context_window_size: 200000 },
    'some-unknown-model'
  );
  assert.ok(out.includes('ctx:5K/200K(3%)'), `unknown model uses payload size, got: ${out}`);
}

// 没有 total_input_tokens 时回退到 used_percentage × realSize
function testContextDisplayFallbackPercentage() {
  const out = buildContextDisplay(
    { used_percentage: 30, context_window_size: 200000 },
    'glm-5.2'
  );
  // realSize=1M, pct=30, usedTokens=300K
  assert.ok(out.includes('ctx:300K/1M(30%)'), `fallback should use mapping size, got: ${out}`);
}

// 前缀匹配：claude-sonnet-4-6 → claude-sonnet-4- 前缀 → 1M
function testContextDisplayClaudeSonnetPrefix() {
  const out = buildContextDisplay(
    { total_input_tokens: 50000, context_window_size: 200000 },
    'claude-sonnet-4-6'
  );
  assert.ok(out.includes('ctx:50K/1M(5%)'), `sonnet should be 1M, got: ${out}`);
}

// 颜色边界
function testContextDisplayBoundary70() {
  // glm-5.2, 70% → yellow
  const out = buildContextDisplay({ used_percentage: 70, context_window_size: 200000 }, 'glm-5.2');
  assert.ok(out.includes('\x1b[33m'), `70% should be yellow boundary, got: ${JSON.stringify(out)}`);
}

function testContextDisplayBoundary90() {
  // glm-5.2, 90% → red
  const out = buildContextDisplay({ used_percentage: 90, context_window_size: 200000 }, 'glm-5.2');
  assert.ok(out.includes('\x1b[31m'), `90% should be red boundary, got: ${JSON.stringify(out)}`);
}

// === buildContextDisplay 优先级（修复 210% 失真 bug）===
//
// lastUsage（transcript 最后一条 message.usage）应优先于 payload total_input_tokens。
// payload 含累计 cache_read，高缓存率下显示 200%+；transcript 单次调用更准。

// lastUsage 优先：input + cache_read + cache_creation = 真实窗口占用
function testContextDisplayLastUsageWins() {
  // payload 失真：total_input_tokens=2.1M（含累计 cache_read）
  // lastUsage 真实：input=294 + cache_read=105728 + cache_creation=0 = 106022
  const out = buildContextDisplay(
    { total_input_tokens: 2_100_000, context_window_size: 200000, used_percentage: 100 },
    'glm-5.2',
    { input_tokens: 294, cache_read_input_tokens: 105728, cache_creation_input_tokens: 0 }
  );
  assert.ok(out.includes('ctx:106K/1M(11%)'), `lastUsage should win, got: ${out}`);
  assert.ok(!out.includes('210%'), `should not show inflated 210%, got: ${out}`);
}

// lastUsage 不完整（无 input_tokens）→ 回退 payload
function testContextDisplayLastUsageEmptyFallsBack() {
  const out = buildContextDisplay(
    { total_input_tokens: 80000, context_window_size: 200000, used_percentage: 40 },
    'glm-5.2',
    null
  );
  assert.ok(out.includes('ctx:80K/1M(8%)'), `null lastUsage should fall back, got: ${out}`);
}

// lastUsage 全为 0 → 回退 payload（避免 0 占用误导）
function testContextDisplayLastUsageZeroFallsBack() {
  const out = buildContextDisplay(
    { total_input_tokens: 80000, context_window_size: 200000 },
    'glm-5.2',
    { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  );
  assert.ok(out.includes('ctx:80K/1M(8%)'), `zero lastUsage should fall back, got: ${out}`);
}

// lastUsage 缺 cache 字段也能算（仅 input_tokens）
function testContextDisplayLastUsageInputOnly() {
  const out = buildContextDisplay(
    { total_input_tokens: 999_999_999, context_window_size: 200000 },
    'glm-5.2',
    { input_tokens: 50000 }
  );
  assert.ok(out.includes('ctx:50K/1M(5%)'), `input-only lastUsage, got: ${out}`);
}

// 无 ctx，仅 lastUsage 也能显示
function testContextDisplayLastUsageOnly() {
  const out = buildContextDisplay(null, 'glm-5.2', { input_tokens: 200000 });
  assert.ok(out.includes('ctx:200K/1M(20%)'), `lastUsage-only, got: ${out}`);
}

// === lookupContextWindow ===

function testLookupExact() {
  // 1M 模型
  assert.equal(lookupContextWindow('glm-5.2'), 1_000_000);
  assert.equal(lookupContextWindow('claude-opus-4-7'), 1_000_000);
  assert.equal(lookupContextWindow('gemini-2.5-pro'), 1_000_000);
  assert.equal(lookupContextWindow('gemini-2.5-flash'), 1_000_000);
  assert.equal(lookupContextWindow('qwen3.7-max'), 1_000_000);
  assert.equal(lookupContextWindow('qwen3-max'), 1_000_000);
  // 非 1M
  assert.equal(lookupContextWindow('claude-opus-4-6'), 200_000);
  assert.equal(lookupContextWindow('glm-5.1'), 204_800);
  assert.equal(lookupContextWindow('kimi-k2.5'), 256_000);
  assert.equal(lookupContextWindow('deepseek-v3'), 128_000);
  assert.equal(lookupContextWindow('gpt-4o'), 128_000);
  assert.equal(lookupContextWindow('grok-4'), 256_000);
  assert.equal(lookupContextWindow('longcat-2.0'), 1_000_000);
}

function testLookupPrefix() {
  // 前缀匹配
  assert.equal(lookupContextWindow('claude-sonnet-4-6'), 1_000_000);
  assert.equal(lookupContextWindow('claude-sonnet-4-7'), 1_000_000);
  assert.equal(lookupContextWindow('claude-haiku-4-5-20251001'), 200_000);
  assert.equal(lookupContextWindow('claude-3-5-sonnet'), 200_000);
  assert.equal(lookupContextWindow('gemini-2.0-flash'), 1_000_000);
  assert.equal(lookupContextWindow('gemini-3-pro'), 1_000_000);
  assert.equal(lookupContextWindow('glm-4-plus'), 128_000);
  assert.equal(lookupContextWindow('qwen3-coder'), 256_000);
  assert.equal(lookupContextWindow('qwen2.5-72b'), 128_000);
  assert.equal(lookupContextWindow('moonshot-v1-32k'), 128_000);
}

function testLookupLongestPrefixWins() {
  // 当多个前缀都能匹配时，最长前缀优先
  // 例如：claude-sonnet-4-6 同时匹配 'claude-sonnet-4-' 和 'claude-3-5-'？不，前者更具体
  assert.equal(lookupContextWindow('claude-sonnet-4-6'), 1_000_000);  // 而非 200_000
  // gemini-2.5-pro 同时精确匹配 + 匹配 'gemini-2.0-'/'gemini-3-' 前缀
  assert.equal(lookupContextWindow('gemini-2.5-pro'), 1_000_000);
}

function testLookupUnknown() {
  assert.equal(lookupContextWindow('some-future-model'), 0);
  assert.equal(lookupContextWindow('llama-3.3'), 0);
  assert.equal(lookupContextWindow('mistral-large'), 0);
  assert.equal(lookupContextWindow(''), 0);
  assert.equal(lookupContextWindow(null), 0);
  assert.equal(lookupContextWindow(undefined), 0);
}

// Issue !192: payload model.id 可能是 PascalCase（GLM-5.2 / GPT-4o / Claude-Sonnet-4-7）
// 表 keys 全小写，大小写不敏感匹配避免回退到 payload 200K 失真
function testLookupCaseInsensitive() {
  // 精确匹配大小写不敏感
  assert.equal(lookupContextWindow('GLM-5.2'), 1_000_000);
  assert.equal(lookupContextWindow('GPT-4o'), 128_000);
  assert.equal(lookupContextWindow('Claude-Opus-4-7'), 1_000_000);
  assert.equal(lookupContextWindow('DEEPSEEK-V3'), 128_000);
  // 前缀匹配大小写不敏感
  assert.equal(lookupContextWindow('CLAUDE-SONNET-4-6'), 1_000_000);
  assert.equal(lookupContextWindow('Gemini-2.0-Flash'), 1_000_000);
  assert.equal(lookupContextWindow('Qwen3-Coder'), 256_000);
  assert.equal(lookupContextWindow('MOONSHOT-V1-32K'), 128_000);
  // 混合大小写
  assert.equal(lookupContextWindow('Glm-5.2'), 1_000_000);
  assert.equal(lookupContextWindow('cLaUdE-sOnNeT-4-7'), 1_000_000);
  // LongCat-2.0（美图）：文档原名 PascalCase+连字符，1M 上下文
  assert.equal(lookupContextWindow('LongCat-2.0'), 1_000_000);
  assert.equal(lookupContextWindow('LONGCAT-2.0'), 1_000_000);
}

// === buildDuration ===

function testDurationMissing() {
  assert.equal(buildDuration(0, Date.now()), '');
  assert.equal(buildDuration(null, Date.now()), '');
  assert.equal(buildDuration(Date.now(), 0), '');
}

function testDurationInverted() {
  // now < start → ''
  assert.equal(buildDuration(Date.now() + 10000, Date.now()), '');
}

function testDurationMinutes() {
  // 5 minutes
  const start = 1_000_000;
  const now = start + 5 * 60 * 1000;
  assert.equal(buildDuration(start, now), '5min');
}

function testDurationHours() {
  // 2h30min
  const start = 1_000_000;
  const now = start + (2 * 3600 + 30 * 60) * 1000;
  assert.equal(buildDuration(start, now), '2h30min');
}

function testDurationDays() {
  // 1d2h30min
  const start = 1_000_000;
  const now = start + (26 * 3600 + 30 * 60) * 1000;
  assert.equal(buildDuration(start, now), '1d2h30min');
}

function testDurationSeconds() {
  // Less than a minute → 秒级显示 "Ss"（与 buildDuration 注释声明的 "Ss" 格式一致，
  // 秒级比 "0min" 更精确且不误导）。根因：旧测试期望 '0min'，实现已改进为秒级。
  const start = 1_000_000;
  const now = start + 30 * 1000;
  assert.equal(buildDuration(start, now), '30s');
}

// === parseTranscriptUsage ===

function testParseTranscriptUsageEmpty() {
  assert.deepEqual(parseTranscriptUsage([]), { input: 0, output: 0, cache_read: 0, cache_creation: 0 });
  assert.deepEqual(parseTranscriptUsage(null), { input: 0, output: 0, cache_read: 0, cache_creation: 0 });
}

function testParseTranscriptUsageAggregate() {
  // transcript usage 在 .message.usage，字段名带 _tokens 后缀（与 usage.jsonl 不同）
  const lines = [
    JSON.stringify({ message: { usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 400, cache_creation_input_tokens: 20 } } }),
  ];
  const agg = parseTranscriptUsage(lines);
  assert.equal(agg.input, 3000);
  assert.equal(agg.output, 1300);
  assert.equal(agg.cache_read, 600);
  assert.equal(agg.cache_creation, 30);
}

function testParseTranscriptUsageSkipsBadLines() {
  const lines = [
    JSON.stringify({ message: { usage: { input_tokens: 100 } } }),
    'not valid json',
    '',
    JSON.stringify({ message: { usage: { input_tokens: 200 } } }),
    '{ broken',
    JSON.stringify({ no_usage_here: true }),
  ];
  const agg = parseTranscriptUsage(lines);
  assert.equal(agg.input, 300); // 仅 2 行有效 usage
}

function testParseTranscriptUsageTopLevelUsage() {
  // 兼容 usage 在顶层 .usage（非 .message.usage）
  const lines = [JSON.stringify({ usage: { input_tokens: 50, output_tokens: 25 } })];
  const agg = parseTranscriptUsage(lines);
  assert.equal(agg.input, 50);
  assert.equal(agg.output, 25);
}

// === parseUsageByRole ===

function testParseUsageByRoleEmpty() {
  assert.deepEqual(parseUsageByRole([]), {});
  assert.deepEqual(parseUsageByRole(null), {});
}

function testParseUsageByRoleGroups() {
  const sid = 's1';
  const lines = [
    JSON.stringify({ session_id: sid, role: 'explore', tokens: { input: 100, output: 50, cache_read: 10 } }),
    JSON.stringify({ session_id: sid, role: 'explore', tokens: { input: 200, output: 80, cache_read: 20 } }),
    JSON.stringify({ session_id: sid, role: 'developer', tokens: { input: 500, output: 300, cache_read: 0 } }),
  ];
  const byRole = parseUsageByRole(lines, sid);
  assert.equal(byRole.explore.count, 2);
  assert.equal(byRole.explore.input, 300);
  assert.equal(byRole.explore.output, 130);
  assert.equal(byRole.developer.count, 1);
  assert.equal(byRole.developer.output, 300);
}

function testParseUsageByRoleSessionFilter() {
  const lines = [
    JSON.stringify({ session_id: 's1', role: 'explore', tokens: { input: 100, output: 50 } }),
    JSON.stringify({ session_id: 's2', role: 'developer', tokens: { input: 999, output: 999 } }),
  ];
  const byRole = parseUsageByRole(lines, 's1');
  assert.equal(Object.keys(byRole).length, 1); // 只含 s1 的 explore
  assert.equal(byRole.explore.count, 1);
  assert.ok(!byRole.developer);
}

function testParseUsageByRoleSkipsBadLines() {
  const sid = 's1';
  const lines = [
    'not json',
    JSON.stringify({ session_id: sid, role: 'reviewer', tokens: { input: 10 } }),
    '',
    JSON.stringify({ session_id: sid }), // 无 role/tokens → 归 unknown
  ];
  const byRole = parseUsageByRole(lines, sid);
  assert.equal(byRole.reviewer.count, 1);
  assert.equal(byRole.reviewer.input, 10);
  assert.equal(byRole.unknown.count, 1); // 无 role 的归 unknown
}

// === calcGenSpeed ===

function testGenSpeedInsufficientData() {
  assert.equal(calcGenSpeed(null), null);
  assert.equal(calcGenSpeed([]), null);
  assert.equal(calcGenSpeed([{ timestamp: '2026-08-18T10:00:00Z', output_tokens: 100 }]), null);
}

function testGenSpeedSpanTooShort() {
  const t0 = '2026-08-18T10:00:00.000Z';
  const t1 = '2026-08-18T10:00:00.500Z'; // 0.5s → 抖动，弃用
  assert.equal(calcGenSpeed([{ timestamp: t0, output_tokens: 500 }, { timestamp: t1, output_tokens: 500 }]), null);
}

function testGenSpeedBasic() {
  const t0 = '2026-08-18T10:00:00Z';
  const t1 = '2026-08-18T10:00:10Z'; // 10s
  assert.equal(calcGenSpeed([
    { timestamp: t0, output_tokens: 100 },
    { timestamp: t1, output_tokens: 200 },
  ]), 30); // (100+200)/10
}

function testGenSpeedBadTimestamp() {
  assert.equal(calcGenSpeed([
    { timestamp: 'not-a-date', output_tokens: 100 },
    { timestamp: '2026-08-18T10:00:10Z', output_tokens: 200 },
  ]), null);
}

function testGenSpeedMissingOutputTreatedAsZero() {
  const t0 = '2026-08-18T10:00:00Z';
  const t1 = '2026-08-18T10:00:10Z';
  assert.equal(calcGenSpeed([
    { timestamp: t0 },
    { timestamp: t1, output_tokens: 250 },
  ]), 25); // 缺 output 按累加 0 处理
}

// === buildApprovalDisplay ===

function testApprovalNone() {
  assert.equal(buildApprovalDisplay({}), '');
  assert.equal(buildApprovalDisplay({ pushPending: false, branchPending: false }), '');
}

function testApprovalPush() {
  const s = buildApprovalDisplay({ pushPending: true });
  assert.ok(s.includes('🔐待push审批'));
  assert.ok(!s.includes('待分支审批'));
}

function testApprovalBoth() {
  const s = buildApprovalDisplay({ pushPending: true, branchPending: true });
  assert.ok(s.includes('🔐待push审批'));
  assert.ok(s.includes('🔐待分支审批'));
  assert.ok(s.includes('·'));
}

// === buildPipelineDisplay ===

function testPipelineEmpty() {
  assert.equal(buildPipelineDisplay(null), '');
  assert.equal(buildPipelineDisplay([]), '');
}

function testPipelineTerminalFiltered() {
  assert.equal(buildPipelineDisplay([
    { change: 'a', phase: 'completed', mtimeMs: 2 },
    { change: 'b', phase: 'ARCHIVED', mtimeMs: 1 }, // 大写终态同样过滤
  ]), '');
}

function testPipelineNewestActiveWins() {
  const s = buildPipelineDisplay([
    { change: 'older', phase: 'apply', mtimeMs: 100 },
    { change: 'newer', phase: 'propose', mtimeMs: 200 },
    { change: 'done', phase: 'completed', mtimeMs: 300 },
  ]);
  assert.ok(s.includes('newer:propose'));
  assert.ok(!s.includes('older'));
}

// === displayWidth / truncateDisplayWidth ===

function testDisplayWidthAscii() {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth(''), 0);
}

function testDisplayWidthCjkAndEmoji() {
  assert.equal(displayWidth('待审批'), 6); // 中文每字 2 列
  assert.equal(displayWidth('⚡'), 2);
  assert.equal(displayWidth('♻️'), 2); // U+267B + VS16：VS16 不占宽
}

function testDisplayWidthAnsiIgnored() {
  assert.equal(displayWidth('\x1b[31mabc\x1b[0m'), 3);
}

function testTruncateNoopUnderLimit() {
  const s = 'abc待审批';
  assert.equal(truncateDisplayWidth(s, 20), s);
  assert.equal(truncateDisplayWidth(s, displayWidth(s)), s);
}

function testTruncateCutsToLimit() {
  const s = 'abcdef';
  const out = truncateDisplayWidth(s, 4);
  assert.ok(out.endsWith('…'));
  assert.ok(displayWidth(out) <= 4); // '…' 自身占 2 列，预算含省略号
  assert.equal(out, 'ab…');
}

function testTruncateWideChars() {
  const out = truncateDisplayWidth('待审批待审批', 5);
  assert.ok(displayWidth(out) <= 5);
  assert.ok(out.endsWith('…'));
}

// === Runner ===

const tests = [
  testFormatTokensZero, testFormatTokensSmall, testFormatTokensK, testFormatTokensM, testFormatTokensInvalid,
  testCalcCacheRateZeroDenominator, testCalcCacheRateAllHit, testCalcCacheRateAllMiss, testCalcCacheRateMixed, testCalcCacheRateRounding,
  testParseUsageEmpty, testParseUsageAggregate, testParseUsageSkipsBadLines, testParseUsageMissingTokensField, testParseUsageLimit, testParseUsageDefaultLimit,
  testParseUsageSessionFilter, testParseUsageSessionFilterIgnoresLimit, testParseUsageNoSessionFilterBackwardCompat,
  testContextDisplayMissing, testContextDisplayKnownModelUsesMapping, testContextDisplayUnknownModelFallback, testContextDisplayFallbackPercentage, testContextDisplayClaudeSonnetPrefix, testContextDisplayBoundary70, testContextDisplayBoundary90,
  testContextDisplayLastUsageWins, testContextDisplayLastUsageEmptyFallsBack, testContextDisplayLastUsageZeroFallsBack, testContextDisplayLastUsageInputOnly, testContextDisplayLastUsageOnly,
  testLookupExact, testLookupPrefix, testLookupLongestPrefixWins, testLookupUnknown, testLookupCaseInsensitive,
  testDurationMissing, testDurationInverted, testDurationMinutes, testDurationHours, testDurationDays, testDurationSeconds,
  testParseTranscriptUsageEmpty, testParseTranscriptUsageAggregate, testParseTranscriptUsageSkipsBadLines, testParseTranscriptUsageTopLevelUsage,
  testParseUsageByRoleEmpty, testParseUsageByRoleGroups, testParseUsageByRoleSessionFilter, testParseUsageByRoleSkipsBadLines,
  testGenSpeedInsufficientData, testGenSpeedSpanTooShort, testGenSpeedBasic, testGenSpeedBadTimestamp, testGenSpeedMissingOutputTreatedAsZero,
  testApprovalNone, testApprovalPush, testApprovalBoth,
  testPipelineEmpty, testPipelineTerminalFiltered, testPipelineNewestActiveWins,
  testDisplayWidthAscii, testDisplayWidthCjkAndEmoji, testDisplayWidthAnsiIgnored,
  testTruncateNoopUnderLimit, testTruncateCutsToLimit, testTruncateWideChars,
];

let failed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`# PASS: ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`# FAIL: ${t.name}`);
    console.log(`  ${e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed${failed === 0 ? '' : ', ' + failed + ' failed'}`);
if (failed > 0) process.exit(1);
