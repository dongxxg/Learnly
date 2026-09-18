// test_normalize_token_usage.mjs — Unit tests for normalizeTokenUsage
//
// Covers:
//   - Claude 条目归一化（cache_read → cached；cache_creation 丢弃；reasoning=null；total=null）
//   - Codex 条目归一化（仅 total，其余 null）
//   - token_usage=null（dispatch 失败）→ 全 null
//   - 未知 backend（gemini）→ 全 null
//   - backend 缺失 → claude 兜底
//
// Run: node .claude/tools/scripts/tests/test_normalize_token_usage.mjs

import assert from 'node:assert/strict';
import { normalizeTokenUsage } from '../../../skills/rd-auto/scripts/lib/stats.js';

const tests = [];

// === Claude 条目归一化 ===
tests.push(function testClaudeFullTokens() {
  const raw = {
    input_tokens: 100,
    output_tokens: 5,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 10,
    model: 'claude-sonnet-4-6',
  };
  const n = normalizeTokenUsage(raw, 'claude');
  assert.equal(n.input, 100);
  assert.equal(n.output, 5);
  assert.equal(n.cached, 80); // cache_read → cached
  assert.equal(n.reasoning, null); // Claude 无 reasoning 字段
  assert.equal(n.total, null); // 不强制求和（cache_creation 不属 input/output）
  assert.equal(n.model, 'claude-sonnet-4-6');
});

tests.push(function testClaudeCacheCreationDropped() {
  // cache_creation 不应该出现在 cached 或 input 里
  const raw = {
    input_tokens: 100,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 500,
    model: 'claude-sonnet-4-6',
  };
  const n = normalizeTokenUsage(raw, 'claude');
  assert.equal(n.cached, 0);
  assert.equal(n.input, 100);
  // total 应为 null，不是 600（不把 cache_creation 加进去）
  assert.equal(n.total, null);
});

// === Codex 条目归一化（数据稀疏）===
tests.push(function testCodexOnlyTotal() {
  const raw = { total: 20000 };
  const n = normalizeTokenUsage(raw, 'codex');
  assert.equal(n.input, null);
  assert.equal(n.output, null);
  assert.equal(n.cached, null);
  assert.equal(n.reasoning, null);
  assert.equal(n.total, 20000);
  assert.equal(n.model, null);
});

tests.push(function testCodexMissingTotal() {
  // codex dispatch 无 parseable tokens → token_usage 可能为 {backend:'codex'} 或 null
  const n = normalizeTokenUsage({}, 'codex');
  assert.equal(n.total, null);
  assert.equal(n.input, null);
});

// === token_usage=null（dispatch 失败 / transcript 解析失败）===
tests.push(function testNullTokens() {
  const n = normalizeTokenUsage(null, 'claude');
  // 即使 backend=claude，原始数据缺失时各字段仍为 null（不补 0）
  assert.equal(n.input, null);
  assert.equal(n.output, null);
  assert.equal(n.cached, null);
  assert.equal(n.model, null);
});

// === 未知 backend ===
tests.push(function testUnknownBackend() {
  const raw = { input_tokens: 100, output_tokens: 5, total: 999 };
  const n = normalizeTokenUsage(raw, 'gemini');
  // 未知 backend：不假设字段语义，全 null（dispatch_count 仍计）
  assert.equal(n.input, null);
  assert.equal(n.output, null);
  assert.equal(n.total, null);
});

// === backend 缺失 → claude 兜底 ===
tests.push(function testBackendFallback() {
  const raw = {
    input_tokens: 50,
    output_tokens: 10,
    cache_read_input_tokens: 20,
    model: 'claude-sonnet-4-6',
  };
  const n = normalizeTokenUsage(raw, null);
  assert.equal(n.input, 50);
  assert.equal(n.output, 10);
  assert.equal(n.cached, 20);
  assert.equal(n.model, 'claude-sonnet-4-6');
});

tests.push(function testBackendUndefined() {
  const raw = { input_tokens: 7 };
  const n = normalizeTokenUsage(raw, undefined);
  assert.equal(n.input, 7);
});

// === 数值类型校验（string 应视为缺失 → null）===
tests.push(function testNonNumericInput() {
  const raw = { input_tokens: 'abc', output_tokens: 5 };
  const n = normalizeTokenUsage(raw, 'claude');
  // 非数字 → null（不补 0，不强制转换）
  assert.equal(n.input, null);
  assert.equal(n.output, 5);
});

// === Run ===
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
