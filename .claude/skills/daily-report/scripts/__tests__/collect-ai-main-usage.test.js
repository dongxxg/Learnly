'use strict';

// Issue !279：usage.jsonl trigger=main（主会话直出）单列 main 桶，
// 不混 natural、不计入 total_dispatches（PM 口径：调度表单列 + dispatch_count 不计 main）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COLLECT_AI = path.join(__dirname, '..', 'collect-ai.js');

function runCollectAi(cwd, date, env = {}) {
  return JSON.parse(execFileSync(process.execPath, [COLLECT_AI, '--date', date, '--cwd', cwd], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  }));
}

test('collect-ai usage.jsonl trigger=main 归 main 桶且 dispatch 口径不混入（issue !279）', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-main-'));
  const usageDir = path.join(work, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  const entry = (trigger, role, inp, out) => JSON.stringify({
    ts: '2026-08-11T05:00:00.000Z', // CST 13:00，落在目标日
    session_id: 's1', role, trigger, task: 'x', backend: 'claude',
    duration_ms: 1000,
    tokens: { input: inp, output: out, cache_read: 10, cache_creation: 1, model: 'm1' },
  });
  fs.writeFileSync(path.join(usageDir, 'usage.jsonl'), [
    entry('main', 'main-session', 1000, 200),
    entry('natural', 'developer', 300, 50),
  ].join('\n') + '\n');

  try {
    const out = runCollectAi(work, '2026-08-11', { HOME: work, HARNESS_USAGE_DIR: usageDir });
    const dbt = out.summary.dispatch_by_trigger;

    assert.equal(dbt.main.dispatch_count, 1, 'main 桶计入 1 条主会话直出');
    assert.equal(dbt.main.input_tokens, 1000, 'main token 归 main 桶');
    assert.equal(dbt.natural.dispatch_count, 1, 'natural 桶只剩真正的 dispatch 记录');
    assert.equal(dbt.natural.input_tokens, 300, 'main 记录不混入 natural');
    assert.equal(out.summary.total_dispatches, 1, 'total_dispatches 不计 main（PM 口径）');
    assert.equal(out.summary.total_input_tokens, 300, 'total_* 不计 main');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('collect-ai 无 main 记录时 main 桶保持零值（兼容旧数据）', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-main0-'));
  const usageDir = path.join(work, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(path.join(usageDir, 'usage.jsonl'), JSON.stringify({
    ts: '2026-08-11T05:00:00.000Z', session_id: 's1', role: 'tester',
    trigger: 'natural', task: 'x', backend: 'claude',
    tokens: { input: 5, output: 1, cache_read: 0, cache_creation: 0, model: 'm1' },
  }) + '\n');
  try {
    const out = runCollectAi(work, '2026-08-11', { HOME: work, HARNESS_USAGE_DIR: usageDir });
    assert.equal(out.summary.dispatch_by_trigger.main.dispatch_count, 0);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
