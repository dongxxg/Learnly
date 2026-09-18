'use strict';

// Issues #277/#282: collect-ai.js zcode 采集修复测试（CJS，子进程执行，参照 collect-ai-subrepo.test.js）。
// 覆盖：
//   - zcode dispatch token_usage 归一化入 by_backend（不再全 null）
//   - zcode {total} 单值（显式 --tokens 透传）映射
//   - started_at=null 的 dispatch 不再整条丢弃（limt 实测 code-review 漏统）
//   - zcode model-io 会话级聚合（session_* 总量 / session_by_model / session_by_project）
//   - zcode 会话与 Claude 会话融合采集（feature/930 融合语义：各自入桶、不混淆）
// Run: node --test __tests__/collect-ai-zcode.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COLLECT_AI = path.join(__dirname, '..', 'collect-ai.js');

const DATE = '2026-09-08';

// zcode backend 隔离 env：HARNESS_BACKEND 锁 zcode，
// ZCODE_PLUGIN_DATA/CODEX_HOME/ZCODE_ROLLOUT_DIR 全部指到临时目录，
// 避免误读本机真实 ~/.zcode / ~/.codex / ~/.claude 数据（测试日期是当天，极易污染）。
// USERPROFILE/HOME 双写：Windows 的 os.homedir() 只认 USERPROFILE，POSIX 只认 HOME；
// feature/930 融合采集会扫各 backend 的 ~ 下 projects 目录，不重定向会采到本机真实会话。
function zcodeEnv(work, rolloutDir) {
  return {
    HOME: work,
    USERPROFILE: work,
    HARNESS_BACKEND: 'zcode',
    ZCODE_PLUGIN_DATA: path.join(work, 'zdata'),
    CODEX_HOME: path.join(work, 'codexhome'),
    ZCODE_ROLLOUT_DIR: rolloutDir || path.join(work, 'no-rollout'),
  };
}

function runCollectAi(cwd, date, env = {}) {
  return JSON.parse(execFileSync(process.execPath, [COLLECT_AI, '--date', date, '--cwd', cwd], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  }));
}

// 写 pipeline-state.json：dispatch 的 token_usage 内含 backend（真实 mark-dispatch 落盘形状）
function writePipeline(dir, change, dispatch) {
  const stateDir = path.join(dir, '.harness', 'tasks', change);
  fs.mkdirSync(stateDir, { recursive: true });
  const state = {
    change_name: change,
    title: change,
    current_phase: 'implement',
    pipeline: {
      implement: {
        dispatch_history: [dispatch],
      },
    },
  };
  fs.writeFileSync(path.join(stateDir, 'pipeline-state.json'), JSON.stringify(state));
}

// 写 zcode model-io JSONL（schema 与 2026-09-08 本机实测一致）
function writeModelIo(dir, filename, records) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function mkModelIoRecord(overrides = {}) {
  const {
    startedAt = `${DATE}T03:00:00.000Z`,
    completedAt = `${DATE}T03:01:00.000Z`,
    input = 100, output = 10, cacheRead = 0, cacheWrite = 0,
    modelId = 'glm-5.2', querySource = 'main_turn', role = 'main',
  } = overrides;
  return {
    startedAt, completedAt,
    durationMs: 60000, requestId: 'req-test', attempt: 1,
    model: { modelId, providerId: 'pid', role, source: 'config', variant: 'nothink' },
    response: {
      usage: {
        inputTokens: input, outputTokens: output,
        totalTokens: input + output + cacheRead + cacheWrite,
        cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
      },
      finishReason: 'stop',
    },
    sessionId: 'sess-test', turnId: 't-1', traceId: 'tr-1', type: 'model-io', querySource,
    request: { /* 完整请求体占位——解析时不得读入 */ },
  };
}

