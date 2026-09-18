// test_extract_subagent_token_usage.mjs — Unit tests for extractSubagentTokenUsage
//
// Issue !193: Claude backend pipeline dispatch 的子 agent token 落在
// projects/<slug>/<sessionId>/subagents/agent-*.jsonl，主会话 transcript 拿不到。
// extractSubagentTokenUsage 扫描该目录，累加 mtime ≥ startedAt 的子 agent transcript usage。
//
// Reviewer P1 约束覆盖：
//   - 多 transcript 累加
//   - 旧文件被 mtime 排除
//   - LongCat 空 {} usage 容错
//   - 目录不存在 return null（CodeBuddy 未验证结构）
//   - 主会话路径推导正确
//
// Run: node .claude/tools/scripts/tests/test_extract_subagent_token_usage.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSubagentTokenUsage } from '../../../skills/rd-auto/scripts/lib/cli-commands.js';

const tests = [];

// === 1. 正常累加多个子 agent transcript ===
tests.push(function testMultipleSubagentsAggregate() {
  const root = mkdtempSync(join(tmpdir(), 'test-subagent-1-'));
  const sessionId = 'sess-aaa';
  const projectDir = join(root, 'myproject');
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);  // 主会话 transcript
  const subagentsDir = join(projectDir, sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  // 主会话 transcript 存在即可（内容不影响 subagent 扫描）
  writeFileSync(sessionFile, '{"message":{"usage":{"input_tokens":0}}}\n');

  // subagent 1
  writeFileSync(join(subagentsDir, 'agent-111.jsonl'),
    JSON.stringify({message: {model: 'glm-5.2', usage: {input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200}}}) + '\n'
    + JSON.stringify({message: {model: 'glm-5.2', usage: {input_tokens: 80, output_tokens: 30, cache_read_input_tokens: 150}}}) + '\n'
  );
  // subagent 2
  writeFileSync(join(subagentsDir, 'agent-222.jsonl'),
    JSON.stringify({message: {model: 'glm-5.2', usage: {input_tokens: 500, output_tokens: 200}}}) + '\n'
  );

  const r = extractSubagentTokenUsage(sessionFile, null);
  assert.equal(r.input_tokens, 680);   // 100 + 80 + 500
  assert.equal(r.output_tokens, 280);  // 50 + 30 + 200
  assert.equal(r.cache_read_input_tokens, 350);  // 200 + 150
  assert.equal(r.model, 'glm-5.2');
  rmSync(root, { recursive: true, force: true });
});

