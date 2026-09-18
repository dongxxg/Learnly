import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { REPO_ROOT, readJson } from '../generate/lib/common.mjs';
import { run as runZcode } from '../generate/adapters/zcode.mjs';
import { configureZcodePlugin } from '../setup/configure-zcode-plugin.mjs';

const manifest = readJson(join(REPO_ROOT, '.claude', 'tools', 'scripts', 'generate', 'targets.json'));
const target = manifest.targets.zcode;
assert.ok(target, 'targets.json should declare zcode');
assert.equal(target.rootDir, '.zcode');
assert.equal(target.env.HARNESS_BACKEND, 'zcode');
assert.equal(target.hookFormat, 'zcode-plugin');

const result = runZcode(target);
assert.equal(result.plugin, '.zcode/.zcode-plugin/plugin.json');
assert.equal(result.marketplace, '.zcode/marketplace.json');

const pluginFile = join(REPO_ROOT, result.plugin);
const marketplaceFile = join(REPO_ROOT, result.marketplace);
const hooksFile = join(REPO_ROOT, '.zcode', 'hooks', 'hooks.json');
const wrapperFile = join(REPO_ROOT, '.zcode', 'hooks', 'zcode', 'run-hook.mjs');
assert.ok(existsSync(pluginFile));
assert.ok(existsSync(marketplaceFile));
assert.ok(existsSync(hooksFile));
assert.ok(existsSync(wrapperFile));
assert.match(readFileSync(wrapperFile, 'utf8'), /process\.env\.ZCODE_PLUGIN_DATA/);
assert.ok(existsSync(join(REPO_ROOT, '.zcode', 'skills', 'rd-auto', 'SKILL.md')));
assert.ok(existsSync(join(REPO_ROOT, '.zcode', 'agents', 'developer.md')));
assert.ok(existsSync(join(REPO_ROOT, '.zcode', 'backends', 'zcode-backend.js')));
assert.ok(existsSync(join(REPO_ROOT, '.zcode', 'rules', 'ai-git-commit-spec.md')));

const plugin = readJson(pluginFile);
assert.equal(plugin.name, 'uni-auri');
assert.equal(plugin.skills, 'skills', 'ZCode plugin must declare its skills directory');
assert.equal(plugin.agents, 'agents', 'ZCode plugin must declare its agents directory');
assert.equal(plugin.hooks, undefined, 'standard hooks/hooks.json must not be redeclared');

const marketplace = readJson(marketplaceFile);
assert.equal(marketplace.name, 'uni-auri-local');
assert.equal(marketplace.plugins[0].name, 'uni-auri');
assert.equal(marketplace.plugins[0].source, '.');

const hooks = readJson(hooksFile);
for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']) {
  assert.ok(Array.isArray(hooks.hooks[event]), `missing documented ZCode hook event ${event}`);
}
for (const entries of Object.values(hooks.hooks)) {
  for (const entry of entries) {
    for (const hook of entry.hooks) {
      assert.equal(hook.type, 'process');
      assert.equal(hook.command, 'node');
      assert.ok(hook.args[0].includes('${ZCODE_PLUGIN_ROOT}/hooks/zcode/run-hook.mjs'));
      assert.ok(Number.isInteger(hook.timeoutMs));
    }
  }
}
assert.equal(existsSync(join(REPO_ROOT, '.zcode', 'config.json')), false,
  'official docs say project-level ZCode hooks are ignored');
assert.equal(existsSync(join(REPO_ROOT, '.zcode', 'settings.json')), false,
  'adapter must not invent a project settings file');

const generatedAgent = readFileSync(join(REPO_ROOT, '.zcode', 'agents', 'developer.md'), 'utf8');
assert.ok(generatedAgent.includes('.zcode/agents/extensions/tdd-protocol.md'));
assert.ok(!generatedAgent.includes('.claude/agents/extensions/tdd-protocol.md'));

const generatedRdSkill = readFileSync(join(REPO_ROOT, '.zcode', 'skills', 'rd-auto', 'SKILL.md'), 'utf8');
assert.match(generatedRdSkill, /^name: rd:auto$/m);
assert.match(generatedRdSkill, /搭建项目、开发功能、添加接口/);

