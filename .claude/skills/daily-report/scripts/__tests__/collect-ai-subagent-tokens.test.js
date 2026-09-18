'use strict';

// collect-ai-subagent-tokens.test.js — Issue !266：collectSessionTokens 补采
// <session-id>/subagents/agent-*.jsonl 子目录（新版 Claude Code subagent 转录布局）
//
// 语义：subagent 文件 token 计入所属项目/模型聚合，但 session_count 与
// project count 只数主会话（主会话文件已代表该会话计一次）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COLLECT_AI = path.join(__dirname, '..', 'collect-ai.js');
const DATE = '2026-09-04';

function runCollectAi(cwd, projectsDir) {
  const env = { ...process.env, HOME: cwd, HARNESS_PROJECTS_DIR: projectsDir };
  // 防宿主 codex 环境让 collectSessionTokens 提前 return（backend=codex 跳过 Claude 采集）
  for (const k of ['CODEX', 'CODEX_HOME', 'CODEX_VERSION']) delete env[k];
  return JSON.parse(execFileSync(process.execPath, [COLLECT_AI, '--date', DATE, '--cwd', cwd], {
    encoding: 'utf-8', env,
  }));
}

function writeTranscript(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function usageEvent(ts, model, usage) {
  return { timestamp: ts, message: { model, usage } };
}

test('subagent 转录 token 计入项目聚合，session_count 只数主会话（Issue !266）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-sub-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const projectsDir = path.join(work, 'projects');
  const proj = path.join(projectsDir, 'proj-a');

  // 主会话 main-1：当日活动
  writeTranscript(path.join(proj, 'main-1.jsonl'), [
    usageEvent(`${DATE}T01:00:00.000Z`, 'model-x',
      { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }),
  ]);
  // main-1 的 subagent：token 应计入 proj-a
  writeTranscript(path.join(proj, 'main-1', 'subagents', 'agent-1.jsonl'), [
    usageEvent(`${DATE}T01:05:00.000Z`, 'model-y',
      { input_tokens: 5000, output_tokens: 2000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }),
  ]);
  // main-2 主会话无当日活动，但其 subagent 当日有活动：token 计入、不增 count
  writeTranscript(path.join(proj, 'main-2', 'subagents', 'agent-2.jsonl'), [
    usageEvent(`${DATE}T02:00:00.000Z`, 'model-x',
      { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);
  // 昨日的 subagent：不计
  writeTranscript(path.join(proj, 'main-1', 'subagents', 'agent-old.jsonl'), [
    usageEvent('2026-09-02T01:00:00.000Z', 'model-y',
      { input_tokens: 999999, output_tokens: 999999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  ]);

  const out = runCollectAi(work, projectsDir);
  const s = out.summary;

  // session_count 只数主会话（main-1）
  assert.strictEqual(s.session_count, 1);

  // 项目桶：count=1，token 含 subagent
  const bucket = s.session_by_project['proj-a'];
  assert.ok(bucket, 'proj-a 桶应存在');
  assert.strictEqual(bucket.count, 1);
  assert.strictEqual(bucket.input_tokens, 1000 + 5000 + 300);
  assert.strictEqual(bucket.output_tokens, 100 + 2000 + 30);
  assert.strictEqual(bucket.cache_read_tokens, 500 + 9000);

  // 顶层汇总含 subagent
  assert.strictEqual(s.session_input_tokens, 6300);
  assert.strictEqual(s.session_output_tokens, 2130);
  assert.strictEqual(s.session_cache_read_input_tokens, 9500);

  // 模型聚合：model-y 的 token 含 subagent 贡献
  assert.strictEqual(s.session_by_model['model-y'].input_tokens, 5000);
  assert.strictEqual(s.session_by_model['model-x'].input_tokens, 1000 + 300);
});
