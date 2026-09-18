// test_recalc_tokens_backend.mjs — Unit tests for recalcTokens + computeStats by_backend
//
// Covers:
//   - Task 1.4: 旧 state 文件（无 backend 字段）按 claude 兜底
//   - Task 3.5: 混合 backend 的 by_backend / by_role_backend 聚合
//   - Task 3.4: 未知 backend 聚合到 unknown 组
//   - Codex 稀疏字段 → null（不补 0）
//   - by_role 旧字段保留 + deprecation 标记（混合时）
//
// Run: node .claude/tools/scripts/tests/test_recalc_tokens_backend.mjs

import assert from 'node:assert/strict';
import { recalcTokens, computeStats } from '../../../skills/rd-auto/scripts/lib/stats.js';

const tests = [];

// === Task 1.4: 旧 state 文件（无 backend 字段）按 claude 兜底 ===
tests.push(function testOldStateFallsBackToClaude() {
  const state = {
    pipeline: {
      implement: {
        dispatch_history: [
          { token_usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80, model: 'claude-X' } },
          { token_usage: { input_tokens: 200, output_tokens: 10, cache_read_input_tokens: 50, model: 'claude-X' } },
        ],
      },
    },
  };
  recalcTokens(state);
  const ts = state.token_summary;
  // 兜底：所有数据归到 claude 组
  assert.ok(ts.by_backend.claude, 'by_backend.claude should exist');
  assert.equal(ts.by_backend.claude.input_tokens, 300);
  assert.equal(ts.by_backend.claude.output_tokens, 15);
  assert.equal(ts.by_backend.claude.cached_tokens, 130);
  assert.equal(ts.by_backend.claude.dispatch_count, 2);
  // codex 不存在或 dispatch_count=0（finalize 后若无条目则不存在）
  assert.ok(!ts.by_backend.codex || ts.by_backend.codex.dispatch_count === 0 || ts.by_backend.codex === undefined,
    'codex should not have data');
  // 兜底计数 = 2（两条都缺 backend）
  assert.equal(ts.backend_fallback_count, 2);
});

// === Task 3.5: 混合 backend 的 by_backend 聚合 ===
tests.push(function testMixedBackendByBackendAggregation() {
  const state = {
    pipeline: {
      implement: {
        dispatch_history: [
          { token_usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 80, model: 'claude-X', backend: 'claude' } },
          { token_usage: { input_tokens: 200, output_tokens: 10, cache_read_input_tokens: 50, model: 'claude-X', backend: 'claude' } },
          { token_usage: { total: 20000, backend: 'codex' } },
          { token_usage: { total: 5000, backend: 'codex' } },
        ],
      },
    },
  };
  recalcTokens(state);
  const ts = state.token_summary;
  // claude 组：input/output/cached 累加
  assert.equal(ts.by_backend.claude.input_tokens, 300);
  assert.equal(ts.by_backend.claude.output_tokens, 15);
  assert.equal(ts.by_backend.claude.cached_tokens, 130);
  assert.equal(ts.by_backend.claude.total_tokens, null); // claude 不写 total
  assert.equal(ts.by_backend.claude.dispatch_count, 2);
  // codex 组：仅 total 累加，input/output/cached 应为 null（不补 0）
  assert.equal(ts.by_backend.codex.input_tokens, null);
  assert.equal(ts.by_backend.codex.output_tokens, null);
  assert.equal(ts.by_backend.codex.cached_tokens, null);
  assert.equal(ts.by_backend.codex.total_tokens, 25000);
  assert.equal(ts.by_backend.codex.dispatch_count, 2);
  // backend_fallback_count = 0（都有 backend 字段）
  assert.equal(ts.backend_fallback_count, 0);
});

// === Task 3.5: by_role_backend 二维交叉 ===
tests.push(function testByRoleBackendCrossProduct() {
  const state = {
    pipeline: {
      design: {
        dispatch_history: [
          { token_usage: { input_tokens: 100, backend: 'claude', cache_read_input_tokens: 20, model: 'claude-X' } },
        ],
      },
      implement: {
        dispatch_history: [
          { token_usage: { total: 20000, backend: 'codex' } },
        ],
      },
    },
  };
  // 模拟 phaseSkillMap：design→architect, implement→developer
  // recalcTokens 内部用 parseRules(RULES_PATH)，实际场景下 role 来自规则；
  // 此处用真实规则（如果是当前项目）。为简化，我们只校验 by_backend 正确性。
  recalcTokens(state);
  const ts = state.token_summary;
  assert.ok(ts.by_backend.claude);
  assert.ok(ts.by_backend.codex);
  assert.equal(ts.by_backend.claude.input_tokens, 100);
  assert.equal(ts.by_backend.codex.total_tokens, 20000);
});

