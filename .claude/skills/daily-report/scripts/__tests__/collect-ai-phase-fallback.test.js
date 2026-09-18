'use strict';

// Issue !271 根因3：pipeline-state 阶段只有 started_at/completed_at、无 dispatch_history
// 数组时，原逻辑整段跳过 → Auto 流水线漏采。兜底：有角色的阶段按锚定日计 1 条（token null）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COLLECT_AI = path.join(__dirname, '..', 'collect-ai.js');
const DATE = '2026-08-11';

function writeState(work, change, pipeline) {
  const dir = path.join(work, '.harness', 'tasks', change);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pipeline-state.json'), JSON.stringify({
    schema_version: 6, mode: 'legacy', change_name: change,
    flow_type: 'development', current_phase: 'archive',
    pipeline,
  }));
}

function run(work) {
  return JSON.parse(execFileSync(process.execPath, [COLLECT_AI, '--date', DATE, '--cwd', work], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: work, USERPROFILE: work },
  }));
}

test('无 dispatch_history 的角色阶段按阶段时间计 1 条 dispatch（issue !271 根因3）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-fb-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  writeState(work, 'auto-flow', {
    intake: { status: 'done', started_at: `${DATE}T01:00:00Z`, completed_at: `${DATE}T01:05:00Z` },
    implement: { status: 'done', started_at: `${DATE}T02:00:00Z`, completed_at: `${DATE}T03:00:00Z` },
    'code-review': { status: 'done', started_at: `${DATE}T04:00:00Z` },
  });
  const out = run(work);
  // intake/smoke 角色为 null → 不计；implement + code-review 各计 1，token null
  assert.equal(out.summary.total_dispatches, 2, '两个有角色阶段各兜底 1 条');
  assert.equal(out.summary.dispatch_by_trigger.pipeline.dispatch_count, 2);
  const task = out.tasks.find((x) => x.change_name === 'auto-flow');
  assert.ok(task, 'task 条目存在');
  assert.equal(task.dispatches.filter((d) => d.token_usage === null).length, 2, 'token 记 null 不凭空补数');
});

test('有 dispatch_history 数组的阶段不走兜底（不双计）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-fb2-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  writeState(work, 'hist-flow', {
    implement: {
      status: 'done',
      started_at: `${DATE}T02:00:00Z`, // 阶段级时间存在，但有 history → 只按 history 计
      dispatch_history: [{
        started_at: `${DATE}T02:10:00Z`, completed_at: `${DATE}T02:30:00Z`,
        token_usage: { input_tokens: 10, output_tokens: 1 },
      }],
    },
  });
  const out = run(work);
  assert.equal(out.summary.total_dispatches, 1, 'history 数组存在时兜底不触发');
  assert.equal(out.summary.total_input_tokens, 10);
});

test('pending 阶段（无任何时间戳）不兜底', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-fb3-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  writeState(work, 'pend-flow', {
    implement: { status: 'pending', dispatch_history: [] },
    test: { status: 'pending' }, // 无 started_at → 不计
  });
  const out = run(work);
  assert.equal(out.summary.total_dispatches, 0);
});
