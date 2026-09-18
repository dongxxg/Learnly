// test_record_usage_dedup.mjs — record-usage 的 usage 去重回归测试
//
// 背景：Claude Code 在**流式响应过程中会把同一条 assistant 消息多次落盘**——
// 同一 message.id 出现 2~4 次（timestamp 相差仅数百毫秒、usage 字段完全相同）。
// extractTokenUsage 原按行累加 usage，导致同一次 API 调用被重复计入：
//   实测现场该会话 cache_read 未去重 419,785,472 / 去重后 159,302,528（虚高 2.57×），
//   直接抬高了日报「AI 员工调度统计」的 main-session 行。
//
// 修复：extractTokenUsage 内按 message.id 去重（窗口内），无 id 的条目原样计入。
//
// Run: node .claude/tools/scripts/tests/test_record_usage_dedup.mjs

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

// 造一条转录行（带 message.id）
function line(ts, msgId, input, output, cacheRead) {
  return JSON.stringify({
    timestamp: ts,
    message: {
      id: msgId,
      model: 'model-x',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

// 在隔离目录跑 record-usage，返回落盘的 tokens
function runRecordUsage(lines, fromLine) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recusage-'));
  try {
    const projSlugDir = path.join(tmp, 'projects', 'proj');
    fs.mkdirSync(projSlugDir, { recursive: true });
    fs.writeFileSync(path.join(projSlugDir, 'sess-1.jsonl'), lines.join('\n') + '\n');

    const usageDir = path.join(tmp, 'usage');
    fs.mkdirSync(usageDir, { recursive: true });

    execFileSync('node', [
      ORCHESTRATOR, 'record-usage',
      '--role', 'main-session', '--trigger', 'main', '--task', 'synth',
      '--from-line', String(fromLine),
      '--advance-offset-file', path.join(usageDir, '.off'),
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        HARNESS_USAGE_DIR: usageDir,
        HARNESS_PROJECTS_DIR: path.join(tmp, 'projects'),
        CLAUDE_CODE_SESSION_ID: 'sess-1',
        PROJECT_ROOT: tmp,
        HARNESS_BACKEND: 'claude',
      },
    });

    const written = fs.readFileSync(path.join(usageDir, 'usage.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return written.length ? written[written.length - 1].tokens : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// === 同一 message.id 落盘 3 次：只计一次 ===
tests.push(function testDedupSameMessageId() {
  const t = runRecordUsage([
    line('2026-09-11T01:00:00.000Z', 'm1', 100, 10, 1000),
    line('2026-09-11T01:00:00.226Z', 'm1', 100, 10, 1000),
    line('2026-09-11T01:00:00.428Z', 'm1', 100, 10, 1000),
    line('2026-09-11T01:00:05.000Z', 'm2', 200, 20, 2000),
    line('2026-09-11T01:00:05.200Z', 'm2', 200, 20, 2000),
  ], 0);
  assert.equal(t.input, 300, 'm1 计一次(100) + m2 计一次(200)');
  assert.equal(t.output, 30);
  assert.equal(t.cache_read, 3000, '未去重会是 7000');
});

// === 不同 message.id 不误去重 ===
tests.push(function testDistinctIdsCounted() {
  const t = runRecordUsage([
    line('2026-09-11T01:00:00.000Z', 'a', 100, 1, 1000),
    line('2026-09-11T01:00:01.000Z', 'b', 200, 2, 2000),
    line('2026-09-11T01:00:02.000Z', 'c', 300, 3, 3000),
  ], 0);
  assert.equal(t.input, 600);
  assert.equal(t.cache_read, 6000);
});

// === 偏移窗口内去重（from-line 从中间起，窗口内仍有副本）===
tests.push(function testDedupWithinOffsetWindow() {
  // 前 2 行已处理过；从第 2 行起只剩 m2 的两条副本
  const t = runRecordUsage([
    line('2026-09-11T01:00:00.000Z', 'm1', 100, 10, 1000),
    line('2026-09-11T01:00:00.226Z', 'm1', 100, 10, 1000),
    line('2026-09-11T01:00:05.000Z', 'm2', 200, 20, 2000),
    line('2026-09-11T01:00:05.200Z', 'm2', 200, 20, 2000),
  ], 2);
  assert.equal(t.input, 200, '窗口内 m2 的两条副本只计一次');
  assert.equal(t.cache_read, 2000, '未去重会是 4000');
});

// === 无 message.id 的条目原样计入（不因缺字段丢量）===
tests.push(function testNoMessageIdStillCounted() {
  const noId = (ts, input, cacheRead) => JSON.stringify({
    timestamp: ts,
    message: { model: 'model-x', usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
  });
  const t = runRecordUsage([
    noId('2026-09-11T01:00:00.000Z', 100, 1000),
    noId('2026-09-11T01:00:01.000Z', 100, 1000),
    line('2026-09-11T01:00:02.000Z', 'm9', 50, 5, 500),
  ], 0);
  assert.equal(t.input, 250, '两条无 id 各计一次 + 一条有 id');
  assert.equal(t.cache_read, 2500);
});

// === runner ===
let failed = 0;
for (const fn of tests) {
  try {
    fn();
    console.log(`✔ ${fn.name}`);
  } catch (e) {
    failed += 1;
    console.error(`✖ ${fn.name}\n   ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
