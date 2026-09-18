// adapters/zcode.mjs - generate the ZCode local plugin adapter (.zcode/).
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  REPO_ROOT,
  frameworkVersion,
  writeJson,
  writeText,
} from '../lib/common.mjs';
import { copyAssets } from '../lib/copy-assets.mjs';

const AGENTS_START = '<!-- uni-auri:zcode:start -->';
const AGENTS_END = '<!-- uni-auri:zcode:end -->';

// ZCode rejects Skill frontmatter descriptions longer than 1024 characters.
// Keep the full trigger catalog in the canonical .claude Skill, but use a
// compact ZCode-only description so the same Skill remains discoverable.
const ZCODE_SKILL_DESCRIPTION_OVERRIDES = {
  'pua-debugging': 'Use when a task fails repeatedly, troubleshooting is stuck, a fix needs verification, or environment, authentication, or network errors require alternative investigation. Also use for repeated attempts without new information, user frustration, or requests to give up. Applies to all task types.',
};

function normalizeZcodeSkillDescriptions(rootDir) {
  for (const [skillName, description] of Object.entries(ZCODE_SKILL_DESCRIPTION_OVERRIDES)) {
    const skillFile = join(REPO_ROOT, rootDir, 'skills', skillName, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    const source = readFileSync(skillFile, 'utf8');
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) continue;

    const normalizedFrontmatter = frontmatter[1].replace(
      /^description:\s*[^\r\n]*$/m,
      `description: ${JSON.stringify(description)}`,
    );
    if (normalizedFrontmatter !== frontmatter[1]) {
      const normalizedBlock = frontmatter[0].replace(frontmatter[1], normalizedFrontmatter);
      writeFileSync(
        skillFile,
        `${source.slice(0, frontmatter.index)}${normalizedBlock}${source.slice(frontmatter.index + frontmatter[0].length)}`,
        'utf8',
      );
    }
  }
}

function inlineZcodeRootInMarkdown(rootDir) {
  const root = join(REPO_ROOT, rootDir);
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.md')) {
        const source = readFileSync(path, 'utf8');
        const output = source
          .replaceAll('$HARNESS_ROOT/', `${rootDir}/`)
          .replaceAll('`~/.claude/projects/...`', 'SessionStart 注入的“用户记忆目录”')
          .replaceAll('`~/.zcode/projects/...`', 'SessionStart 注入的“用户记忆目录”');
        if (output !== source) writeFileSync(path, output, 'utf8');
      }
    }
  };
  if (existsSync(root)) walk(root);
}

function installWorkspaceInstructions(rootDir) {
  const generated = readFileSync(join(REPO_ROOT, rootDir, 'reference', 'AGENTS.md'), 'utf8').trim();
  const block = `${AGENTS_START}\n${generated}\n${AGENTS_END}`;
  const workspaceFile = join(REPO_ROOT, 'AGENTS.md');
  if (!existsSync(workspaceFile)) {
    writeText(workspaceFile, `${block}\n`);
    return true;
  }

  const current = readFileSync(workspaceFile, 'utf8');
  const start = current.indexOf(AGENTS_START);
  const end = current.indexOf(AGENTS_END);
  if (start >= 0 && end > start) {
    const updated = `${current.slice(0, start)}${block}${current.slice(end + AGENTS_END.length)}`;
    if (updated !== current) writeText(workspaceFile, updated);
    return updated !== current;
  }

  // The framework source repository already owns its AGENTS.md. Do not append
  // a duplicate generated copy when the canonical section is present.
  if (current.includes('# Uni-AURI 框架')) return false;
  writeText(workspaceFile, `${current.trimEnd()}\n\n${block}\n`);
  return true;
}

function processHook(id, timeoutMs) {
  return {
    type: 'process',
    command: 'node',
    args: ['${ZCODE_PLUGIN_ROOT}/hooks/zcode/run-hook.mjs', id],
    timeoutMs,
  };
}

function zcodeHooks() {
  return {
    description: 'Uni-AURI hooks for ZCode',
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|clear|compact',
          hooks: [
            processHook('session-start', 30000),
            processHook('cleanup-orphan-worktrees', 15000),
          ],
        },
      ],
      UserPromptSubmit: [
        { hooks: [processHook('check-upgrade-prompt', 10000)] },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            processHook('pre-tool-use-git-guard', 15000),
            processHook('pre-tool-use-tasks-guard', 10000),
            processHook('pre-commit-state-check', 10000),
          ],
        },
        {
          matcher: 'Edit|Write',
          hooks: [processHook('pre-tool-use-memory-route-guard', 10000)],
        },
        {
          matcher: 'Agent|Task',
          hooks: [processHook('pre-tool-use-agent-timestamp', 5000)],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Agent|Task',
          hooks: [processHook('post-tool-use-agent-usage', 30000)],
        },
      ],
    },
  };
}

