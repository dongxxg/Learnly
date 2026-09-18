import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTokenUsage, recalcTokens } from '../../../skills/rd-auto/scripts/lib/stats.js';

const normalized = normalizeTokenUsage({ total: 1234, input_tokens: 20 }, 'zcode');
assert.deepEqual(normalized, {
  input: null,
  output: null,
  cached: null,
  reasoning: null,
  total: null,
  model: null,
});

const state = {
  pipeline: {
    implement: {
      dispatch_history: [
        { token_usage: { backend: 'zcode', total: 1234 } },
      ],
    },
  },
};
let warning = '';
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => { warning += String(chunk); return true; };
try {
  recalcTokens(state);
} finally {
  process.stderr.write = originalStderrWrite;
}
assert.equal(warning, '', 'ZCode must be recognized rather than grouped as unknown');
assert.equal(state.token_summary.by_backend.zcode.dispatch_count, 1);
assert.equal(state.token_summary.by_backend.zcode.total_tokens, null);
assert.equal(state.token_summary.by_backend.zcode.input_tokens, null);

const cliCommands = readFileSync(new URL('../../../skills/rd-auto/scripts/lib/cli-commands.js', import.meta.url), 'utf8');
const collectAi = readFileSync(new URL('../../../skills/daily-report/scripts/collect-ai.js', import.meta.url), 'utf8');
assert.match(cliCommands, /claude\|codex\|codebuddy\|qoder\|zcode/);
assert.match(cliCommands, /explicit === 'zcode'/);
assert.match(collectAi, /'claude', 'codex', 'codebuddy', 'qoder', 'zcode'/);

const collectAiPath = fileURLToPath(new URL('../../../skills/daily-report/scripts/collect-ai.js', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'zcode-usage-test-'));
try {
  const pluginData = join(tempRoot, 'plugin-data');
  const usageDir = join(pluginData, 'usage');
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(join(usageDir, 'usage.jsonl'), `${JSON.stringify({
    ts: '2026-08-18T01:00:00.000Z',
    role: 'developer',
    trigger: 'natural',
    backend: 'zcode',
    duration_ms: 321,
    tokens: null,
  })}\n`);

  const env = {
    ...process.env,
    HARNESS_BACKEND: 'zcode',
    ZCODE_PLUGIN_DATA: pluginData,
  };
  delete env.HARNESS_USAGE_DIR;
  const output = execFileSync(process.execPath, [collectAiPath, '--date', '2026-08-18', '--cwd', tempRoot], {
    encoding: 'utf8',
    env,
  });
  const report = JSON.parse(output);
  assert.equal(report.summary.total_dispatches, 1);
  assert.equal(report.summary.sampled_gap_count, 1);
  assert.equal(report.summary.by_backend.zcode.dispatch_count, 1);
  assert.equal(report.summary.by_backend.zcode.total_tokens, null);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('test_zcode_usage: all tests passed');
