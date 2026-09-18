import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DshBackend } from '../../../backends/dsh-backend.js';
import {
  createBackend,
  detectBackend,
  getRegisteredBackends,
} from '../../../backends/backend-factory.js';

const backend = new DshBackend();
assert.equal(backend.type, 'dsh');
assert.equal(backend.name, 'DeepSeek Harness');
assert.equal(createBackend('dsh').type, 'dsh');
assert.ok(getRegisteredBackends().includes('dsh'));

// ─── detect / session / data dir ───
const originalHarnessBackend = process.env.HARNESS_BACKEND;
const originalDshSession = process.env.DSH_SESSION_ID;
const originalDshHome = process.env.DSH_HOME;
try {
  delete process.env.DSH_SESSION_ID; // 测试可能在真实 DSH 会话内运行，先清空
  delete process.env.DSH_HOME;
  delete process.env.HARNESS_BACKEND;
  assert.equal(backend.detect(), false, 'detect() false without DSH env');
  process.env.DSH_SESSION_ID = 'session-dsh-test';
  assert.equal(backend.detect(), true);
  assert.equal(backend.getSessionId(), 'session-dsh-test');
  assert.equal(detectBackend().type, 'dsh', 'DSH_SESSION_ID should outrank other signals');
  process.env.DSH_HOME = '/tmp/fake-dsh-home';
  assert.equal(backend.getDataDir(), '/tmp/fake-dsh-home');
  delete process.env.DSH_HOME;
  assert.equal(backend.getDataDir().endsWith(join('.dsh')), true, 'default data dir ~/.dsh');
} finally {
  if (originalHarnessBackend == null) delete process.env.HARNESS_BACKEND;
  else process.env.HARNESS_BACKEND = originalHarnessBackend;
  if (originalDshSession == null) delete process.env.DSH_SESSION_ID;
  else process.env.DSH_SESSION_ID = originalDshSession;
  if (originalDshHome == null) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalDshHome;
}

// ─── dispatch stays in main session (PENDING), like Claude/ZCode ───
const dispatched = await backend.dispatchSubAgent('developer', 'implement feature X', { cwd: '/repo' });
assert.equal(dispatched.exitStatus, 'PENDING');
assert.equal(dispatched.role, 'developer');
assert.equal(dispatched.prompt, 'implement feature X');

// ─── transcript path from env ───
const originalTranscript = process.env.DSH_SESSION_JSONL;
try {
  process.env.DSH_SESSION_JSONL = '/tmp/session.jsonl.zstd';
  assert.equal(backend.getTranscriptPath(), '/tmp/session.jsonl.zstd');
} finally {
  if (originalTranscript == null) delete process.env.DSH_SESSION_JSONL;
  else process.env.DSH_SESSION_JSONL = originalTranscript;
}

// ─── extractTokenUsage: plain jsonl fixture ───
const dir = mkdtempSync(join(tmpdir(), 'dsh-backend-test-'));
try {
  const jsonlPath = join(dir, 'transcript.jsonl');
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, reasoningTokens: 50 };
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: 's1' }),
    JSON.stringify({ type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', model: 'deepseek-chat', usage } } }),
    // same step chunk usage must be deduplicated (message wins)
    JSON.stringify({ type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 99999, outputTokens: 99999 } } } }),
    JSON.stringify({ type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 50 } } } }),
    JSON.stringify({ type: 'finish', seq: 4, data: {} }),
  ].join('\n');
  writeFileSync(jsonlPath, lines);

  const result = backend.extractTokenUsage(jsonlPath);
  assert.ok(result, 'usage should be extracted from plain jsonl');
  assert.equal(result.input_tokens, 1500, 'input tokens = 1000 + 500 (chunk of same step deduped)');
  assert.equal(result.output_tokens, 300, 'output tokens = 200 + 100');
  assert.equal(result.cache_read_input_tokens, 350, 'cache read = 300 + 50');
  assert.equal(result.reasoning_tokens, 50);
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-chat');

  // zstd-compressed transcript (real DSH format: .jsonl.zstd)
  const zstdPath = join(dir, 'transcript.jsonl.zstd');
  try {
    execFileSync('zstd', ['-q', '-f', jsonlPath, '-o', zstdPath]);
    const fromZstd = backend.extractTokenUsage(zstdPath);
    assert.deepEqual(fromZstd, result, 'zstd-compressed transcript parses identically');
  } catch {
    console.log('zstd CLI unavailable, skipping compressed transcript test');
  }

  // no usage → null; missing file → null
  const emptyPath = join(dir, 'empty.jsonl');
  writeFileSync(emptyPath, JSON.stringify({ type: 'session', id: 's2' }) + '\n');
  assert.equal(backend.extractTokenUsage(emptyPath), null);
  assert.equal(backend.extractTokenUsage(join(dir, 'nope.jsonl')), null);
  assert.equal(backend.extractTokenUsage(null), null);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('test_dsh_backend: all tests passed');
