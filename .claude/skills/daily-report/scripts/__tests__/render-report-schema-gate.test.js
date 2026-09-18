'use strict';

// Issue !278 回归：concern_stats 新增 missing_author_skipped 后漏改 schema，
// render-report 的 schema 门禁在真实日报场景必然失败（additionalProperties: false）。
//
// 本文件守两件事：
//   1) 漂移守卫——collect-ai 实际发射的 summary / concern_stats 键，schema 必须全部声明
//   2) 端到端门禁——缺 author 的 concerns 场景下 render-report 必须退出 0 并在 MD 明示

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..');
const COLLECT_AI = path.join(SCRIPTS, 'collect-ai.js');
const RENDER_REPORT = path.join(SCRIPTS, 'render-report.js');
const SCHEMA = path.join(SCRIPTS, '..', 'schemas', 'daily-report.schema.json');

const DATE = '2026-08-11';

function makeWork(prefix) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return work;
}

// 构造一个 change，其 concerns.json 含 1 条有 author + 1 条缺 author，
// 使 collect-ai --user 产出 missing_author_skipped >= 1（!278 触发的真实场景）
function writeConcernsWithMissingAuthor(work) {
  const dir = path.join(work, '.harness', 'shared-state', 'author-change');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'concerns.json'), JSON.stringify({
    p0: [
      { severity: 'P0', status: 'open', author: 'tester', created_at: `${DATE}T10:00:00.000Z`, message: 'counted' },
      { severity: 'P0', status: 'open', created_at: `${DATE}T11:00:00.000Z`, message: 'missing author' },
    ],
  }));
}

// schema 里 ai/summary 都是 $ref，逐层解引用到真正的 properties 节点
function resolveRef(schema, node) {
  let cur = node;
  while (cur && cur.$ref) {
    const segs = cur.$ref.replace(/^#\//, '').split('/');
    cur = segs.reduce((acc, k) => (acc == null ? undefined : acc[k]), schema);
  }
  return cur;
}

function propsOf(schema, node) {
  const resolved = resolveRef(schema, node);
  assert.ok(resolved && resolved.properties, 'schema 节点无法解出 properties');
  return resolved.properties;
}

function runCollectAi(cwd) {
  return JSON.parse(execFileSync(
    process.execPath,
    [COLLECT_AI, '--date', DATE, '--cwd', cwd, '--user', 'tester'],
    { encoding: 'utf-8', env: { ...process.env, HOME: cwd } },
  ));
}

test('schema 漂移守卫：collect-ai 发射的 summary / concern_stats 键必须全部在 schema 中声明', (t) => {
  const work = makeWork('rrs-drift-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  writeConcernsWithMissingAuthor(work);

  const ai = runCollectAi(work);
  const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf-8'));

  const summaryProps = propsOf(schema, propsOf(schema, schema.properties.ai).summary);
  const undeclaredSummary = Object.keys(ai.summary).filter((k) => !(k in summaryProps));
  assert.deepStrictEqual(
    undeclaredSummary, [],
    `collect-ai 发射了 schema 未声明的 summary 键（additionalProperties:false 会让 render-report 直接失败）: ${undeclaredSummary.join(', ')}`,
  );

  const concernProps = propsOf(schema, summaryProps.concern_stats);
  const undeclaredConcern = Object.keys(ai.summary.concern_stats).filter((k) => !(k in concernProps));
  assert.deepStrictEqual(
    undeclaredConcern, [],
    `collect-ai 发射了 schema 未声明的 concern_stats 键: ${undeclaredConcern.join(', ')}`,
  );
});

test('端到端门禁：缺 author concerns 场景 render-report 通过 schema 校验并在 MD 明示未计入条数（issue !278）', (t) => {
  const work = makeWork('rrs-gate-');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  writeConcernsWithMissingAuthor(work);

  const ai = runCollectAi(work);
  // 夹具自检：确保确实走到了 !278 的新分支，否则本测试是空转
  assert.ok(
    ai.summary.concern_stats.missing_author_skipped >= 1,
    `夹具未产生 missing_author_skipped，测试空转（实际 ${ai.summary.concern_stats.missing_author_skipped}）`,
  );

  const aiPath = path.join(work, 'ai.json');
  const tasksPath = path.join(work, 'tasks.json');
  const mdPath = path.join(work, 'out.md');
  const jsonPath = path.join(work, 'out.json');
  fs.writeFileSync(aiPath, JSON.stringify(ai));
  fs.writeFileSync(tasksPath, JSON.stringify([]));

  // 退出码非 0 时 execFileSync 抛错——即 !278 原缺陷的表现
  execFileSync(process.execPath, [
    RENDER_REPORT,
    '--date', DATE,
    '--user', 'tester',
    '--repo', 'taskboard',
    '--branch', 'dev',
    '--tasks', `@${tasksPath}`,
    '--ai', `@${aiPath}`,
    '--output', mdPath,
    '--json-output', jsonPath,
  ], { encoding: 'utf-8' });

  const md = fs.readFileSync(mdPath, 'utf-8');
  assert.match(md, /未计入上表/, 'render-report 未在 MD 明示「N 条未计入」');

  const out = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  assert.strictEqual(
    out.ai.summary.concern_stats.missing_author_skipped,
    ai.summary.concern_stats.missing_author_skipped,
    'missing_author_skipped 未原样落进 jsonData',
  );
});
