'use strict';

// collect-ai-backend-detect.test.js — backend 目录探测修复测试
//
//   1. qoder 数据目录在 ~/.qoder-cn（配置 root 是 ~/.qoder）：backendDataDir 特判映射，
//      HARNESS_BACKEND=qoder 显式路径与 client 信号路径都必须命中 .qoder-cn
//   2. detectClient 增加 codebuddy 识别（CODEBUDDY_SESSION_ID/PROJECT_DIR）：
//      client 信号优先于存在性 fallback，且先于 claude-code 分支（CodeBuddy 兼容
//      Claude Code，可能同时带 CLAUDE_* 变量）

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COLLECT_AI = path.join(__dirname, '..', 'collect-ai.js');
const DATE = '2026-09-03';

// 干净 env：清掉宿主会话(本测试进程跑在 Claude Code 内)与真实用户目录的所有信号，
// 再合并 extra（extra 须在清理之后注入，否则被上面的清理列表删掉）
function baseEnv(work, extra = {}) {
  const env = { ...process.env, HOME: work };
  for (const k of [
    'HARNESS_PROJECTS_DIR', 'HARNESS_USAGE_DIR', 'HARNESS_BACKEND',
    'CLAUDECODE', 'CLAUDE_CODE_VERSION',
    'CODEX', 'CODEX_HOME', 'CODEX_VERSION',
    'QODER_PROJECT_DIR', 'QODER_SESSION_ID', 'QODER_VERSION',
    'ZCODE_PLUGIN_DATA', 'ZCODE_PLUGIN_ROOT',
    'CODEBUDDY_SESSION_ID', 'CODEBUDDY_PROJECT_DIR', 'CODEBUDDY_VERSION',
  ]) delete env[k];
  return { ...env, ...extra };
}

function runCollectAi(work, env) {
  return JSON.parse(execFileSync(process.execPath, [COLLECT_AI, '--date', DATE, '--cwd', work], {
    encoding: 'utf-8', env,
  }));
}

// 造 Claude 兼容布局的 session transcript：projects/<projDir>/<file>.jsonl
function writeSession(homeRoot, projDir, usage) {
  const dir = path.join(homeRoot, projDir);
  fs.mkdirSync(dir, { recursive: true });
  const line = {
    timestamp: `${DATE}T01:00:00.000Z`,
    message: { model: 'test-model', usage },
  };
  fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), JSON.stringify(line) + '\n');
}

test('qoder client 信号路径：session 从 ~/.qoder-cn/projects 采集', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-be-qoder-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  writeSession(path.join(work, '.qoder-cn', 'projects'), 'qoder-proj',
    { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 });

  const out = runCollectAi(work, baseEnv(work, { QODER_PROJECT_DIR: work }));
  // 融合采集：非 claude backend 桶名带 "<backend>:" 前缀
  const proj = out.summary.session_by_project['qoder:qoder-proj'];
  assert.ok(proj, '应从 ~/.qoder-cn/projects 采到会话');
  assert.strictEqual(out.summary.session_count, 1);
  assert.strictEqual(proj.input_tokens, 1000);
});

test('qoder HARNESS_BACKEND 显式路径：同样命中 ~/.qoder-cn', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-be-qoder-be-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  writeSession(path.join(work, '.qoder-cn', 'projects'), 'qoder-be-proj',
    { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

  // 无 QODER_* client 信号，仅 HARNESS_BACKEND 显式指定
  const out = runCollectAi(work, baseEnv(work, { HARNESS_BACKEND: 'qoder' }));
  assert.ok(out.summary.session_by_project['qoder:qoder-be-proj'],
    'HARNESS_BACKEND=qoder 应解析到 ~/.qoder-cn/projects');
});

test('多 backend 融合：混用 codebuddy + qoder 时两个目录都采，桶名带 backend 前缀', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-be-cb-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 混用场景：codebuddy 与 qoder-cn 的 projects 各有当日会话（同名项目目录）
  writeSession(path.join(work, '.codebuddy', 'projects'), 'cb-proj',
    { input_tokens: 2000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 });
  writeSession(path.join(work, '.qoder-cn', 'projects'), 'qoder-proj',
    { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

  // CLAUDECODE=1 同时存在（CodeBuddy 兼容 Claude Code 场景）；
  // 融合语义下 client 信号不再决定"只采哪个目录"，两个 backend 都采
  const out = runCollectAi(work, baseEnv(work, {
    CODEBUDDY_SESSION_ID: 'sess-cb',
    CLAUDECODE: '1',
  }));

  const projects = out.summary.session_by_project;
  assert.ok(projects['codebuddy:cb-proj'], 'codebuddy 目录应被采集');
  assert.ok(projects['qoder:qoder-proj'], 'qoder-cn 目录应被采集（融合补采）');
  assert.strictEqual(projects['codebuddy:cb-proj'].input_tokens, 2000);
  assert.strictEqual(projects['qoder:qoder-proj'].input_tokens, 1000);
  assert.strictEqual(out.summary.session_count, 2);
  assert.strictEqual(out.summary.session_input_tokens, 3000);
});

test('去重语义：同 backend 内 session 镜像去重，跨 backend 同名各自计', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-be-dedup-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  const line = JSON.stringify({
    timestamp: `${DATE}T01:00:00.000Z`,
    message: { model: 'test-model', usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n';
  // 同 backend（claude）两个 project 目录下的同名 session 文件（镜像场景）→ 只计一次
  for (const proj of ['proj-a', 'proj-b']) {
    const dir = path.join(work, '.claude', 'projects', proj);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-dup.jsonl'), line);
  }
  // 不同 backend（codebuddy）下的同名文件是独立会话 → 各自计
  const cbDir = path.join(work, '.codebuddy', 'projects', 'proj-c');
  fs.mkdirSync(cbDir, { recursive: true });
  fs.writeFileSync(path.join(cbDir, 'sess-dup.jsonl'), line);

  const out = runCollectAi(work, baseEnv(work));
  assert.strictEqual(out.summary.session_count, 2, 'claude 镜像去重后 1 + codebuddy 独立 1');
  assert.strictEqual(out.summary.session_input_tokens, 1000);
});