const generatedPuaSkill = readFileSync(join(REPO_ROOT, '.zcode', 'skills', 'pua-debugging', 'SKILL.md'), 'utf8');
assert.match(generatedPuaSkill, /^---\r?\n[\s\S]*?\r?\n---\r?\n/,
  'generated ZCode Skill must retain valid frontmatter delimiters');
const generatedPuaDescription = generatedPuaSkill.match(/^description:\s*([\s\S]*?)\r?$/m)?.[1] || '';
assert.match(generatedPuaDescription, /task fails repeatedly/);
const canonicalPuaSkill = readFileSync(join(REPO_ROOT, '.claude', 'skills', 'pua-debugging', 'SKILL.md'), 'utf8');
assert.ok(canonicalPuaSkill.length > generatedPuaSkill.length,
  'ZCode metadata normalization must not replace the canonical Skill');

const generatedSkillsDir = join(REPO_ROOT, '.zcode', 'skills');
for (const skillName of readdirSync(generatedSkillsDir)) {
  const skillFile = join(generatedSkillsDir, skillName, 'SKILL.md');
  if (!existsSync(skillFile)) continue;
  const skill = readFileSync(skillFile, 'utf8');
  const description = skill.match(/^description:\s*([^\r\n]*)$/m)?.[1] || '';
  assert.ok(description.length <= 1024,
    `ZCode Skill description exceeds 1024 characters: ${skillName}`);
}

const generatedReadme = readFileSync(join(REPO_ROOT, '.zcode', 'README.md'), 'utf8');
assert.match(generatedReadme, /plugins\.dirs/);
assert.match(generatedReadme, /uni-auri@inline/);
assert.ok(!generatedReadme.includes('Settings ->'));

const generatedRules = readFileSync(join(REPO_ROOT, '.zcode', 'reference', 'AGENTS.md'), 'utf8');
assert.ok(!generatedRules.includes('$HARNESS_ROOT/'));
assert.ok(generatedRules.includes('.zcode/reference/harness-rules.yaml'));
assert.ok(!generatedRules.includes('~/.zcode/projects/...'));
assert.match(generatedRules, /HARNESS_PROJECTS_DIR/);

const generatedMemorySkill = readFileSync(join(REPO_ROOT, '.zcode', 'skills', 'memory-cli', 'SKILL.md'), 'utf8');
assert.ok(!generatedMemorySkill.includes('~/.claude/projects/...'));
assert.match(generatedMemorySkill, /SessionStart 注入的“用户记忆目录”/);

