// adapters/dsh.mjs — generate the DeepSeek Harness project adapter (.dsh/).
//
// DeepSeek Harness（桌面应用）没有 ProjectUse/SessionStart hook 或 settings.json 加载，
// 但原生加载项目根 AGENTS.md / CLAUDE.md（见 @deepseek-ai/dsh-agent-instructions）。
// 因此 .dsh/ 采用「完整副本 + 信息性 settings + 根 AGENTS.md 兜底」策略：
//   1. settings.json：与其它 backend 同构生成（env 注入 HARNESS_*；DSH 不读取，仅信息性）
//   2. 完整复制 skills/agents/框架支持目录（真实副本，自包含）
//   3. .dsh/AGENTS.md：框架协作规则副本，路径固化为 .dsh/（DSH 会话不注入 settings env）
//   4. 项目根缺 AGENTS.md 时创建（同 setup-harness.sh 的 ensure_claude_md 行为），
//      让 DSH 会话自动加载框架规则
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { REPO_ROOT, copyFile, ensureDir, loadClaudeSettings, writeJson } from '../lib/common.mjs';
import { claudeJsonSettings } from '../lib/settings-emit.mjs';
import { copyAssets, rewriteFileIfNeeded } from '../lib/copy-assets.mjs';

/**
 * DSH 不读取项目级 settings env，$HARNESS_ROOT 在会话中不可展开。
 * 把 .dsh/ 内 markdown 的裸 $HARNESS_ROOT/ 固化为 .dsh/，使规则路径可直接点击/引用。
 */
function inlineDshRootInMarkdown(rootDir) {
  const root = join(REPO_ROOT, rootDir);
  if (!existsSync(root)) return;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name.endsWith('.md')) {
        const source = readFileSync(path, 'utf8');
        const output = source.replaceAll('$HARNESS_ROOT/', `${rootDir}/`);
        if (output !== source) writeFileSync(path, output, 'utf8');
      }
    }
  };
  walk(root);
}

/**
 * DSH 原生从项目根 `.dsh/skills/` 发现技能（directory-bundle: <name>/SKILL.md），
 * frontmatter 要求 name 匹配 /^[a-z0-9]+(?:-[a-z0-9]+)*$/ 且 description 非空，
 * 否则整条技能被忽略（dsh-skill-filesystem 源码）。
 * framework 的 rd:* 冒号名不符合 → 转为 kebab-case（与目录名一致），
 * 原名记入 metadata.originalName 保留映射。version/trigger 等额外字段被 DSH 容忍。
 */
function dshifySkillFrontmatter(rootDir) {
  const skillsDir = join(REPO_ROOT, rootDir, 'skills');
  if (!existsSync(skillsDir)) return 0;
  const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  let converted = 0;
  for (const dirName of readdirSync(skillsDir)) {
    const skillDir = join(skillsDir, dirName);
    if (!statSync(skillDir).isDirectory()) continue;
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const source = readFileSync(skillMd, 'utf8');
    const m = source.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = m[1];
    const nameLine = fm.match(/^name:\s*(.+)$/m);
    if (!nameLine) continue;
    const original = nameLine[1].trim();
    if (NAME_RE.test(original)) continue; // 已合规
    const convertedName = original
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || dirName;
    let newFm = fm.replace(/^name:\s*(.+)$/m, `name: ${convertedName}`);
    // metadata.originalName 保留原名（无既有 metadata 时新增）
    if (!/^metadata:\s*$/m.test(fm)) {
      newFm += `\nmetadata:\n  originalName: ${original}`;
    }
    const output = source.slice(0, m.index) + '---\n' + newFm + '\n---' + source.slice(m.index + m[0].length);
    writeFileSync(skillMd, output, 'utf8');
    converted++;
  }
  return converted;
}

/**
 * 把 .claude/settings.json 的 permissions/hooks/env 转换为 DSH 可识别格式：
 *   1) 追加到 .dsh/AGENTS.md（DSH 会话强制注入的指令 → 规则真正生效）
 *   2) 生成技能 .dsh/skills/harness-policy/SKILL.md（模型按需加载的规则手册）
 * DSH 无项目级 permissions/hooks/env 文件机制（权限是会话级 sandbox/approval），
 * 规则以指令/技能形式由模型在执行 Bash/Edit/Write 前自查。
 */

