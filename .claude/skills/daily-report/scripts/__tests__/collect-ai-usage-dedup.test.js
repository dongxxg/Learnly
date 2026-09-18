'use strict';

// collect-ai-usage-dedup.test.js — Claude Code 会话 Token 重复计数修复
//
// 背景：Claude Code 在**流式响应过程中会把同一条 assistant 消息多次落盘**——
// 同一 message.id 出现 2~4 次，timestamp 相差仅数百毫秒、usage 字段完全相同。
// 采集器原按行累加 usage，导致同一次 API 调用被重复计入：
//   实测现场 1139 条含 usage 条目 → 按 message.id 去重后 444 条，
//   cache_read 虚高 2.61×，当日总量 5.17 亿 → 应为 2.06 亿。
//
// 修复：按 message.id 去重。无 message.id 的条目保持原样计入（不因缺字段丢量）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COLLECT_AI = path.join(__dirname, '..', 'collect-ai.js');
const DATE = '2026-09-11';

function runCollectAi(cwd, projectsDir) {
  const env = { ...process.env, HOME: cwd, HARNESS_PROJECTS_DIR: projectsDir };
  // 防宿主 codex/zcode 环境让 Claude 采集提前 return
  for (const k of ['CODEX', 'CODEX_HOME', 'CODEX_VERSION', 'ZCODE', 'ZCODE_HOME']) delete env[k];
  return JSON.parse(execFileSync(process.execPath, [COLLECT_AI, '--date', DATE, '--cwd', cwd], {
    encoding: 'utf-8', env,
  }));
}

function writeTranscript(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// 带 message.id 的 usage 事件（真实转录形态）
function usageEvent(ts, id, model, usage) {
  return { timestamp: ts, message: { id, model, usage } };
}

// 不带 message.id 的 usage 事件（兼容分支：应原样计入）
function usageEventNoId(ts, model, usage) {
  return { timestamp: ts, message: { model, usage } };
}

const U = (input, output, cacheRead) => ({
  input_tokens: input, output_tokens: output,
  cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0,
});

test('同一 message.id 的多行只计一次（流式重写去重）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-dedup-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const projectsDir = path.join(work, 'projects');
  const proj = path.join(projectsDir, 'proj-a');

  // 同一条消息落盘 3 次（timestamp 差数百毫秒、usage 完全相同）
  writeTranscript(path.join(proj, 'sess-1.jsonl'), [
    usageEvent(`${DATE}T01:00:00.000Z`, 'msg-1', 'model-x', U(100, 10, 1000)),
    usageEvent(`${DATE}T01:00:00.226Z`, 'msg-1', 'model-x', U(100, 10, 1000)),
    usageEvent(`${DATE}T01:00:00.428Z`, 'msg-1', 'model-x', U(100, 10, 1000)),
  ]);

  const out = runCollectAi(work, projectsDir);
  const s = out.summary;
  assert.strictEqual(s.session_input_tokens, 100, 'input 只计一次');
  assert.strictEqual(s.session_output_tokens, 10, 'output 只计一次');
  assert.strictEqual(s.session_cache_read_input_tokens, 1000, 'cache_read 只计一次');
  assert.strictEqual(s.session_count, 1, '会话数不受去重影响');
});

test('不同 message.id 各自计入（不误去重）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-dedup-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const projectsDir = path.join(work, 'projects');
  const proj = path.join(projectsDir, 'proj-a');

  writeTranscript(path.join(proj, 'sess-1.jsonl'), [
    usageEvent(`${DATE}T01:00:00.000Z`, 'msg-1', 'model-x', U(100, 10, 1000)),
    usageEvent(`${DATE}T01:00:05.000Z`, 'msg-2', 'model-x', U(200, 20, 2000)),
    // msg-2 的流式副本
    usageEvent(`${DATE}T01:00:05.200Z`, 'msg-2', 'model-x', U(200, 20, 2000)),
    usageEvent(`${DATE}T01:00:09.000Z`, 'msg-3', 'model-x', U(300, 30, 3000)),
  ]);

  const out = runCollectAi(work, projectsDir);
  const s = out.summary;
  assert.strictEqual(s.session_input_tokens, 600, '100+200+300');
  assert.strictEqual(s.session_output_tokens, 60);
  assert.strictEqual(s.session_cache_read_input_tokens, 6000);
});

test('无 message.id 的条目按原样计入（不因缺字段丢量）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-dedup-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const projectsDir = path.join(work, 'projects');
  const proj = path.join(projectsDir, 'proj-a');

  writeTranscript(path.join(proj, 'sess-1.jsonl'), [
    usageEventNoId(`${DATE}T01:00:00.000Z`, 'model-x', U(100, 10, 1000)),
    usageEventNoId(`${DATE}T01:00:01.000Z`, 'model-x', U(100, 10, 1000)),
    usageEvent(`${DATE}T01:00:02.000Z`, 'msg-9', 'model-x', U(50, 5, 500)),
  ]);

  const out = runCollectAi(work, projectsDir);
  const s = out.summary;
  assert.strictEqual(s.session_input_tokens, 250, '无 id 的两条各计一次 + 有 id 的一条');
  assert.strictEqual(s.session_cache_read_input_tokens, 2500);
});

test('跨文件同 message.id 只计一次（子代理转录副本）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-dedup-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const projectsDir = path.join(work, 'projects');
  const proj = path.join(projectsDir, 'proj-a');

  // 主会话与子代理转录含同一条消息
  writeTranscript(path.join(proj, 'sess-1.jsonl'), [
    usageEvent(`${DATE}T01:00:00.000Z`, 'shared-msg', 'model-x', U(100, 10, 1000)),
  ]);
  writeTranscript(path.join(proj, 'sess-1', 'subagents', 'agent-1.jsonl'), [
    usageEvent(`${DATE}T01:00:00.100Z`, 'shared-msg', 'model-x', U(100, 10, 1000)),
    usageEvent(`${DATE}T01:00:05.000Z`, 'agent-msg', 'model-y', U(400, 40, 4000)),
  ]);

  const out = runCollectAi(work, projectsDir);
  const s = out.summary;
  assert.strictEqual(s.session_input_tokens, 500, 'shared 计一次 + agent 自有的一条');
  assert.strictEqual(s.session_cache_read_input_tokens, 5000);
});