const tempProject = mkdtempSync(join(REPO_ROOT, '.zcode-hook-test-'));
try {
  const memoryDir = join(tempProject, '.harness', 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Project Memory\n\n- [API rule](api-rule.md)\n');
  const pluginData = join(tempProject, 'plugin-data');
  const projectSlug = tempProject.replaceAll('\\', '/').replace(/[:/_]/gu, '-');
  const userMemoryDir = join(pluginData, 'projects', projectSlug, 'memory');
  mkdirSync(userMemoryDir, { recursive: true });
  writeFileSync(join(userMemoryDir, 'MEMORY.md'), '# User Memory\n\n- [User preference](feedback.md)\n');
  const hookInput = JSON.stringify({
    session_id: 'zcode-test-session',
    cwd: tempProject,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git clean -fd' },
    tool_use_id: 'tool-zcode-1',
  });
  const guarded = spawnSync(process.execPath, [wrapperFile, 'pre-tool-use-tasks-guard'], {
    cwd: tempProject,
    env: {
      ...process.env,
      ZCODE_PLUGIN_ROOT: join(REPO_ROOT, '.zcode'),
      PATH: process.platform === 'win32' ? dirname(process.execPath) : process.env.PATH,
    },
    input: hookInput,
    encoding: 'utf8',
  });
  assert.equal(guarded.status, 2, guarded.stderr);
  assert.match(guarded.stderr, /git clean/);

  const sessionStarted = spawnSync(process.execPath, [wrapperFile, 'session-start'], {
    cwd: tempProject,
    env: {
      ...process.env,
      ZCODE_PLUGIN_ROOT: join(REPO_ROOT, '.zcode'),
      ZCODE_PLUGIN_DATA: pluginData,
      PATH: process.platform === 'win32' ? dirname(process.execPath) : process.env.PATH,
    },
    input: JSON.stringify({
      session_id: 'zcode-test-session',
      cwd: tempProject,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }),
    encoding: 'utf8',
  });
  assert.equal(sessionStarted.status, 0, sessionStarted.stderr);
  const sessionOutput = JSON.parse(sessionStarted.stdout.trim());
  assert.equal(sessionOutput.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(sessionOutput.hookSpecificOutput.additionalContext, /Backend: zcode/);
  assert.match(sessionOutput.hookSpecificOutput.additionalContext, /用户记忆目录:/);
  assert.match(sessionOutput.hookSpecificOutput.additionalContext, /User preference/);
  assert.match(sessionOutput.hookSpecificOutput.additionalContext, /API rule/);

  const zcodeCliEntry = process.env.ZCODE_CLI_ENTRY;
  if (zcodeCliEntry && existsSync(zcodeCliEntry)) {
    const isolatedConfig = configureZcodePlugin({}, join(REPO_ROOT, '.zcode'));
    const isolatedConfigPath = join(tempProject, '.zcode', 'cli', 'config.json');
    mkdirSync(dirname(isolatedConfigPath), { recursive: true });
    writeFileSync(isolatedConfigPath, `${JSON.stringify(isolatedConfig, null, 2)}\n`);
    const listed = spawnSync(process.execPath, [
      zcodeCliEntry,
      'plugins', 'list', '--json',
    ], {
      cwd: tempProject,
      env: {
        ...process.env,
        HOME: tempProject,
        USERPROFILE: tempProject,
      },
      encoding: 'utf8',
    });
    assert.equal(listed.status, 0, listed.stderr);
    const pluginList = JSON.parse(listed.stdout);
    const inlinePlugin = pluginList.plugins.find((entry) => entry.id === 'uni-auri@inline');
    assert.ok(inlinePlugin, 'ZCode CLI must discover uni-auri@inline through plugins.dirs');
    assert.equal(inlinePlugin.enabled, true);
    assert.equal(inlinePlugin.source, 'inline');
    assert.ok(inlinePlugin.hookDetails.length > 0, 'ZCode CLI must register Uni-AURI plugin Hooks');
  }

  const usageToolId = 'tool-zcode-usage-1';
  const usageEnv = {
    ...process.env,
    ZCODE_PLUGIN_ROOT: join(REPO_ROOT, '.zcode'),
    ZCODE_PLUGIN_DATA: join(tempProject, 'plugin-data'),
    PATH: process.platform === 'win32' ? dirname(process.execPath) : process.env.PATH,
  };
  const usageToolInput = {
    cwd: REPO_ROOT,
    tool_name: 'Agent',
    tool_use_id: usageToolId,
    tool_input: {
      subagent_type: 'Developer',
      prompt: 'verify ZCode usage path handling',
    },
  };
  const usageStarted = spawnSync(process.execPath, [wrapperFile, 'pre-tool-use-agent-timestamp'], {
    cwd: REPO_ROOT,
    env: usageEnv,
    input: JSON.stringify({ ...usageToolInput, hook_event_name: 'PreToolUse' }),
    encoding: 'utf8',
  });
  assert.equal(usageStarted.status, 0, usageStarted.stderr);
  const pendingFile = join(tempProject, 'plugin-data', 'usage', `.pending-${usageToolId}`);
  assert.ok(existsSync(pendingFile), `PreToolUse must create the pending timestamp in ZCODE_PLUGIN_DATA (stderr: ${usageStarted.stderr})`);

  const usageFinished = spawnSync(process.execPath, [wrapperFile, 'post-tool-use-agent-usage'], {
    cwd: REPO_ROOT,
    env: usageEnv,
    input: JSON.stringify({ ...usageToolInput, hook_event_name: 'PostToolUse' }),
    encoding: 'utf8',
  });
  assert.equal(usageFinished.status, 0, usageFinished.stderr);
  assert.equal(existsSync(pendingFile), false, 'PostToolUse must consume the pending timestamp');
  const usageFile = join(tempProject, 'plugin-data', 'usage', 'usage.jsonl');
  assert.ok(existsSync(usageFile), 'PostToolUse must append usage data under ZCODE_PLUGIN_DATA');
  const usageEntries = readFileSync(usageFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(usageEntries.at(-1).backend, 'zcode');
  assert.equal(usageEntries.at(-1).role, 'developer');
} finally {
  rmSync(tempProject, { recursive: true, force: true });
}

console.log('test_zcode_generator: all tests passed');