/** 解析 "Tool(pattern)" 形式的权限条目。 */
function parsePermissionEntry(entry) {
  const m = String(entry).match(/^(\w+)\((.*)\)$/s);
  if (!m) return null;
  return { tool: m[1], pattern: m[2] };
}

/** 把权限模式转成人类可读的命令规则描述。 */
function describePattern(tool, pattern) {
  const p = pattern.trim();
  if (!p) return `${tool}(任意参数)`;
  if (p === '*') return `${tool}(任意参数)`;
  return `${tool} 且命令形如「${p.replaceAll('*', '…')}」`;
}

/** 生成策略 markdown 段（幂等：被 uni-auri-policy 标记包裹，重生成时先移除旧段）。 */
function buildPolicyMarkdown(rootDir) {
  const settings = loadClaudeSettings();
  const perm = settings.permissions || {};
  const lines = [];
  lines.push('## 工具使用策略（由 .claude/settings.json 转换，DSH 环境等效执行）');
  lines.push('');
  lines.push('> 本段由 generator 从框架 settings.json 转换，替代 Claude Code 的 permissions/hooks 机制。');
  lines.push('> DSH 无项目级权限/hook/env 文件，以下规则以指令形式强制生效：');
  lines.push('> 模型在调用 Bash / Edit / Write 工具前必须自查，违反「禁止」规则视为违规。');
  lines.push('');
  lines.push('### 允许的操作（permissions.allow 转换）');
  lines.push('');
  for (const entry of perm.allow || []) {
    const e = parsePermissionEntry(entry);
    if (e) lines.push(`- ✅ 允许：${describePattern(e.tool, e.pattern)}`);
  }
  lines.push('');
  lines.push('### 禁止的操作（permissions.deny 转换）——按约束强度分级');
  lines.push('');
  lines.push('**硬约束（强制，不由模型自觉决定）：**');
  lines.push('');
  lines.push('- git 类危险操作由框架 git hooks 强制执行（commit-msg / pre-commit / pre-push，');
  lines.push('  实测在 DSH 环境拦截违规 commit；push 审批走 .harness/.push-approved Challenge-Response）：');
  lines.push('');
  for (const entry of perm.deny || []) {
    const e = parsePermissionEntry(entry);
    if (e && String(entry).includes('git')) {
      lines.push(`  - ❌ 禁止：${describePattern(e.tool, e.pattern)}（git hook 硬拦截）`);
    }
  }
  lines.push('');
  lines.push('**用户级硬约束（DSH sandbox 强制，模式由用户在 DSH 设置选择）：**');
  lines.push('');
  lines.push('- 系统级危险命令无法项目级强制；建议 DSH 会话使用 workspace-write 模式（可写工作区、');
  lines.push('  阻断工作区外的写操作）。当前默认 danger-full-access 不拦截，模型仍须自查：');
  lines.push('');
  for (const entry of perm.deny || []) {
    const e = parsePermissionEntry(entry);
    if (e && !String(entry).includes('git')) {
      lines.push(`  - ❌ 禁止：${describePattern(e.tool, e.pattern)}（sandbox 用户级硬 + 模型自查）`);
    }
  }
  lines.push('');
  lines.push('**模型自查（软约束，DSH 项目级唯一可注入的规则层）：**');
  lines.push('');
  lines.push('- 违反上表任何「禁止」规则的 Bash/Edit/Write 调用都应被视为违规；');
  lines.push('- 不确定某命令是否被允许时，先查本策略段或 harness-policy 技能。');
  lines.push('');
  lines.push('### 门禁自查（settings.hooks 转换——DSH 无 PreToolUse/SessionStart hook，改由模型自查）');
  lines.push('');
  const hookLines = [];
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    for (const entry of entries) {
      const matcher = entry.matcher || '*';
      for (const hook of entry.hooks || []) {
        if (typeof hook.command !== 'string') continue;
        const script = hook.command.match(/([\w-]+\.sh|[\w-]+\.mjs)/);
        hookLines.push(`- ${event}(${matcher}) → 检查 ${hook.command.slice(0, 110)}`);
      }
    }
  }
  if (hookLines.length) {
    lines.push('触发点自查清单：');
    lines.push('');
    lines.push(...hookLines);
  } else {
    lines.push('（框架 settings.json 无 hooks，跳过）');
  }
  lines.push('');
  lines.push('### 环境变量（settings.env 转换——DSH 无项目级 env 注入，此处声明为会话约定）');
  lines.push('');
  const env = { ...(settings.env || {}), ...{ HARNESS_ROOT: rootDir, HARNESS_BACKEND: 'dsh' } };
  for (const [k, v] of Object.entries(env)) {
    lines.push('- `' + k + '=' + v + '`');
  }
  lines.push('');
  lines.push('### 门禁脚本位置');
  lines.push('');
  lines.push('- 全部共享脚本位于 `' + rootDir + '/hooks/shared/`（git-guard / tasks-guard / memory-route-guard / session-start / post-tool-use-agent-usage 等），');
  lines.push(`- git 提交门禁（commit-msg/pre-commit/pre-push）由 git hooks 强制执行，与 DSH 无关，始终生效。`);
  lines.push('');
  const body = lines.join('\n');
  return (
    '\n<!-- uni-auri-policy:start -->\n' +
    body +
    '\n<!-- uni-auri-policy:end -->\n'
  );
}

