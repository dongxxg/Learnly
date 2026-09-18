import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, readJson } from '../generate/lib/common.mjs';
import { run as runDsh } from '../generate/adapters/dsh.mjs';

const manifest = readJson(join(REPO_ROOT, '.claude', 'tools', 'scripts', 'generate', 'targets.json'));
const target = manifest.targets.dsh;
assert.ok(target, 'targets.json should declare dsh');
assert.equal(target.rootDir, '.dsh');
assert.equal(target.env.HARNESS_BACKEND, 'dsh');
assert.equal(target.env.HARNESS_ROOT, '.dsh');

const result = runDsh(target);
assert.equal(result.config, '.dsh/settings.json');
assert.ok(existsSync(join(REPO_ROOT, '.dsh', 'settings.json')));
assert.ok(existsSync(join(REPO_ROOT, '.dsh', 'AGENTS.md')));
assert.ok(existsSync(join(REPO_ROOT, '.dsh', 'rules', 'ai-git-commit-spec.md')));
assert.ok(existsSync(join(REPO_ROOT, '.dsh', 'skills', 'rd-auto', 'SKILL.md')));
assert.ok(existsSync(join(REPO_ROOT, '.dsh', 'agents', 'developer.md')));
assert.ok(existsSync(join(REPO_ROOT, '.dsh', 'backends', 'dsh-backend.js')));

// settings.json: env 前缀注入（信息性，与其它 backend 对齐）
const settings = readJson(join(REPO_ROOT, '.dsh', 'settings.json'));
const hookCommands = Object.values(settings.hooks)
  .flat()
  .flatMap((entry) => entry.hooks)
  .map((hook) => hook.command)
  .filter(Boolean);
assert.ok(hookCommands.some((c) => c.includes('HARNESS_BACKEND=dsh')), 'hooks should carry HARNESS_BACKEND=dsh env');
assert.ok(hookCommands.some((c) => c.includes('HARNESS_ROOT=.dsh')), 'hooks should carry HARNESS_ROOT=.dsh env');

// .dsh/ 内 markdown：$HARNESS_ROOT/ 已固化为 .dsh/，无残留
const constants = readFileSync(join(REPO_ROOT, '.dsh', 'skills', 'rd-auto', 'scripts', 'lib', 'constants.js'), 'utf8');
assert.ok(constants.includes("process.env.HARNESS_ROOT || '.dsh'"), 'entry scripts should inject .dsh default');
assert.ok(!constants.includes("process.env.HARNESS_ROOT || '.claude'"), 'no .claude default residue');

const dshAgents = readFileSync(join(REPO_ROOT, '.dsh', 'AGENTS.md'), 'utf8');
assert.ok(dshAgents.includes('.dsh/'), '.dsh/AGENTS.md should reference .dsh/ paths');
assert.ok(!dshAgents.includes('$HARNESS_ROOT/'), 'no $HARNESS_ROOT residue in .dsh/AGENTS.md');

// 项目根 AGENTS.md 已存在（框架源仓库）→ 不得覆盖
assert.equal(result.rootAgentsMd, undefined, 'existing root AGENTS.md must not be overwritten');

// DSH 原生从项目根 .dsh/skills/ 发现技能（directory-bundle），frontmatter name 必须匹配
// /^[a-z0-9]+(?:-[a-z0-9]+)*$/ 且含 description，否则整条技能被忽略（dsh-skill-filesystem）。
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const skillsDir = join(REPO_ROOT, '.dsh', 'skills');
const skillNames = readdirSync(skillsDir).filter((n) => statSync(join(skillsDir, n)).isDirectory());
assert.ok(skillNames.length >= 15, 'all framework skills should be copied to .dsh/skills');
for (const name of skillNames) {
  const skillMd = readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8');
  const fm = skillMd.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, `${name}/SKILL.md must keep YAML frontmatter`);
  const dshName = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(dshName && SKILL_NAME_RE.test(dshName),
    `${name}: DSH-invalid skill name "${dshName}" (must be kebab-case lowercase)`);
  const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(desc, `${name}: description is required by DSH skill loader`);
}
// rd:auto 冒号名应转为 rd-auto 且保留 originalName 元数据
const rdAuto = readFileSync(join(skillsDir, 'rd-auto', 'SKILL.md'), 'utf8');
assert.ok(rdAuto.includes('name: rd-auto'));
assert.ok(rdAuto.includes('originalName: rd:auto'), 'original name should be kept in metadata');

// settings.json 功能 → DSH 识别格式（策略段 + harness-policy 技能）
const dshAgentsPolicy = readFileSync(join(REPO_ROOT, '.dsh', 'AGENTS.md'), 'utf8');
assert.ok(dshAgentsPolicy.includes('<!-- uni-auri-policy:start -->'), '.dsh/AGENTS.md should carry the policy section');
assert.ok(dshAgentsPolicy.includes('硬约束'), 'policy should classify hard constraints');
assert.ok(dshAgentsPolicy.includes('git hook 硬拦截'), 'policy should map git denies to git hooks');
assert.ok(dshAgentsPolicy.includes('permissions.deny'), 'policy should reflect deny list');
const policySkill = join(REPO_ROOT, '.dsh', 'skills', 'harness-policy', 'SKILL.md');
assert.ok(existsSync(policySkill), 'harness-policy skill should be generated');
const policySkillMd = readFileSync(policySkill, 'utf8');
assert.ok(policySkillMd.includes('name: harness-policy'), 'harness-policy skill name must be DSH-valid');
assert.ok(policySkillMd.includes('description:'), 'harness-policy skill requires description');

// 源仓库根 AGENTS.md 是 git 事实源，生成器绝不改写
const rootAgents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
assert.ok(!rootAgents.includes('uni-auri-policy'), 'source repo root AGENTS.md must never be modified by the generator');

console.log('test_dsh_generator: all tests passed');
