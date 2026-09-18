'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COLLECT_AI = path.join(__dirname, '..', 'collect-ai.js');

function writePipeline(dir, change, startedAt, tokens, opts = {}) {
  const stateDir = path.join(dir, '.harness', 'tasks', change);
  fs.mkdirSync(stateDir, { recursive: true });
  const state = {
    change_name: change,
    title: change,
    current_phase: 'implement',
    pipeline: {
      implement: {
        dispatch_history: [{
          started_at: startedAt,
          completed_at: null,
          token_usage: tokens,
          backend: opts.backend || 'claude',
          model: opts.model || 'test',
        }],
      },
    },
  };
  fs.writeFileSync(path.join(stateDir, 'pipeline-state.json'), JSON.stringify(state));
}

function runCollectAi(cwd, date, env = {}, extraArgs = []) {
  return JSON.parse(execFileSync(process.execPath, [COLLECT_AI, '--date', date, '--cwd', cwd, ...extraArgs], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  }));
}

test('collect-ai 单仓零回归（无 .harness-projects）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-single-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const date = '2026-08-11';
  writePipeline(work, 'main-change', `${date}T01:00:00.000Z`, { input_tokens: 100, output_tokens: 50 });
  const out = runCollectAi(work, date, { HOME: work });
  assert.strictEqual(out.summary.total_dispatches, 1);
  assert.strictEqual(out.tasks.length, 1);
  assert.strictEqual(out.tasks[0].change_name, 'main-change');
});

test('collect-ai 补采子仓 dispatch（issue !239 核心）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-sub-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const date = '2026-08-11';
  writePipeline(work, 'main-change', `${date}T01:00:00.000Z`, { input_tokens: 100, output_tokens: 50 });
  writePipeline(path.join(work, 'sub1'), 'sub-change', `${date}T03:00:00.000Z`, { input_tokens: 200, output_tokens: 80 });
  fs.writeFileSync(path.join(work, '.harness-projects'), 'sub1\n');
  const out = runCollectAi(work, date, { HOME: work });
  assert.strictEqual(out.summary.total_dispatches, 2);
  assert.strictEqual(out.summary.total_input_tokens, 300);
  const changes = out.tasks.map((x) => x.change_name).sort();
  assert.deepStrictEqual(changes, ['main-change', 'sub-change']);
});

test('collect-ai 子仓重复列出主仓时不重复累加（realpath 去重）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-dedup-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const date = '2026-08-11';
  writePipeline(work, 'main-change', `${date}T01:00:00.000Z`, { input_tokens: 100, output_tokens: 50 });
  // .harness-projects 把主仓自身也列出（'.' 相对路径）→ realpath 去重应只采一次
  fs.writeFileSync(path.join(work, '.harness-projects'), '.\n');
  const out = runCollectAi(work, date, { HOME: work });
  assert.strictEqual(out.summary.total_dispatches, 1);
});

test('collect-ai 子仓同名 change 不激活主仓 concerns（issue !239 P2-2）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-name-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const date = '2026-08-11';
  // 主仓 shared-state 有 same-change 的 concerns（今日无主仓 dispatch 活动），created_at 超时间窗
  const ssDir = path.join(work, '.harness', 'shared-state', 'same-change');
  fs.mkdirSync(ssDir, { recursive: true });
  fs.writeFileSync(path.join(ssDir, 'concerns.json'), JSON.stringify({
    p0: [{ severity: 'P0', status: 'open', author: 'tester', created_at: '2026-08-01T10:00:00.000Z', message: 'historical concern' }],
  }));
  // 主仓无今日 dispatch；子仓 same-change 今日有 dispatch
  writePipeline(path.join(work, 'sub1'), 'same-change', `${date}T03:00:00.000Z`, { input_tokens: 200, output_tokens: 80 });
  fs.writeFileSync(path.join(work, '.harness-projects'), 'sub1\n');
  const out = runCollectAi(work, date, { HOME: work });
  assert.strictEqual(out.summary.total_dispatches, 1);
  // 主仓无 dispatch → 走时间窗过滤：created_at 超 7 天的历史 concern 不计入日报
  assert.strictEqual(out.summary.concern_stats.total, 0);
});