function hookWrapperSource() {
  return `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const definitions = {
  'session-start': ['bash', 'hooks/shared/session-start.sh'],
  'check-upgrade-prompt': ['bash', 'hooks/shared/check-upgrade-prompt.sh'],
  'pre-tool-use-git-guard': ['bash', 'hooks/shared/pre-tool-use-git-guard.sh'],
  'pre-tool-use-tasks-guard': ['bash', 'hooks/shared/pre-tool-use-tasks-guard.sh'],
  'pre-commit-state-check': ['bash', 'hooks/shared/pre-commit-state-check.sh'],
  'pre-tool-use-memory-route-guard': ['bash', 'hooks/shared/pre-tool-use-memory-route-guard.sh'],
  'pre-tool-use-agent-timestamp': ['bash', 'hooks/shared/pre-tool-use-agent-timestamp.sh'],
  'post-tool-use-agent-usage': ['bash', 'hooks/shared/post-tool-use-agent-usage.sh'],
  'cleanup-orphan-worktrees': ['node', 'tools/scripts/maintenance/cleanup-orphan-worktrees.mjs', '--quiet'],
};

const id = process.argv[2];
const definition = definitions[id];
if (!definition) {
  process.stderr.write('[uni-auri] unknown ZCode hook id: ' + String(id) + '\\n');
  process.exit(1);
}

const raw = readFileSync(0, 'utf8');
let input = {};
try { input = raw.trim() ? JSON.parse(raw) : {}; } catch {}
const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
const pluginData = process.env.ZCODE_PLUGIN_DATA || join(homedir(), '.zcode', 'uni-auri');
const shellPath = (value) => {
  if (process.platform !== 'win32') return value;
  const normalized = value.replaceAll('\\\\', '/');
  return normalized.length >= 3 && normalized[1] === ':' && normalized[2] === '/'
    ? '/' + normalized[0].toLowerCase() + normalized.slice(2)
    : normalized;
};
const [command, relativeScript, ...extraArgs] = definition;
const scriptPath = join(pluginRoot, relativeScript).replaceAll('\\\\', '/');
const bashCandidates = [
  process.env.GIT_BASH,
  process.env.ProgramW6432 && join(process.env.ProgramW6432, 'Git', 'bin', 'bash.exe'),
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
];
// Issue !274 根因1：Git 装在非标准路径（如 D:\\Program Files\\work\\Git）时候选全 miss，
// 回退裸 "bash" 被 PATH 解析到 C:\\Windows\\System32\\bash.exe（WSL bash），其不识别
// D:/xxx 脚本路径参数 → 全部 hook 退出码 127。修复三件套：
//   ① where.exe git 推导 <root>\\cmd\\git.exe → <root>\\bin\\bash.exe（非标准安装兜底）
//   ② isWslBash 排除 WSL bash（含 GIT_BASH 被指到 WSL 的场景）
//   ③ 完全未命中时显式报错退出，不再静默回退裸 bash 制造 127 迷雾
const toSlashLower = (p) => String(p || '').replaceAll('\\\\', '/').toLowerCase();
const isWslBash = (p) => toSlashLower(p).endsWith('/windows/system32/bash.exe')
  || toSlashLower(p).endsWith('/program files/wsl/bash.exe');
const gitBashFromWhere = () => {
  try {
    const out = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
    if (out.status !== 0) return null;
    for (const line of String(out.stdout || '').split(/\\r?\\n/)) {
      const gitExe = line.trim();
      if (!toSlashLower(gitExe).endsWith('/cmd/git.exe')) continue;
      const candidate = join(resolve(gitExe, '..', '..'), 'bin', 'bash.exe');
      if (existsSync(candidate) && !isWslBash(candidate)) return candidate;
    }
  } catch {}
  return null;
};
const resolvedBash = bashCandidates.find((c) => c && existsSync(c) && !isWslBash(c))
  || gitBashFromWhere();
const executable = command === 'bash' && process.platform === 'win32'
  ? resolvedBash || (() => {
      process.stderr.write('[uni-auri] 未找到 Git bash.exe：GIT_BASH 与常见安装路径均未命中，where.exe git 也无可用的 <root>\\\\cmd\\\\git.exe。请安装 Git for Windows 或设置 GIT_BASH 指向 bash.exe。\\n');
      process.exit(127);
    })()
  : command;
let childPath = process.env.PATH || '';
if (command === 'bash' && process.platform === 'win32' && executable !== command) {
  const executableDir = dirname(executable);
  const gitRoot = executableDir.toLowerCase().endsWith(sep + 'usr' + sep + 'bin')
    ? resolve(executableDir, '..', '..')
    : resolve(executableDir, '..');
  childPath = [join(gitRoot, 'usr', 'bin'), join(gitRoot, 'mingw64', 'bin'), childPath]
    .filter(Boolean)
    .join(delimiter);
}
const child = spawnSync(executable, [scriptPath, ...extraArgs], {
  cwd,
  env: {
    ...process.env,
    HARNESS_BACKEND: 'zcode',
    HARNESS_ROOT: '.zcode',
    HOOK_DENY_EXIT: '2',
    HARNESS_USAGE_DIR: shellPath(join(pluginData, 'usage')),
    HARNESS_PROJECTS_DIR: shellPath(join(pluginData, 'projects')),
    REPO_ROOT: shellPath(cwd),
    PATH: childPath,
  },
  input: raw,
  encoding: 'utf8',
  windowsHide: true,
});

if (child.error) {
  process.stderr.write('[uni-auri] failed to run ZCode hook: ' + child.error.message + '\\n');
  process.exit(1);
}
if (child.stderr) process.stderr.write(child.stderr);

let stdout = child.stdout || '';
if (id === 'check-upgrade-prompt' && stdout.trim() && !stdout.trimStart().startsWith('{')) {
  stdout = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: stdout.trim(),
    },
  }) + '\\n';
}
if (stdout) process.stdout.write(stdout);
process.exit(Number.isInteger(child.status) ? child.status : 1);
`;
}