// === 2. mtime 过滤排除旧文件 ===
tests.push(function testMtimeExcludesOldFiles() {
  const root = mkdtempSync(join(tmpdir(), 'test-subagent-2-'));
  const sessionId = 'sess-bbb';
  const projectDir = join(root, 'myproject');
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  const subagentsDir = join(projectDir, sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(sessionFile, '{}\n');

  // 旧 subagent（mtime 设为 1 小时前）
  const oldFile = join(subagentsDir, 'agent-old.jsonl');
  writeFileSync(oldFile,
    JSON.stringify({message: {model: 'glm-5.2', usage: {input_tokens: 999, output_tokens: 999}}}) + '\n'
  );
  const oneHourAgo = new Date(Date.now() - 3600 * 1000);
  utimesSync(oldFile, oneHourAgo, oneHourAgo);

  // 新 subagent（mtime 是当前）
  writeFileSync(join(subagentsDir, 'agent-new.jsonl'),
    JSON.stringify({message: {model: 'glm-5.2', usage: {input_tokens: 100, output_tokens: 50}}}) + '\n'
  );

  const startedAt = new Date(Date.now() - 60 * 1000).toISOString();  // 1 分钟前
  const r = extractSubagentTokenUsage(sessionFile, startedAt);
  assert.equal(r.input_tokens, 100);  // 只算新文件，旧 999 被排除
  assert.equal(r.output_tokens, 50);
  rmSync(root, { recursive: true, force: true });
});

// === 3. LongCat 空 usage 容错 ===
tests.push(function testEmptyUsageTolerance() {
  const root = mkdtempSync(join(tmpdir(), 'test-subagent-3-'));
  const sessionId = 'sess-ccc';
  const projectDir = join(root, 'myproject');
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  const subagentsDir = join(projectDir, sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(sessionFile, '{}\n');

  // usage 是空 {}（LongCat 样本）
  writeFileSync(join(subagentsDir, 'agent-longcat.jsonl'),
    JSON.stringify({message: {model: 'LongCat-2.0', usage: {}}}) + '\n'
  );

  const r = extractSubagentTokenUsage(sessionFile, null);
  assert.equal(r, null);  // 全 0 → return null
  rmSync(root, { recursive: true, force: true });
});

// === 4. 目录不存在 return null（CodeBuddy 未验证） ===
tests.push(function testSubagentsDirMissing() {
  const root = mkdtempSync(join(tmpdir(), 'test-subagent-4-'));
  const sessionId = 'sess-ddd';
  const projectDir = join(root, 'myproject');
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(sessionFile, '{}\n');
  // 不创建 subagents 目录

  const r = extractSubagentTokenUsage(sessionFile, null);
  assert.equal(r, null);  // existsSync 守卫生效
  rmSync(root, { recursive: true, force: true });
});

// === 5. 主会话路径为 null/不存在 ===
tests.push(function testMainPathNull() {
  assert.equal(extractSubagentTokenUsage(null, null), null);
  assert.equal(extractSubagentTokenUsage('', null), null);
  assert.equal(extractSubagentTokenUsage('/nonexistent/path/file.jsonl', null), null);
});

// === 6. 混合模型 dominant model 选择 ===
tests.push(function testDominantModel() {
  const root = mkdtempSync(join(tmpdir(), 'test-subagent-6-'));
  const sessionId = 'sess-eee';
  const projectDir = join(root, 'myproject');
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  const subagentsDir = join(projectDir, sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(sessionFile, '{}\n');

  // glm-5.2 总 token 600，deepseek-v4-pro 总 token 1000
  writeFileSync(join(subagentsDir, 'agent-glm.jsonl'),
    JSON.stringify({message: {model: 'glm-5.2', usage: {input_tokens: 600, output_tokens: 0}}}) + '\n'
  );
  writeFileSync(join(subagentsDir, 'agent-deepseek.jsonl'),
    JSON.stringify({message: {model: 'deepseek-v4-pro', usage: {input_tokens: 1000, output_tokens: 0}}}) + '\n'
  );

  const r = extractSubagentTokenUsage(sessionFile, null);
  assert.equal(r.model, 'deepseek-v4-pro');  // 总 token 高者胜出
  rmSync(root, { recursive: true, force: true });
});

// === 7. malformed JSON 行跳过 ===
tests.push(function testMalformedJsonSkipped() {
  const root = mkdtempSync(join(tmpdir(), 'test-subagent-7-'));
  const sessionId = 'sess-fff';
  const projectDir = join(root, 'myproject');
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  const subagentsDir = join(projectDir, sessionId, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(sessionFile, '{}\n');

  writeFileSync(join(subagentsDir, 'agent-mixed.jsonl'),
    'this is not json\n'
    + JSON.stringify({message: {model: 'glm-5.2', usage: {input_tokens: 100, output_tokens: 50}}}) + '\n'
    + '{ broken json\n'
    + ''
  );

  const r = extractSubagentTokenUsage(sessionFile, null);
  assert.equal(r.input_tokens, 100);  // malformed 行跳过，合法行累加
  assert.equal(r.output_tokens, 50);
  rmSync(root, { recursive: true, force: true });
});

// === Run all ===
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`# PASS: ${t.name}`);
    passed++;
  } catch (e) {
    console.log(`# FAIL: ${t.name} — ${e.message}`);
    failed++;
  }
}
console.log(`${passed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