/** 追加/替换策略段到指定 AGENTS.md（幂等）。 */
function upsertPolicyInAgents(agentsPath, policyBlock) {
  if (!existsSync(agentsPath)) return false;
  let source = readFileSync(agentsPath, 'utf8');
  const marker = /<!-- uni-auri-policy:start -->[\s\S]*?<!-- uni-auri-policy:end -->/;
  if (marker.test(source)) {
    source = source.replace(marker, policyBlock.trim());
  } else {
    source = source.replace(/\s*$/, '') + '\n' + policyBlock;
  }
  writeFileSync(agentsPath, source, 'utf8');
  return true;
}

/** 生成 DSH 技能 harness-policy（规则手册，模型按需加载）。 */
function emitPolicySkill(rootDir, policyBlock) {
  const skillDir = join(REPO_ROOT, rootDir, 'skills', 'harness-policy');
  const body = [
    '---',
    'name: harness-policy',
    'description: Uni-AURI 项目工具使用策略：允许/禁止的 bash 命令、git 红线与门禁自查规则（由 .claude/settings.json 转换，DSH 环境等效执行）。执行 bash/git/文件写操作前应参考。',
    'whenToUse: 执行任何 bash/git/文件写操作之前，或不确定某命令是否被项目策略允许时',
    '---',
    '# Uni-AURI 工具使用策略',
    '',
    '本技能由 generator 从框架 .claude/settings.json 转换生成，与 .dsh/AGENTS.md 中的策略段同源。',
    '执行工具调用前，按以下规则自查。',
    '',
    policyBlock.trim(),
    '',
  ].join('\n');
  ensureDir(skillDir);
  writeFileSync(join(skillDir, 'SKILL.md'), body, 'utf8');
  return skillDir;
}

/** 把 settings.json 功能转换为 DSH 识别格式（指令 + 技能）。 */
function emitDshPolicy(rootDir) {
  const policyBlock = buildPolicyMarkdown(rootDir);
  const agentsPath = join(REPO_ROOT, rootDir, 'AGENTS.md');
  const injected = upsertPolicyInAgents(agentsPath, policyBlock);
  const skillDir = emitPolicySkill(rootDir, policyBlock);
  // 根 AGENTS.md 的策略段注入由 run() 在 ensureRootAgentsMd 创建时执行
  // （源仓库/已有 AGENTS.md 是项目自有文件，生成器绝不改写）。
  return { injected, skill: skillDir, policyBlock };
}

/**
 * 项目根 AGENTS.md：DSH 原生加载点。
 * 仅在根 AGENTS.md / CLAUDE.md 都不存在时创建（同 ensure_claude_md：不覆盖项目已有文件）。
 * 内容取自 .claude/reference/AGENTS.md，并把 .claude/ 与 $HARNESS_ROOT/ 路径固化为 .dsh/。
 */