/** @param {object} target targets.json zcode configuration */
export function run(target) {
  const { rootDir, configFile, marketplaceFile, hooksFile, env } = target;
  const copied = copyAssets(rootDir, {
    skills: true,
    agents: true,
    support: true,
    rulesMd: true,
    harnessRoot: env.HARNESS_ROOT,
  });

  normalizeZcodeSkillDescriptions(rootDir);

  // ZCode reads framework assets through its plugin loader. It does not expand
  // HARNESS_ROOT inside Markdown, so references must be concrete project paths.
  inlineZcodeRootInMarkdown(rootDir);

  const version = frameworkVersion();
  writeJson(join(REPO_ROOT, configFile), {
    name: 'uni-auri',
    version,
    description: 'Uni-AURI agent engineering workflow for ZCode',
    author: { name: 'wangzk' },
    license: 'MIT',
    keywords: ['multi-agent', 'tdd', 'code-review', 'spec-driven', 'zcode'],
    // ZCode only mounts component directories declared by the plugin manifest.
    // The generated files may exist without these entries, but then Skills and
    // custom Agents are invisible to the session.
    skills: 'skills',
    agents: 'agents',
  });
  writeJson(join(REPO_ROOT, marketplaceFile), {
    name: 'uni-auri-local',
    description: 'Local Uni-AURI plugin market for ZCode',
    plugins: [
      {
        name: 'uni-auri',
        source: '.',
        description: 'Uni-AURI agent engineering workflow for ZCode',
        version,
        category: 'developer-tools',
        tags: ['multi-agent', 'tdd', 'code-review'],
        strict: true,
      },
    ],
  });
  writeJson(join(REPO_ROOT, hooksFile), zcodeHooks());
  writeText(join(REPO_ROOT, rootDir, 'hooks', 'zcode', 'run-hook.mjs'), hookWrapperSource());
  writeText(join(REPO_ROOT, rootDir, 'README.md'), `# Uni-AURI for ZCode

The installer registers this directory through ZCode's \`plugins.dirs\`
configuration and enables \`uni-auri@inline\`. Skills, Agents, and Hooks
load automatically in subsequent new sessions; use \`rd:auto\` directly.
`);

  const workspaceInstructions = installWorkspaceInstructions(rootDir);
  return {
    plugin: configFile,
    marketplace: marketplaceFile,
    hooks: hooksFile,
    skills: copied.skills,
    agents: copied.agents,
    support: copied.support,
    workspaceInstructions,
  };
}

export default { run };