test('collect-ai zcode dispatch token 入 by_backend（issue #282 归一化不再全 null）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-zcode-dispatch-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  writePipeline(work, 'zc-change', {
    started_at: `${DATE}T01:00:00.000Z`,
    completed_at: `${DATE}T01:30:00.000Z`,
    exit_status: 'DONE',
    token_usage: {
      input_tokens: 8000, output_tokens: 2000,
      cache_read_input_tokens: 1500, cache_creation_input_tokens: 300,
      model: 'glm-5.2', backend: 'zcode',
    },
  });
  const out = runCollectAi(work, DATE, zcodeEnv(work));
  assert.strictEqual(out.summary.total_dispatches, 1);
  const zc = out.summary.by_backend.zcode;
  assert.ok(zc, 'by_backend.zcode bucket 应存在');
  assert.strictEqual(zc.dispatch_count, 1);
  assert.strictEqual(zc.input_tokens, 8000);
  assert.strictEqual(zc.output_tokens, 2000);
  assert.strictEqual(zc.cached_tokens, 1500);
  assert.strictEqual(zc.model, 'glm-5.2');
  assert.strictEqual(out.summary.total_input_tokens, 8000);
});

test('collect-ai zcode {total} 单值（显式 --tokens 透传）映射 total_tokens', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-zcode-total-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  writePipeline(work, 'zc-total', {
    started_at: `${DATE}T01:00:00.000Z`,
    completed_at: `${DATE}T01:30:00.000Z`,
    exit_status: 'DONE',
    token_usage: { total: 1234, backend: 'zcode' },
  });
  const out = runCollectAi(work, DATE, zcodeEnv(work));
  const zc = out.summary.by_backend.zcode;
  assert.ok(zc, 'by_backend.zcode bucket 应存在');
  assert.strictEqual(zc.total_tokens, 1234);
  assert.strictEqual(zc.input_tokens, null, '无明细字段 finalize 后保持 null');
});

test('collect-ai 不丢弃 started_at=null 的 dispatch（issue #282 limt 实测）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-zcode-nullstart-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // mark-dispatch --end 无对应 --start 时写 started_at:null + completed_at:now
  writePipeline(work, 'null-start', {
    started_at: null,
    completed_at: `${DATE}T05:00:00.000Z`,
    exit_status: 'DONE',
    token_usage: { input_tokens: 100, output_tokens: 20, backend: 'zcode' },
  });
  // 两个时间戳都缺 → 仍跳过（无法归档日期）
  writePipeline(work, 'both-null', {
    started_at: null,
    completed_at: null,
    exit_status: null,
    token_usage: null,
  });
  const out = runCollectAi(work, DATE, zcodeEnv(work));
  assert.strictEqual(out.summary.total_dispatches, 1, 'completed_at 命中日期的 dispatch 应计数');
  assert.strictEqual(out.tasks.length, 1);
  // schema Dispatch.started_at 必为 string：无 started_at 时以 completed_at 兜底
  assert.strictEqual(out.tasks[0].dispatches[0].started_at, `${DATE}T05:00:00.000Z`);
});

test('collect-ai zcode model-io 会话级聚合（issue #277 session_* 不再全 0）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-zcode-session-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const rollout = path.join(work, 'rollout');
  // 主会话文件：当日 main_turn 记录 + 一条非当日记录（必须排除）
  writeModelIo(rollout, 'model-io-sess_main-aaaa.jsonl', [
    mkModelIoRecord({ input: 1000, output: 100 }),
    mkModelIoRecord({ startedAt: '2026-09-01T03:00:00.000Z', completedAt: '2026-09-01T03:01:00.000Z', input: 999999, output: 99999 }),
  ]);
  // subagent 专文件：当日 subagent 记录（会话级总量按定义全量采集，含 subagent）
  writeModelIo(rollout, 'model-io-sess_subagent_agent_bbbb.jsonl', [
    mkModelIoRecord({ input: 500, output: 50, cacheRead: 200, cacheWrite: 100, querySource: 'subagent', role: 'subagent' }),
  ]);
  const out = runCollectAi(work, DATE, zcodeEnv(work, rollout));
  assert.strictEqual(out.summary.session_count, 2, '主会话 + subagent 两个会话文件都计数');
  assert.strictEqual(out.summary.session_input_tokens, 1500);
  assert.strictEqual(out.summary.session_output_tokens, 150);
  assert.strictEqual(out.summary.session_cache_read_input_tokens, 200);
  assert.strictEqual(out.summary.session_cache_creation_input_tokens, 100);
  const byModel = out.summary.session_by_model['glm-5.2'];
  assert.ok(byModel, 'session_by_model["glm-5.2"] 应存在');
  assert.strictEqual(byModel.input_tokens, 1500);
  assert.strictEqual(byModel.count, 2);
  const byProject = out.summary.session_by_project.zcode;
  assert.ok(byProject, 'session_by_project.zcode 应存在');
  assert.strictEqual(byProject.count, 2);
  assert.strictEqual(byProject.input_tokens, 1500);
});