function ensureRootAgentsMd(rootDir) {
  const rootAgents = join(REPO_ROOT, 'AGENTS.md');
  if (existsSync(rootAgents) || existsSync(join(REPO_ROOT, 'CLAUDE.md'))) return null;
  const ref = join(REPO_ROOT, '.claude', 'reference', 'AGENTS.md');
  if (!existsSync(ref)) return null;
  const source = readFileSync(ref, 'utf8');
  const rewritten = source
    .replaceAll('$HARNESS_ROOT/', `${rootDir}/`)
    .replace(/(?<!~\/)(?<!\$HOME\/)\.claude\//g, `${rootDir}/`);
  writeFileSync(rootAgents, rewritten, 'utf8');
  return rootAgents;
}

/** @param {object} target targets.json 中 dsh 的配置块 */
export function run(target) {
  const { rootDir, configFile, env } = target;

  // 1. settings.json（permissions/hooks/env/statusLine；hook 命令重定位为 $HARNESS_ROOT/）。
  //    DSH 不读取 hooks/settings，此处保留信息性配置与其它 backend 对齐；
  //    stripIf 去掉 Claude 专属 if 字段，SessionStart matcher 收窄为 DSH 无 hook 的保守值。
  const settings = claudeJsonSettings({
    env,
    targetRoot: rootDir,
    transforms: { stripIf: true, sessionStartMatcher: 'startup|resume' },
  });
  writeJson(join(REPO_ROOT, configFile), settings);

  // 2. 完整复制 skills / agents / 框架支持目录（真实副本，自包含，无软链接指向 .claude/）
  const copied = copyAssets(rootDir, { skills: true, agents: true, support: true, harnessRoot: env.HARNESS_ROOT });

  // 3. 本地覆盖配置（permissions.allow 等开发便捷项）
  const localSrc = join(REPO_ROOT, '.claude', 'settings.local.json');
  const localDst = join(REPO_ROOT, rootDir, 'settings.local.json');
  if (copyFile(localSrc, localDst)) {
    rewriteFileIfNeeded(localDst);
    copied.local = localDst;
  }

  // 4. .dsh/AGENTS.md（框架规则副本，路径固化为 .dsh/）
  const refAgents = join(REPO_ROOT, '.claude', 'reference', 'AGENTS.md');
  const dshAgents = join(REPO_ROOT, rootDir, 'AGENTS.md');
  if (copyFile(refAgents, dshAgents)) {
    const source = readFileSync(dshAgents, 'utf8');
    const rewritten = source
      .replaceAll('$HARNESS_ROOT/', `${rootDir}/`)
      .replace(/(?<!~\/)(?<!\$HOME\/)\.claude\//g, `${rootDir}/`);
    writeFileSync(dshAgents, rewritten, 'utf8');
    copied.agentsMd = dshAgents;
  }

  // 5. markdown 内 $HARNESS_ROOT/ 固化为 .dsh/（DSH 会话不注入 settings env）
  inlineDshRootInMarkdown(rootDir);

  // 5.1 DSH 原生加载 .dsh/skills/ —— frontmatter name 转 DSH 合规格式（rd:* → rd-*）
  const dshSkills = dshifySkillFrontmatter(rootDir);
  if (dshSkills > 0) copied.dshSkillNameFixes = dshSkills;

  // 5.2 settings.json 功能 → DSH 识别格式（AGENTS.md 指令段 + harness-policy 技能）
  const policy = emitDshPolicy(rootDir);
  copied.policySkill = policy.skill;

  // 6. 项目根 AGENTS.md 兜底（缺省时创建；创建的文件才注入策略段，已有文件绝不改写）
  const rootAgents = ensureRootAgentsMd(rootDir);
  if (rootAgents) {
    upsertPolicyInAgents(rootAgents, policy.policyBlock);
    copied.rootAgentsMd = rootAgents;
  }

  return {
    config: configFile,
    skills: copied.skills,
    agents: copied.agents,
    support: copied.support,
    local: copied.local,
    agentsMd: copied.agentsMd,
    rootAgentsMd: copied.rootAgentsMd,
    dshSkillNameFixes: copied.dshSkillNameFixes ?? 0,
  };
}

export default { run };