test('collect-ai 无 dispatch 时统计近 7 天内 concerns（时间窗）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-window-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const date = '2026-08-11';
  // 主仓无 dispatch，但 concern 在近 7 天内创建 → 应统计（修复空 Set 全过滤 bug）
  const ssDir = path.join(work, '.harness', 'shared-state', 'recent-change');
  fs.mkdirSync(ssDir, { recursive: true });
  fs.writeFileSync(path.join(ssDir, 'concerns.json'), JSON.stringify({
    p0: [{ severity: 'P0', status: 'open', author: 'tester', created_at: '2026-08-10T10:00:00.000Z', message: 'recent P0' }],
  }));
  const out = runCollectAi(work, date, { HOME: work });
  assert.strictEqual(out.summary.concern_stats.p0_found, 1);
  assert.strictEqual(out.summary.concern_stats.p0_closed, 0);
});

test('collect-ai --user 下缺 author 的 concerns 计数进 missing_author_skipped（issue !278）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-noauthor-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const date = '2026-08-11';
  const ssDir = path.join(work, '.harness', 'shared-state', 'author-change');
  fs.mkdirSync(ssDir, { recursive: true });
  fs.writeFileSync(path.join(ssDir, 'concerns.json'), JSON.stringify({
    p0: [
      { severity: 'P0', status: 'open', author: 'tester', created_at: '2026-08-10T10:00:00.000Z', message: 'counted' },
      { severity: 'P0', status: 'open', created_at: '2026-08-10T11:00:00.000Z', message: 'missing author' },
      { severity: 'P1', status: 'open', author: '', created_at: '2026-08-10T12:00:00.000Z', message: 'empty author' },
    ],
  }));
  const out = runCollectAi(work, date, { HOME: work }, ['--user', 'tester']);
  // 有 author 的 1 条计入；缺 author / 空串各 skip 1 → 共 2
  assert.strictEqual(out.summary.concern_stats.total, 1);
  assert.strictEqual(out.summary.concern_stats.p0_found, 1);
  assert.strictEqual(out.summary.concern_stats.missing_author_skipped, 2);
});

test('collect-ai codex dispatch 结构化 token 明细入日报（issue !262）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-codex-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const date = '2026-08-11';
  // codex 透传后的 token_usage：结构化明细 + total 兜底 + backend=codex
  writePipeline(work, 'codex-change', `${date}T01:00:00.000Z`, {
    input_tokens: 8000,
    output_tokens: 2000,
    cache_read_input_tokens: 1500,
    reasoning_output_tokens: 300,
    total: 10000,
    backend: 'codex',
  }, { backend: 'codex', model: 'codex' });
  const out = runCollectAi(work, date, { HOME: work });
  assert.strictEqual(out.summary.total_dispatches, 1);
  const codex = out.summary.by_backend.codex;
  assert.ok(codex, 'by_backend.codex bucket 应存在');
  // 明细不再被丢弃：input/output/cached/reasoning 都进入 by_backend 聚合
  assert.strictEqual(codex.dispatch_count, 1);
  assert.strictEqual(codex.input_tokens, 8000);
  assert.strictEqual(codex.output_tokens, 2000);
  assert.strictEqual(codex.cached_tokens, 1500);
  assert.strictEqual(codex.reasoning_tokens, 300);
  assert.strictEqual(codex.total_tokens, 10000);
});

test('collect-ai codex 无明细时 total-only 兜底（旧数据兼容）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-codex-total-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const date = '2026-08-11';
  // 旧 codex 数据：只有 {total: N}（!262 之前的落盘形状）
  writePipeline(work, 'codex-old', `${date}T01:00:00.000Z`, {
    total: 5000,
    backend: 'codex',
  }, { backend: 'codex', model: 'codex' });
  const out = runCollectAi(work, date, { HOME: work });
  const codex = out.summary.by_backend.codex;
  assert.ok(codex, 'by_backend.codex bucket 应存在');
  assert.strictEqual(codex.total_tokens, 5000);
  // finalize 将未见的明细字段置 null（不是 0）——总时仅 total 有值
  assert.strictEqual(codex.input_tokens, null);
  assert.strictEqual(codex.output_tokens, null);
});
