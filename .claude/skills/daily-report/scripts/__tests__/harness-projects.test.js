'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findHarnessProjectsFile, parseHarnessProjects, subRepoDirs } = require('../lib/harness-projects');

function makeWorkspace(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hproj-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  return work;
}

test('findHarnessProjectsFile: CWD 命中', (t) => {
  const work = makeWorkspace(t);
  fs.writeFileSync(path.join(work, '.harness-projects'), 'a\n');
  assert.strictEqual(findHarnessProjectsFile(work), path.join(work, '.harness-projects'));
});

test('findHarnessProjectsFile: 祖先链命中', (t) => {
  const work = makeWorkspace(t);
  fs.mkdirSync(path.join(work, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(work, '.harness-projects'), 'a\n');
  const deep = path.join(work, 'sub', 'deep');
  assert.strictEqual(findHarnessProjectsFile(deep), path.join(work, '.harness-projects'));
});

test('findHarnessProjectsFile: env 绝对路径覆盖（不拼进 cwd）', (t) => {
  const work = makeWorkspace(t);
  const envFile = path.join(work, 'custom.list');
  fs.writeFileSync(envFile, 'a\n');
  process.env.HARNESS_PROJECTS_FILE = envFile;
  t.after(() => { delete process.env.HARNESS_PROJECTS_FILE; });
  // env 为绝对路径时，即使 cwd 下无文件也应命中 envFile，而非 cwd/envFile
  assert.strictEqual(findHarnessProjectsFile(path.join(work, 'elsewhere')), envFile);
});

test('parseHarnessProjects: .harness 子仓识别 + .claude 旧布局兜底 + 无标记排除', (t) => {
  const work = makeWorkspace(t);
  fs.mkdirSync(path.join(work, 's1', '.harness'), { recursive: true });
  fs.mkdirSync(path.join(work, 's2', '.claude'), { recursive: true });
  fs.mkdirSync(path.join(work, 's3'), { recursive: true });
  fs.writeFileSync(path.join(work, '.harness-projects'), 's1\ns2\ns3\n');
  const projs = parseHarnessProjects(path.join(work, '.harness-projects'));
  const byRel = Object.fromEntries(projs.map((p) => [p.relative, p.has_harness]));
  assert.strictEqual(byRel.s1, true);
  assert.strictEqual(byRel.s2, true);
  assert.strictEqual(byRel.s3, false);
});

test('parseHarnessProjects: HARNESS_ROOT=.claude 时 .harness 子仓仍识别（issue !239 关键场景）', (t) => {
  const work = makeWorkspace(t);
  fs.mkdirSync(path.join(work, 's1', '.harness'), { recursive: true });
  fs.writeFileSync(path.join(work, '.harness-projects'), 's1\n');
  process.env.HARNESS_ROOT = '.claude';
  t.after(() => { delete process.env.HARNESS_ROOT; });
  const projs = parseHarnessProjects(path.join(work, '.harness-projects'));
  assert.strictEqual(projs[0].has_harness, true);
});

test('subRepoDirs: 只返回存在且含 harness 标记的子仓', (t) => {
  const work = makeWorkspace(t);
  fs.mkdirSync(path.join(work, 'ok', '.harness'), { recursive: true });
  fs.mkdirSync(path.join(work, 'no-harness'), { recursive: true });
  fs.writeFileSync(path.join(work, '.harness-projects'), 'ok\nno-harness\nmissing\n');
  const dirs = subRepoDirs(work);
  assert.deepStrictEqual(dirs, [path.join(work, 'ok')]);
});
