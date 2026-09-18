// test_collect_ai_by_backend.mjs — E2E test for collect-ai.js by_backend aggregation
//
// Covers:
//   - Task 5.1/5.2: collect-ai.js 的 by_backend 聚合（pipeline + natural 双路径）
//   - Task 5.3: Codex 稀疏字段在 by_backend 中保持 null（渲染时显示 —）
//   - usage.jsonl natural 条目的 backend 字段被正确读取
//   - 旧 state 文件（pipeline-state 第 3 条无 backend）兜底为 claude
//
// Run: node .claude/tools/scripts/tests/test_collect_ai_by_backend.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const COLLECT_AI = path.join(PROJECT_ROOT, '.claude', 'skills', 'daily-report', 'scripts', 'collect-ai.js');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'usage-mixed-backend');

const tests = [];

// === 端到端：collect-ai.js 处理临时 .harness/tasks，验证 by_backend ===
tests.push(function testCollectAiEndtoEndByBackend() {
  // 构造临时项目目录，含 .harness/tasks/<change>/pipeline-state.json
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-ai-test-'));
  try {
    const tasksDir = path.join(tmpDir, '.harness', 'tasks');
    const changeDir = path.join(tasksDir, 'usage-mixed-backend-fixture');
    fs.mkdirSync(changeDir, { recursive: true });
    // 复制 fixture pipeline-state.json
    const fixtureState = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'pipeline-state.json'), 'utf-8'));
    fs.writeFileSync(path.join(changeDir, 'pipeline-state.json'), JSON.stringify(fixtureState, null, 2));

    // 用临时 HOME 指向 fixture usage.jsonl，避免污染真实文件
    const tmpHome = path.join(tmpDir, 'fake-home');
    fs.mkdirSync(path.join(tmpHome, '.claude', 'usage'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_DIR, 'usage.jsonl'), path.join(tmpHome, '.claude', 'usage', 'usage.jsonl'));

    // 运行 collect-ai.js
    const out = execFileSync('node', [COLLECT_AI, '--date', '2026-07-07', '--cwd', tmpDir], {
      encoding: 'utf-8',
      // os.homedir() reads USERPROFILE on Windows and HOME on Unix.
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
    });
    const data = JSON.parse(out);
    const bb = data.summary.by_backend;
    assert.ok(bb, 'by_backend should exist in summary');

    // pipeline 路径：claude(2, 含 1 兜底) + codex(1)
    // + natural 路径（usage.jsonl）：claude(1) + codex(1)
    // 合计：claude dispatch_count=3, codex dispatch_count=2
    assert.ok(bb.claude, 'claude group');
    assert.ok(bb.codex, 'codex group');

    // pipeline: claude input=1500, codex total=30000
    // natural: claude input=2000, codex total=15000
    // 合计：claude input=3500, codex total=45000
    assert.equal(bb.claude.input_tokens, 3500);
    assert.equal(bb.codex.total_tokens, 45000);
    // codex 稀疏字段保持 null
    assert.equal(bb.codex.input_tokens, null);
    assert.equal(bb.codex.cached_tokens, null);
    assert.equal(bb.codex.output_tokens, null);
    assert.equal(bb.codex.reasoning_tokens, null);

    // backend_fallback_count：pipeline 路径有 1 条无 backend，natural 路径都有 backend
    assert.equal(data.summary.backend_fallback_count, 1);
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
