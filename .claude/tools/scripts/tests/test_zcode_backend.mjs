import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZcodeBackend } from '../../../backends/zcode-backend.js';
import {
  createBackend,
  detectBackend,
  getRegisteredBackends,
} from '../../../backends/backend-factory.js';
import { normalizeSkillInvocation } from '../../../skills/rd-auto/scripts/lib/backend.js';

const backend = new ZcodeBackend();
assert.equal(backend.type, 'zcode');
assert.equal(backend.name, 'ZCode');
assert.equal(backend.version, 'unknown');
assert.equal(backend.getSessionId(), null, 'ZCode documents no stable session environment variable');
const originalZcodePluginData = process.env.ZCODE_PLUGIN_DATA;
try {
  delete process.env.ZCODE_PLUGIN_DATA;
  assert.equal(backend.getDataDir(), join(homedir(), '.zcode', 'uni-auri'));
  process.env.ZCODE_PLUGIN_DATA = join(homedir(), 'zcode-plugin-data-test');
  assert.equal(backend.getDataDir(), process.env.ZCODE_PLUGIN_DATA);
} finally {
  if (originalZcodePluginData == null) delete process.env.ZCODE_PLUGIN_DATA;
  else process.env.ZCODE_PLUGIN_DATA = originalZcodePluginData;
}
assert.equal(backend.getTranscriptPath(), null, 'ZCode documents only temporary hook transcripts');
assert.equal(backend.extractTokenUsage('/tmp/not-used.jsonl', 0), null);

const pending = await backend.dispatchSubAgent('Developer', 'implement feature X', { contextMode: 'full' });
assert.equal(pending.exitStatus, 'PENDING');
assert.equal(pending.role, 'Developer');
assert.equal(pending.prompt, 'implement feature X');
assert.match(pending.message, /Agent tool/i);

assert.equal(createBackend('zcode').type, 'zcode');
assert.ok(getRegisteredBackends().includes('zcode'));
assert.equal(normalizeSkillInvocation('/rd:explore', 'zcode'), 'rd:explore');
assert.equal(normalizeSkillInvocation('/rd:apply', 'claude'), '/rd:apply');
assert.equal(normalizeSkillInvocation(null, 'zcode'), null);

const originalHarnessBackend = process.env.HARNESS_BACKEND;
const originalQoderProjectDir = process.env.QODER_PROJECT_DIR;
try {
  process.env.HARNESS_BACKEND = 'zcode';
  process.env.QODER_PROJECT_DIR = '/repo/qoder';
  assert.equal(detectBackend().type, 'zcode', 'explicit ZCode backend must outrank other client signals');
} finally {
  if (originalHarnessBackend == null) delete process.env.HARNESS_BACKEND;
  else process.env.HARNESS_BACKEND = originalHarnessBackend;
  if (originalQoderProjectDir == null) delete process.env.QODER_PROJECT_DIR;
  else process.env.QODER_PROJECT_DIR = originalQoderProjectDir;
}

const dispatchSource = readFileSync(new URL('../../../skills/rd-auto/scripts/dispatch-agent.js', import.meta.url), 'utf8');
const fanoutSource = readFileSync(new URL('../../../skills/rd-auto/scripts/fanout-dispatch-agent.js', import.meta.url), 'utf8');
assert.match(dispatchSource, /backendType === 'zcode'/);
assert.match(fanoutSource, /backendType === 'zcode'/);
assert.doesNotMatch(dispatchSource, /backendType === 'codex' \|\| backendType === 'qoder' \|\| backendType === 'zcode'/,
  'ZCode has no documented headless CLI and must not use the headless branch');

const ciRunner = fileURLToPath(new URL('../ci/ci-run-agent.js', import.meta.url));
const ciResult = spawnSync(process.execPath, [ciRunner], {
  env: { ...process.env, HARNESS_BACKEND: 'zcode' },
  input: 'run CI task',
  encoding: 'utf8',
});
assert.equal(ciResult.status, 2, ciResult.stderr);
assert.match(ciResult.stderr, /does not document a headless CLI/);

console.log('test_zcode_backend: all tests passed');