test('collect-ai zcode 会话与 Claude 会话融合采集（feature/930 融合语义，各自入桶不混淆）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-zcode-fusion-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // Claude projects fixture：当日 Claude 会话——930 融合采集下按设计计入
  // （830 时代的 zcode 跳过保护已被 930 删除，跨 backend 真实用量本就应计入日报）
  const projectsDir = path.join(work, 'claude-projects', '-work-repos-demo');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, 'sess-claude-1.jsonl'), JSON.stringify({
    timestamp: `${DATE}T03:00:00.000Z`,
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 7777, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }) + '\n');
  // zcode rollout fixture：一个 subagent 会话（issue #277 的采集源）
  const rollout = path.join(work, 'rollout');
  writeModelIo(rollout, 'model-io-sess_subagent_agent_cccc.jsonl', [
    mkModelIoRecord({ input: 500, output: 50, querySource: 'subagent', role: 'subagent' }),
  ]);
  const out = runCollectAi(work, DATE, {
    ...zcodeEnv(work, rollout),
    HARNESS_PROJECTS_DIR: path.join(work, 'claude-projects'),
  });
  // 两边都采：session 总量 = Claude 7777 + zcode 500
  assert.strictEqual(out.summary.session_count, 2, 'Claude 会话 + zcode model-io 会话都计数');
  assert.strictEqual(out.summary.session_input_tokens, 8277);
  // 各自入桶不混淆：zcode 数据在 'zcode' 桶（collectZcodeSessionTokens），
  // Claude fixture 目录不匹配任何 backend root → 无前缀桶 'work-repos-demo'
  const zcBucket = out.summary.session_by_project.zcode;
  assert.ok(zcBucket, 'session_by_project.zcode 应存在');
  assert.strictEqual(zcBucket.input_tokens, 500, 'zcode 桶只含 model-io 数据');
  const claudeBucket = out.summary.session_by_project['work-repos-demo'];
  assert.ok(claudeBucket, 'Claude fixture 桶应存在');
  assert.strictEqual(claudeBucket.input_tokens, 7777, 'Claude 桶只含 fixture 数据');
});

test('collect-ai zcode 自然调度（usage.jsonl）token 入 by_backend（normalizeUsageJsonlTokens）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-zcode-usage-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // record-usage zcode 时间窗聚合后的落盘形状：{input, output, cache_read, cache_creation, model}
  const usageDir = path.join(work, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(path.join(usageDir, 'usage.jsonl'), JSON.stringify({
    ts: `${DATE}T03:00:00.000Z`,
    session_id: '',
    role: 'developer', trigger: 'natural', task: '',
    backend: 'zcode',
    started_at: `${DATE}T02:00:00.000Z`,
    completed_at: `${DATE}T03:00:00.000Z`,
    duration_ms: 3600000,
    tokens: { input: 1000, output: 100, cache_read: 200, cache_creation: 50, model: 'glm-5.2' },
  }) + '\n');
  const out = runCollectAi(work, DATE, { ...zcodeEnv(work), HARNESS_USAGE_DIR: usageDir });
  assert.strictEqual(out.summary.total_dispatches, 1);
  const zc = out.summary.by_backend.zcode;
  assert.ok(zc, 'by_backend.zcode bucket 应存在');
  assert.strictEqual(zc.dispatch_count, 1);
  assert.strictEqual(zc.input_tokens, 1000);
  assert.strictEqual(zc.output_tokens, 100);
  assert.strictEqual(zc.cached_tokens, 200);
  assert.strictEqual(zc.model, 'glm-5.2');
  // 虚拟任务条目（agent-dispatch）也应出现
  assert.ok(out.tasks.some((x) => x.change_name === 'agent-dispatch'));
});
