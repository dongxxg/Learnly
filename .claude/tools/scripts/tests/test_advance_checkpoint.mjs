// test_advance_checkpoint.mjs — Integration test for advance checkpoint persistence
//
// Covers:
//   - init 写入 checkpoint: null（字段存在，旧工具/脚本可安全读）
//   - advance 后 checkpoint 自动写入 phase/next_action/saved_at（零手动操作）
//   - 旧 state（无 checkpoint 字段）load 时补 null（增量字段迁移）
//   - status 文本输出展示 checkpoint（resume 时人/AI 可读）
//   - dashboard --json summary 含 checkpoint
//
// Run: node .claude/tools/scripts/tests/test_advance_checkpoint.mjs

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

function setupTempDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
  fs.mkdirSync(path.join(tmpDir, '.harness', 'tasks'), { recursive: true });
  return tmpDir;
}

function statePath(tmpDir, change = 'test-change') {
  return path.join(tmpDir, '.harness', 'tasks', change, 'pipeline-state.json');
}

function readState(tmpDir, change = 'test-change') {
  return JSON.parse(fs.readFileSync(statePath(tmpDir, change), 'utf-8'));
}

// === T1: init 后 checkpoint 字段存在且为 null ===
tests.push(function testInitHasCheckpointField() {
  const tmpDir = setupTempDir();
  try {
    execFileSync('node', [ORCHESTRATOR, 'init', 'test-change', '--title', 't', '--criteria', 'c1'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    const state = readState(tmpDir);
    assert.ok('checkpoint' in state, 'checkpoint field missing after init');
    assert.strictEqual(state.checkpoint, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// === T2: advance 后 checkpoint 自动写入（无需任何手动命令） ===
tests.push(function testAdvanceWritesCheckpoint() {
  const tmpDir = setupTempDir();
  try {
    execFileSync('node', [ORCHESTRATOR, 'init', 'test-change', '--title', 't', '--criteria', 'c1'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    execFileSync('node', [ORCHESTRATOR, 'advance', 'test-change', '--exit-status', 'DONE'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    const state = readState(tmpDir);
    const cp = state.checkpoint;
    assert.ok(cp, 'checkpoint not written after advance');
    assert.strictEqual(cp.phase, state.current_phase, 'checkpoint.phase should match current_phase');
    assert.ok(cp.next_action, 'checkpoint.next_action missing');
    assert.ok(cp.saved_at, 'checkpoint.saved_at missing');
    assert.ok(!Number.isNaN(Date.parse(cp.saved_at)), 'checkpoint.saved_at not a valid ISO date');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// === T3: 旧 state（无 checkpoint 字段）load 时补 null ===
tests.push(function testLegacyStateGetsCheckpointNull() {
  const tmpDir = setupTempDir();
  try {
    const changeDir = path.join(tmpDir, '.harness', 'tasks', 'legacy-change');
    fs.mkdirSync(changeDir, { recursive: true });
    // schema_version 6 但无 checkpoint 字段（本次改动前的存量 state）
    fs.writeFileSync(path.join(changeDir, 'pipeline-state.json'), JSON.stringify({
      schema_version: 6,
      change_name: 'legacy-change',
      current_phase: 'pending',
      pipeline: { intake: { status: 'pending' } },
      mode: 'legacy',
      team: null,
      pending_rework: null,
    }, null, 2));
    execFileSync('node', [ORCHESTRATOR, 'status', 'legacy-change'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    const state = readState(tmpDir, 'legacy-change');
    assert.ok('checkpoint' in state, 'legacy state not migrated with checkpoint field');
    assert.strictEqual(state.checkpoint, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// === T4: status 文本输出展示 checkpoint ===
tests.push(function testStatusDisplaysCheckpoint() {
  const tmpDir = setupTempDir();
  try {
    execFileSync('node', [ORCHESTRATOR, 'init', 'test-change', '--title', 't', '--criteria', 'c1'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    execFileSync('node', [ORCHESTRATOR, 'advance', 'test-change', '--exit-status', 'DONE'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    const out = execFileSync('node', [ORCHESTRATOR, 'status', 'test-change'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    assert.ok(/Checkpoint:/i.test(out), `status output lacks Checkpoint line:\n${out}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// === T5: dashboard --json summary 含 checkpoint ===
tests.push(function testDashboardJsonIncludesCheckpoint() {
  const tmpDir = setupTempDir();
  try {
    execFileSync('node', [ORCHESTRATOR, 'init', 'test-change', '--title', 't', '--criteria', 'c1'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    execFileSync('node', [ORCHESTRATOR, 'advance', 'test-change', '--exit-status', 'DONE'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    const out = execFileSync('node', [ORCHESTRATOR, 'dashboard', '--json'], {
      encoding: 'utf-8', cwd: tmpDir,
    });
    const tasks = JSON.parse(out);
    const t = tasks.find((x) => x.change_name === 'test-change');
    assert.ok(t, 'test-change missing from dashboard');
    assert.ok(t.checkpoint !== undefined, 'dashboard summary lacks checkpoint field');
    assert.ok(t.checkpoint && t.checkpoint.next_action, 'dashboard checkpoint lacks next_action');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Runner ───
let failed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`  [PASS] ${t.name}`);
  } catch (e) {
    failed++;
    console.error(`  [FAIL] ${t.name}\n    ${e.message}`);
  }
}
console.log(failed === 0 ? `\nAll ${tests.length} tests passed.` : `\n${failed}/${tests.length} tests FAILED.`);
process.exit(failed === 0 ? 0 : 1);
