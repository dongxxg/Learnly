import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  QoderBackend,
  buildQoderArgs,
  parseQoderOutput,
} from '../../../backends/qoder-backend.js';
import {
  createBackend,
  detectBackend,
  getRegisteredBackends,
} from '../../../backends/backend-factory.js';

const backend = new QoderBackend({ command: 'qoderclicn-test' });
assert.equal(backend.type, 'qoder');
assert.equal(backend.name, 'Qoder CN CLI');
assert.equal(backend.command, 'qoderclicn-test');

assert.equal(createBackend('qoder').type, 'qoder');
assert.ok(getRegisteredBackends().includes('qoder'));

const originalHarnessBackend = process.env.HARNESS_BACKEND;
const originalQoderProjectDir = process.env.QODER_PROJECT_DIR;
const originalClaudeSessionId = process.env.CLAUDE_CODE_SESSION_ID;
try {
  process.env.HARNESS_BACKEND = 'codex';
  process.env.QODER_PROJECT_DIR = '/repo/qoder';
  assert.equal(detectBackend().type, 'codex', 'explicit backend must outrank Qoder project signals');
  delete process.env.HARNESS_BACKEND;
  process.env.CLAUDE_CODE_SESSION_ID = 'stale-parent-session';
  assert.equal(detectBackend().type, 'qoder', 'QODER_PROJECT_DIR should outrank stale session signals');
} finally {
  if (originalHarnessBackend == null) delete process.env.HARNESS_BACKEND;
  else process.env.HARNESS_BACKEND = originalHarnessBackend;
  if (originalQoderProjectDir == null) delete process.env.QODER_PROJECT_DIR;
  else process.env.QODER_PROJECT_DIR = originalQoderProjectDir;
  if (originalClaudeSessionId == null) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = originalClaudeSessionId;
}

const args = buildQoderArgs('Developer', 'implement feature X', {
  cwd: '/repo/worktree',
  maxTurns: 12,
});
assert.deepEqual(args, [
  '--agent', 'Developer',
  '--print',
  '--output-format', 'json',
  '--permission-mode', 'auto',
  '--max-turns', '12',
  '-w', '/repo/worktree',
  'implement feature X',
]);

const readOnlyArgs = buildQoderArgs('reviewer', 'review feature X', {
  cwd: '/repo/worktree',
  contextMode: 'read_only',
});
assert.equal(readOnlyArgs[1], 'Reviewer');
assert.equal(readOnlyArgs[readOnlyArgs.indexOf('--permission-mode') + 1], 'plan');

const parsed = parseQoderOutput(JSON.stringify({
  type: 'result',
  session_id: 'qoder-session-1',
  result: JSON.stringify({
    exit_status: 'DONE',
    summary: 'implemented',
    artifacts: ['src/main.js'],
  }),
  usage: {
    total_tokens: 160,
  },
}));
assert.equal(parsed.exitStatus, 'DONE');
assert.equal(parsed.summary, 'implemented');
assert.deepEqual(parsed.artifacts, ['src/main.js']);
assert.equal(parsed.session_id, 'qoder-session-1');
assert.equal(parsed.tokens_used, 160);

const jsonl = [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
  JSON.stringify({
    type: 'result',
    result: '{"exit_status":"DONE_WITH_CONCERNS","summary":"reviewed"}',
    usage: { total: 25 },
  }),
].join('\n');
const parsedJsonl = parseQoderOutput(jsonl);
assert.equal(parsedJsonl.exitStatus, 'DONE_WITH_CONCERNS');
assert.equal(parsedJsonl.summary, 'reviewed');
assert.equal(parsedJsonl.tokens_used, 25);

const plain = parseQoderOutput('analysis complete\n```json\n{"exit_status":"DONE","summary":"ok"}\n```');
assert.equal(plain.exitStatus, 'DONE');
assert.equal(plain.summary, 'ok');

const unparseable = parseQoderOutput('{"type":"result","result":"plain text only"}');
assert.equal(unparseable.exitStatus, 'BLOCKED');
assert.equal(unparseable.error.type, 'unparseable');

const fakeCli = fileURLToPath(new URL('./fakes/qoderclicn.mjs', import.meta.url));
const fakeBackend = new QoderBackend({ command: process.execPath, commandArgs: [fakeCli] });
assert.equal(fakeBackend.detect(), true);
const dispatched = await fakeBackend.dispatchSubAgent('developer', 'implement through fake CLI', {
  cwd: process.cwd(),
  contextMode: 'read_only',
  maxTurns: 3,
  retry: false,
});
assert.equal(dispatched.exitStatus, 'DONE');
assert.equal(dispatched.tokens_used, 42);
assert.deepEqual(dispatched.artifacts, ['fake-artifact.txt']);
assert.ok(dispatched.summary.includes('--agent|Developer'));
assert.ok(dispatched.summary.includes('--permission-mode|plan'));
assert.ok(dispatched.summary.includes('implement through fake CLI'));

const originalFakeDelay = process.env.QODER_FAKE_DELAY_MS;
try {
  process.env.QODER_FAKE_DELAY_MS = '5000';
  const timedOut = await fakeBackend.dispatchSubAgent('developer', 'timeout fake CLI', {
    cwd: process.cwd(),
    timeoutMs: 25,
    retry: false,
  });
  assert.equal(timedOut.exitStatus, 'BLOCKED');
  assert.equal(timedOut.error.type, 'timeout');
} finally {
  if (originalFakeDelay == null) delete process.env.QODER_FAKE_DELAY_MS;
  else process.env.QODER_FAKE_DELAY_MS = originalFakeDelay;
}

console.log('test_qoder_backend: all tests passed');