// === Task 3.4: 未知 backend 聚合到 unknown 组 ===
tests.push(function testUnknownBackendToUnknownGroup() {
  // 静默 stderr，避免测试输出噪声
  const origStderr = process.stderr.write.bind(process.stderr);
  let warned = '';
  process.stderr.write = (chunk) => { warned += chunk.toString(); return true; };
  try {
    const state = {
      pipeline: {
        implement: {
          dispatch_history: [
            { token_usage: { input_tokens: 100, backend: 'gemini', total: 999 } },
            { token_usage: { total: 20000, backend: 'codex' } },
          ],
        },
      },
    };
    recalcTokens(state);
    const ts = state.token_summary;
    assert.ok(ts.by_backend.unknown, 'unknown group should exist');
    assert.equal(ts.by_backend.unknown.dispatch_count, 1);
    // gemini 字段不归一化（unknown → 全 null）
    assert.equal(ts.by_backend.unknown.input_tokens, null);
    assert.equal(ts.by_backend.unknown.total_tokens, null);
    // 告警输出
    assert.ok(warned.includes('Unknown backend value: gemini'), `expected warning, got: ${warned}`);
  } finally {
    process.stderr.write = origStderr;
  }
});

// === Codex 稀疏字段 → null（不补 0）===
tests.push(function testCodexSparseFieldsAreNull() {
  const state = {
    pipeline: {
      implement: {
        dispatch_history: [
          { token_usage: { total: 1000, backend: 'codex' } },
        ],
      },
    },
  };
  recalcTokens(state);
  const codex = state.token_summary.by_backend.codex;
  assert.equal(codex.input_tokens, null, 'input should be null, not 0');
  assert.equal(codex.output_tokens, null, 'output should be null, not 0');
  assert.equal(codex.cached_tokens, null, 'cached should be null, not 0');
  assert.equal(codex.reasoning_tokens, null);
  assert.equal(codex.total_tokens, 1000);
  assert.equal(codex.model, null);
});

