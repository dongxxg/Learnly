import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normalizeTokenUsage } from '../../../skills/rd-auto/scripts/lib/stats.js';

const normalized = normalizeTokenUsage({ total: 321 }, 'qoder');
assert.deepEqual(normalized, {
  input: null,
  output: null,
  cached: null,
  reasoning: null,
  total: 321,
  model: null,
});

const collectAi = readFileSync('.claude/skills/daily-report/scripts/collect-ai.js', 'utf8');
assert.ok(collectAi.includes("case 'qoder':"));
assert.ok(collectAi.includes("'.qoder'"));
assert.ok(collectAi.includes("'claude', 'codex', 'codebuddy', 'qoder'"));

const report = readFileSync('.claude/skills/daily-report/scripts/render-report.js', 'utf8');
assert.ok(report.includes('byBackend.qoder'));
assert.ok(report.includes('Qoder 后端'));

console.log('test_qoder_usage: all tests passed');
