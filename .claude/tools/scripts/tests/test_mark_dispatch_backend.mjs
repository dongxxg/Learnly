// test_mark_dispatch_backend.mjs — Integration test for mark-dispatch --backend
//
// Covers Task 1.1-1.2: cmdMarkDispatch 接收 --backend 参数，写入 token_usage.backend
//
// Run: node .claude/tools/scripts/tests/test_mark_dispatch_backend.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ORCHESTRATOR = path.join(PROJECT_ROOT, '.claude', 'skills', 'rd-auto', 'scripts', 'orchestrator.js');

const tests = [];

function setupTempState() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-dispatch-test-'));
  const tasksDir = path.join(tmpDir, '.harness', 'tasks');
  const changeDir = path.join(tasksDir, 'test-change');
  fs.mkdirSync(changeDir, { recursive: true });
  // 最小 pipeline-state.json
  const state = {
    change_name: 'test-change',
    current_phase: 'implement',
    pipeline: {
      implement: {
        status: 'in_progress',
        dispatch_history: [
          // 已有 --start 推入的 open round（completed_at=null）
          { started_at: '2026-07-07T10:00:00Z', completed_at: null, token_usage: null, exit_status: null, _transcript_line: 0 },
        ],
      },
    },
  };
  fs.writeFileSync(path.join(changeDir, 'pipeline-state.json'), JSON.stringify(state, null, 2));
  return tmpDir;
}

function readState(tmpDir) {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, '.harness', 'tasks', 'test-change', 'pipeline-state.json'), 'utf-8'));
}

// === Task 1.1: --backend codex --tokens N 写入 token_usage.backend + total ===
tests.push(function testMarkDispatchEndCodexBackend() {
  const tmpDir = setupTempState();
  try {
    execFileSync('node', [
      ORCHESTRATOR, 'mark-dispatch', 'test-change', '--end',
      '--exit-status', 'DONE',
      '--summary', 'codex dispatch',
      '--backend', 'codex',
      '--tokens', '12345',
    ], { encoding: 'utf-8', cwd: tmpDir });
    const state = readState(tmpDir);
    const round = state.pipeline.implement.dispatch_history[0];
    assert.equal(round.completed_at != null, true);
    assert.equal(round.token_usage.backend, 'codex');
    assert.equal(round.token_usage.total, 12345);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// === Task 1.1: --backend claude 写入 token_usage.backend ===
tests.push(function testMarkDispatchEndClaudeBackend() {
  const tmpDir = setupTempState();
  try {
    execFileSync('node', [
      ORCHESTRATOR, 'mark-dispatch', 'test-change', '--end',
      '--exit-status', 'DONE',
      '--summary', 'claude dispatch',
      '--backend', 'claude',
    ], { encoding: 'utf-8', cwd: tmpDir });
    const state = readState(tmpDir);
    const round = state.pipeline.implement.dispatch_history[0];
    assert.equal(round.token_usage.backend, 'claude');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// === Task 1.1: 不传 --backend → token_usage.backend 不存在（向前兼容；recalcTokens 兜底）===
tests.push(function testMarkDispatchEndNoBackend() {
  const tmpDir = setupTempState();
  try {
    execFileSync('node', [
      ORCHESTRATOR, 'mark-dispatch', 'test-change', '--end',
      '--exit-status', 'DONE',
      '--summary', 'no backend',
    ], { encoding: 'utf-8', cwd: tmpDir });
    const state = readState(tmpDir);
    const round = state.pipeline.implement.dispatch_history[0];
    // 不传 --backend 时，token_usage 可能为 null（无 transcript 解析），或无 backend 字段
    // 由 recalcTokens 在读取时兜底为 claude
    if (round.token_usage) {
      assert.equal(round.token_usage.backend, undefined, 'backend should not be written when --backend not passed');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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