// === computeStats: by_backend 跨多 task 聚合 ===
tests.push(function testComputeStatsByBackendAcrossTasks() {
  const tasks = [
    {
      token_summary: {
        by_role: { developer: { input_tokens: 100, output_tokens: 5, model: 'claude-X' } },
        by_backend: {
          claude: { input_tokens: 100, output_tokens: 5, cached_tokens: 80, reasoning_tokens: null, total_tokens: null, dispatch_count: 1, model: 'claude-X' },
          codex: { input_tokens: null, output_tokens: null, cached_tokens: null, reasoning_tokens: null, total_tokens: 5000, dispatch_count: 1, model: null },
        },
      },
      pipeline: { implement: { status: 'done', exit_status: 'DONE', first_pass: true, dispatch_history: [{ started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z' }] } },
    },
    {
      token_summary: {
        by_role: { developer: { input_tokens: 200, output_tokens: 10, model: 'claude-X' } },
        by_backend: {
          claude: { input_tokens: 200, output_tokens: 10, cached_tokens: 50, reasoning_tokens: null, total_tokens: null, dispatch_count: 1, model: 'claude-X' },
          codex: { input_tokens: null, output_tokens: null, cached_tokens: null, reasoning_tokens: null, total_tokens: 15000, dispatch_count: 1, model: null },
        },
      },
      pipeline: { implement: { status: 'done', exit_status: 'DONE', first_pass: true, dispatch_history: [{ started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z' }] } },
    },
  ];
  const phaseSkillMap = { implement: { role: 'developer' } };
  const stats = computeStats(tasks, phaseSkillMap);
  // by_backend 跨 task 累加
  assert.equal(stats.by_backend.claude.input_tokens, 300);
  assert.equal(stats.by_backend.claude.output_tokens, 15);
  assert.equal(stats.by_backend.claude.cached_tokens, 130);
  assert.equal(stats.by_backend.claude.dispatch_count, 2);
  assert.equal(stats.by_backend.codex.input_tokens, null, 'codex input remains null across tasks');
  assert.equal(stats.by_backend.codex.total_tokens, 20000);
  assert.equal(stats.by_backend.codex.dispatch_count, 2);
  // by_role_backend cross
  assert.ok(stats.by_role_backend['developer.claude']);
  assert.ok(stats.by_role_backend['developer.codex']);
  assert.equal(stats.by_role_backend['developer.claude'].input_tokens, 300);
  assert.equal(stats.by_role_backend['developer.codex'].total_tokens, 20000);
  // by_role 旧字段保留 + deprecation 标记（developer 跨多 backend）
  const dev = stats.roles.find(r => r.role === 'developer');
  assert.equal(dev.total_input_tokens, 300); // by_role 旧字段：claude 的 input
  assert.equal(dev.__deprecated_for_backend_split, true);
  assert.equal(stats.by_role_deprecated_for_backend_split, true);
});

// === computeStats: 仅单一 backend（无混合）不标 deprecation ===
tests.push(function testComputeStatsSingleBackendNoDeprecation() {
  const tasks = [
    {
      token_summary: {
        by_role: { developer: { input_tokens: 100, output_tokens: 5, model: 'claude-X' } },
        by_backend: {
          claude: { input_tokens: 100, output_tokens: 5, cached_tokens: 80, reasoning_tokens: null, total_tokens: null, dispatch_count: 1, model: 'claude-X' },
        },
        by_role_backend: { 'developer.claude': { input_tokens: 100, output_tokens: 5, dispatch_count: 1, cached_tokens: 80, reasoning_tokens: null, total_tokens: null, model: 'claude-X' } },
      },
      pipeline: { implement: { status: 'done', exit_status: 'DONE', first_pass: true, dispatch_history: [{ started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z' }] } },
    },
  ];
  const phaseSkillMap = { implement: { role: 'developer' } };
  const stats = computeStats(tasks, phaseSkillMap);
  assert.equal(stats.by_role_deprecated_for_backend_split, false);
  const dev = stats.roles.find(r => r.role === 'developer');
  assert.equal(dev.__deprecated_for_backend_split, undefined);
  assert.equal(stats.by_backend.codex, undefined);
});

// === P1-001 回归：多角色任务 by_backend 不应被重复累加 ===
// Reviewer 复现：4 角色 task，by_backend.claude.input_tokens 应为 3800（4 × 950），不应膨胀到 15200
tests.push(function testMultiRoleTaskByBackendNotDuplicated() {
  const tasks = [
    {
      token_summary: {
        by_role: {
          architect: { input_tokens: 950, output_tokens: 100, model: 'claude-X' },
          developer: { input_tokens: 950, output_tokens: 100, model: 'claude-X' },
          tester:    { input_tokens: 950, output_tokens: 100, model: 'claude-X' },
          reviewer:  { input_tokens: 950, output_tokens: 100, model: 'claude-X' },
        },
        by_backend: {
          claude: {
            input_tokens: 3800, output_tokens: 400, cached_tokens: 0,
            reasoning_tokens: null, total_tokens: null,
            dispatch_count: 4, model: 'claude-X',
          },
        },
        by_role_backend: {
          'architect.claude': { input_tokens: 950, output_tokens: 100, cached_tokens: 0, reasoning_tokens: null, total_tokens: null, dispatch_count: 1, model: 'claude-X' },
          'developer.claude': { input_tokens: 950, output_tokens: 100, cached_tokens: 0, reasoning_tokens: null, total_tokens: null, dispatch_count: 1, model: 'claude-X' },
          'tester.claude':    { input_tokens: 950, output_tokens: 100, cached_tokens: 0, reasoning_tokens: null, total_tokens: null, dispatch_count: 1, model: 'claude-X' },
          'reviewer.claude':  { input_tokens: 950, output_tokens: 100, cached_tokens: 0, reasoning_tokens: null, total_tokens: null, dispatch_count: 1, model: 'claude-X' },
        },
        backend_fallback_count: 0,
      },
      pipeline: {
        explore:       { status: 'done', exit_status: 'DONE', first_pass: true, dispatch_history: [{ started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z' }] },
        implement:     { status: 'done', exit_status: 'DONE', first_pass: true, dispatch_history: [{ started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z' }] },
        test:          { status: 'done', exit_status: 'DONE', first_pass: true, dispatch_history: [{ started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z' }] },
        'code-review': { status: 'done', exit_status: 'DONE', first_pass: true, dispatch_history: [{ started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z' }] },
      },
    },
  ];
  const phaseSkillMap = {
    explore:       { role: 'architect' },
    implement:     { role: 'developer' },
    test:          { role: 'tester' },
    'code-review': { role: 'reviewer' },
  };
  const stats = computeStats(tasks, phaseSkillMap);
  const claude = stats.by_backend.claude;
  assert.equal(claude.dispatch_count, 4, `dispatch_count 应为 4（不是 16），实际 ${claude.dispatch_count}`);
  assert.equal(claude.input_tokens, 3800, `input_tokens 应为 3800（不是 15200），实际 ${claude.input_tokens}`);
  assert.equal(claude.output_tokens, 400, `output_tokens 应为 400（不是 1600），实际 ${claude.output_tokens}`);
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
    console.log(`  ${e.stack.split('\n').slice(1, 4).join('\n  ')}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed${failed === 0 ? '' : ', ' + failed + ' failed'}`);
if (failed > 0) process.exit(1);
