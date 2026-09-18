import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, readJson } from '../generate/lib/common.mjs';
import { qoderJsonSettings } from '../generate/lib/settings-emit.mjs';
import { run as runQoder } from '../generate/adapters/qoder.mjs';

const manifest = readJson(join(REPO_ROOT, '.claude', 'tools', 'scripts', 'generate', 'targets.json'));
const target = manifest.targets.qoder;
assert.ok(target, 'targets.json should declare qoder');
assert.equal(target.rootDir, '.qoder');
assert.equal(target.env.HARNESS_BACKEND, 'qoder');

const settings = qoderJsonSettings({ env: target.env });
assert.equal(settings.general.defaultPermissionMode, 'auto');
assert.ok(Array.isArray(settings.permissions.allow));
assert.ok(Array.isArray(settings.permissions.deny));
assert.ok(settings.hooks.SessionStart[0].matcher.includes('startup'));
assert.ok(!settings.hooks.SessionStart[0].matcher.includes('clear'));
assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('HARNESS_BACKEND=qoder'));
assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('HARNESS_ROOT=.qoder'));
assert.equal(settings.env, undefined, 'Qoder project settings should only use documented keys');
const blockingHooks = settings.hooks.PreToolUse
  .flatMap((entry) => entry.hooks)
  .filter((hook) => /pre-tool-use-(git-guard|tasks-guard|memory-route-guard)|pre-commit-state-check/.test(hook.command));
assert.ok(blockingHooks.length >= 4);
for (const hook of blockingHooks) {
  assert.ok(hook.command.includes('HOOK_DENY_EXIT=2'));
  assert.ok(!hook.command.trim().endsWith('|| true'), 'blocking Qoder hooks must preserve exit code 2');
}

const result = runQoder(target);
assert.equal(result.config, '.qoder/settings.json');
assert.ok(existsSync(join(REPO_ROOT, '.qoder', 'settings.json')));
assert.ok(existsSync(join(REPO_ROOT, '.qoder', 'rules', 'ai-git-commit-spec.md')));
assert.ok(existsSync(join(REPO_ROOT, '.qoder', 'skills', 'rd-auto', 'SKILL.md')));
assert.ok(existsSync(join(REPO_ROOT, '.qoder', 'agents', 'developer.md')));
assert.ok(existsSync(join(REPO_ROOT, '.qoder', 'backends', 'qoder-backend.js')));

const generatedSkill = readFileSync(join(REPO_ROOT, '.qoder', 'skills', 'rd-auto', 'SKILL.md'), 'utf8');
assert.ok(generatedSkill.includes('${HARNESS_ROOT:-.qoder}'));
assert.ok(!generatedSkill.includes('${HARNESS_ROOT:-.claude}'));
const generatedRules = readFileSync(join(REPO_ROOT, '.qoder', 'rules', '00-uni-auri.md'), 'utf8');
assert.ok(generatedRules.includes('.qoder/reference/harness-rules.yaml'));
assert.ok(!generatedRules.includes('$HARNESS_ROOT/'));
const generatedConstants = readFileSync(join(REPO_ROOT, '.qoder', 'skills', 'rd-auto', 'scripts', 'lib', 'constants.js'), 'utf8');
assert.ok(generatedConstants.includes("process.env.HARNESS_ROOT || '.qoder'"));
assert.ok(!generatedConstants.includes("process.env.HARNESS_ROOT || '.claude'"));

console.log('test_qoder_generator: all tests passed');
