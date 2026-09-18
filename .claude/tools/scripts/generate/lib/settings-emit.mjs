// lib/settings-emit.mjs — 从 .claude/settings.json 派生各 agent 的 settings/hooks/config。
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { envPrefix, loadClaudeSettings, REPO_ROOT } from './common.mjs';

/** 统一为 posix 分隔符（Windows 反斜杠路径在双引号 shell 命令串里易被转义破坏，正斜杠全平台可用） */
function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * 把命令中的字面量 `.claude/` 路径重定位为 `$HARNESS_ROOT/`，
 * 使生成的配置在目标 agent root（.codex / .codebuddy）下自包含、不再依赖 .claude/。
 * 例如 `bash .claude/hooks/shared/x.sh` → `bash $HARNESS_ROOT/hooks/shared/x.sh`。
 */
function relocatable(command) {
  return command.replaceAll('.claude/', '$HARNESS_ROOT/');
}

/**
 * 给一个 command 字符串加 env 前缀（用于让被复用的 .claude/ 脚本知道当前 backend）。
 */
function withEnv(command, env) {
  const pre = envPrefix(env);
  return pre + relocatable(command);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Qoder does not document a project-level env map. Run the complete hook in a
// child shell so the per-command HARNESS assignments remain visible to every
// branch of compound commands, while preserving hook stdin and exit status.
function withQoderEnv(command, env) {
  return `${envPrefix(env)}bash -c ${shellQuote(relocatable(command))}`;
}

function invokeHookScriptsWithBash(command) {
  return command.replace(
    /(^|&&|\|\||;|\{)\s*(\$HARNESS_ROOT\/hooks\/shared\/[\w-]+\.sh)/g,
    '$1 bash $2',
  );
}

const QODER_BLOCKING_GUARDS = /\$HARNESS_ROOT\/hooks\/shared\/(pre-tool-use-git-guard|pre-tool-use-tasks-guard|pre-commit-state-check|pre-tool-use-memory-route-guard)\.sh/;

function qoderHooks(hooks, env) {
  const out = {};
  for (const [event, entries] of Object.entries(hooks)) {
    out[event] = entries.map((entry) => {
      const nextEntry = { ...entry };
      if (event === 'SessionStart') nextEntry.matcher = 'startup|resume|compact';
      nextEntry.hooks = (entry.hooks ?? []).map((hook) => {
        const nextHook = { ...hook };
        delete nextHook.if;
        if (typeof hook.command !== 'string') return nextHook;

        const relocated = relocatable(hook.command);
        const guard = event === 'PreToolUse' ? relocated.match(QODER_BLOCKING_GUARDS) : null;
        if (guard) {
          // Qoder blocks a tool when PreToolUse exits 2. Do not inherit the
          // Claude source command's `|| true`, which would swallow that code.
          const direct =
            '[ -f .harness/.framework-edit ] || { ' +
            '[ ! -f $HARNESS_ROOT/reference/harness-rules.md ] || ' +
            `bash ${guard[0]}; }`;
          nextHook.command = withQoderEnv(direct, env);
        } else {
          nextHook.command = withQoderEnv(invokeHookScriptsWithBash(relocated), env);
        }
        return nextHook;
      });
      return nextEntry;
    });
  }
  return out;
}

/**
 * 深拷贝 source.hooks 并把每个 command 加上 env 前缀。
 * transforms（CodeBuddy 规范需要）：
 *   - stripIf: 删除 Claude 专属的 `if` 字段（CodeBuddy hooks 不支持）
 *   - sessionStartMatcher: 把 SessionStart 的空 matcher 改为 CodeBuddy 认可的
 *     `startup|resume|clear|compact`
 * 框架脚本仍在 .claude/ 下（HARNESS_ROOT 默认 .claude）。
 */
function prefixHooks(hooks, env, transforms = {}) {
  const out = {};
  for (const [event, entries] of Object.entries(hooks)) {
    out[event] = entries.map((entry) => {
      const newEntry = { ...entry };
      if (transforms.sessionStartMatcher && event === 'SessionStart' && !newEntry.matcher) {
        newEntry.matcher = transforms.sessionStartMatcher;
      }
      if (Array.isArray(entry.hooks)) {
        newEntry.hooks = entry.hooks.map((h) => {
          const nh = { ...h };
          if (typeof h.command === 'string') nh.command = withEnv(h.command, env);
          if (transforms.stripIf) delete nh.if;
          return nh;
        });
      }
      return newEntry;
    });
  }
  return out;
}

/**
 * CodeBuddy / Claude 风格 settings.json。
 * 复刻源 permissions（allow/deny/defaultMode）+ env + statusLine + hooks(env 前缀)。
 * @param {object} opts
 * @param {object} [opts.env] 注入到每个 hook command 的 env 前缀（含 HARNESS_ROOT 等目标 backend 变量）
 * @param {object} [opts.transforms] { stripIf, sessionStartMatcher }
 * @param {string} [opts.targetRoot] 目标 backend 的 rootDir（如 ".codebuddy"），用于把 statusLine
 *   命令里 `.claude/` 字面量替换为目标路径。statusLine 子进程**不继承** settings.env，
 *   `$HARNESS_ROOT` 在其中无法展开，故必须内联实际路径。内联用绝对路径
 *   （resolve(REPO_ROOT, targetRoot)，posix 分隔符）：相对路径依赖子进程 CWD == 项目根，
 *   子目录启动/后端差异场景会解析失败 → 状态栏静默消失。
 */
export function claudeJsonSettings({ env, transforms, targetRoot } = {}) {
  const src = loadClaudeSettings();
  const permissions = {
    allow: src.permissions?.allow ?? [],
    deny: src.permissions?.deny ?? [],
    defaultMode: src.permissions?.defaultMode ?? 'bypassPermissions',
  };
  const out = {
    permissions,
    // 顶层 env 注入 HARNESS_*（来自 target env），使 $HARNESS_ROOT 等在整个会话可见。
    // 注意：此 env 只注入到会话主进程和 hook 子进程，**不注入 statusLine 子进程**——
    // statusLine 的路径解析依赖 targetRoot 内联（见下方 statusLine 处理）。
    env: { ...(src.env ?? {}), ...(env ?? {}) },
    hooks: prefixHooks(src.hooks ?? {}, env, transforms),
    // CodeBuddy 记忆系统（官方 .codebuddy 目录结构的 memory 配置）：
    // 启用自动记忆与类型化记忆；项目记忆文件为 CODEBUDDY.md，规则在 .codebuddy/rules/。
    memory: { autoMemoryEnabled: true, typedMemory: true },
  };
  if (src.statusLine) {
    const sl = { ...src.statusLine };
    if (typeof sl.command === 'string') {
      // statusLine 子进程不继承 settings.env，$HARNESS_ROOT 会展开为空。
      // 用目标 backend 的实际安装位置内联替换 .claude/ → <绝对路径>/。
      // generator 在目标仓库内运行，REPO_ROOT 即目标根 → resolve 出目标机绝对路径，
      // 不依赖子进程 CWD（子目录启动/后端差异下相对路径会解析失败）。
      // targetRoot 缺省时回退到 $HARNESS_ROOT/（保持源不变，仅 Claude 自身使用）。
      const replaceWith = targetRoot ? `${toPosix(resolve(REPO_ROOT, targetRoot))}/` : '$HARNESS_ROOT/';
      sl.command = sl.command.replaceAll('.claude/', replaceWith);
    }
    out.statusLine = sl;
  }
  if (src.skipDangerousModePermissionPrompt) out.skipDangerousModePermissionPrompt = true;
  return out;
}

/**
 * Qoder CN project settings. Only documented project keys are emitted; HARNESS
 * variables are attached to each hook command because Qoder has no documented
 * top-level project `env` setting.
 */
export function qoderJsonSettings({ env } = {}) {
  const src = loadClaudeSettings();
  const sourceMode = src.permissions?.defaultMode;
  const defaultPermissionMode = /^(bypass[_-]?permissions|yolo)$/i.test(sourceMode || '')
    ? 'auto'
    : (sourceMode ?? 'auto');
  return {
    general: {
      defaultPermissionMode,
    },
    permissions: {
      allow: src.permissions?.allow ?? [],
      deny: src.permissions?.deny ?? [],
    },
    hooks: qoderHooks(src.hooks ?? {}, env),
  };
}

/**
 * Codex 风格 hooks.json（.codex/hooks.json）。
 * 复刻现有手写结构的事件/matcher/statusMessage/timeout，并加 env 前缀。
 * 脚本仍复用 .claude/hooks/shared/*.sh（HARNESS_ROOT 默认 .claude）。
 */
export function codexHooksJson({ env } = {}) {
  const e = process.platform === 'win32' ? winEnvPrefix(env) : envPrefix(env);
  const obj = {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume|clear|compact',
          hooks: [
            {
              type: 'command',
              command: `${e}REPO_ROOT=$(pwd) bash .claude/hooks/shared/session-start.sh || true`,
              statusMessage: 'Uni-AURI: Initializing framework context',
              timeout: 30,
            },
            {
              type: 'command',
              command: `${e}[ -f .claude/tools/scripts/maintenance/cleanup-orphan-worktrees.mjs ] && node .claude/tools/scripts/maintenance/cleanup-orphan-worktrees.mjs --quiet || true`,
              statusMessage: 'Uni-AURI: Cleaning orphan worktrees',
              timeout: 15,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: '^Bash$',
          hooks: [
            {
              type: 'command',
              command: `${e}bash -c '[ -f .harness/.framework-edit ] && exit 0; bash .claude/hooks/shared/pre-tool-use-git-guard.sh' || true`,
              statusMessage: 'Uni-AURI: Git guard',
              timeout: 15,
            },
            {
              type: 'command',
              command: `${e}bash -c '[ -f .harness/.framework-edit ] && exit 0; bash .claude/hooks/shared/pre-tool-use-tasks-guard.sh' || true`,
              statusMessage: 'Uni-AURI: Tasks guard',
              timeout: 10,
            },
            {
              type: 'command',
              command: `${e}bash -c '[ -f .harness/.framework-edit ] && exit 0; bash .claude/hooks/shared/pre-commit-state-check.sh' || true`,
              statusMessage: 'Uni-AURI: Commit guard',
              timeout: 10,
            },
          ],
        },
        {
          matcher: 'Edit|Write',
          hooks: [
            {
              type: 'command',
              command: `${e}bash -c '[ -f .harness/.framework-edit ] && exit 0; bash .claude/hooks/shared/pre-tool-use-memory-route-guard.sh' || true`,
              statusMessage: 'Uni-AURI: Memory guard',
              timeout: 10,
            },
          ],
        },
        {
          matcher: 'Task|Agent',
          hooks: [
            {
              type: 'command',
              command: `${e}bash -c '[ -f .harness/.framework-edit ] && exit 0; bash .claude/hooks/shared/pre-tool-use-agent-timestamp.sh' || true`,
              statusMessage: 'Uni-AURI: Agent timestamp',
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `${e}bash .claude/hooks/shared/check-upgrade-prompt.sh || true`,
              statusMessage: 'Uni-AURI: Upgrade check',
              timeout: 10,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: '.*',
          hooks: [
            {
              type: 'command',
              command: `${e}bash -c '[ -f .harness/.framework-edit ] && exit 0; bash .claude/hooks/shared/post-tool-use-agent-usage.sh' || true`,
              statusMessage: 'Uni-AURI: Recording usage',
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
  // 把命令中的字面量 .claude/ 重定位为 $HARNESS_ROOT/，使配置自包含（不再依赖 .claude/）。
  const rel = relocatableHooks(obj);
  // Windows 下 Codex 用 powershell.exe 执行 hook 命令，POSIX 语法（|| / VAR=x cmd / $(pwd)）
  // 无法解析。把整条命令包进 Git for Windows 的 bash -c，PowerShell 只负责拉起 bash。
  return process.platform === 'win32' ? wrapHooksForWindows(rel) : rel;
}

// Windows Git for Windows 常见安装路径（按优先级探测；GIT_BASH_PATH 可显式指定）。
const WINDOWS_GIT_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\msys64\\usr\\bin\\bash.exe',
];

function resolveWindowsGitBash() {
  if (process.env.GIT_BASH_PATH) return process.env.GIT_BASH_PATH;
  for (const p of WINDOWS_GIT_BASH_PATHS) {
    if (existsSync(p)) return p;
  }
  // 兜底：PATH 里解析 bash。排除 WSL 启动器（System32\bash.exe）与 Store 占位符——正是不该用的 bash。
  try {
    const all = execSync('where bash 2>nul', { encoding: 'utf8' }).split(/\r?\n/);
    for (const line of all) {
      const p = line.trim();
      if (!p) continue;
      if (/System32\\|WindowsApps\\/i.test(p)) continue;
      if (existsSync(p)) return p;
    }
  } catch { /* bash not in PATH */ }
  return '';
}

// Windows 下 env 前缀避开双引号：Codex 底层 Rust Command::arg() 会把双引号
// backslash 转义破坏 PowerShell 解析。含空格值用单引号（由外层 PowerShell 单引号
// 串统一转义）；纯 $ 路径值交给 bash 展开，不加引号。
function winEnvPrefix(env) {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => (/\s/.test(v) ? `${k}='${v}'` : `${k}=${v}`))
    .join(' ') + ' ';
}

/**
 * 递归把 hooks.json 里所有 command 字段包进 Windows Git Bash：
 *   & '<git-bash>' -c '<command>'
 * PowerShell 单引号串内单引号用 '' 转义；仅改写 command 字段，不碰 statusMessage 等。
 */
function wrapHooksForWindows(obj) {
  const bashPath = resolveWindowsGitBash() || 'bash';
  const wrap = (cmd) => `& '${bashPath}' -c '${String(cmd).replace(/'/g, "''")}'`;
  const rec = (node, key) => {
    if (key === 'command' && typeof node === 'string') return wrap(node);
    if (Array.isArray(node)) return node.map((x) => rec(x, key));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) out[k] = rec(v, k);
      return out;
    }
    return node;
  };
  return rec(obj, '');
}

/** 递归把 hook 定义里所有 command 字符串的 .claude/ 改为 $HARNESS_ROOT/ */
function relocatableHooks(node) {
  if (Array.isArray(node)) return node.map(relocatableHooks);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = relocatableHooks(v);
    }
    return out;
  }
  if (typeof node === 'string') return relocatable(node);
  return node;
}

/**
 * Codex config.toml（.codex/config.toml）。
 * sandbox / approval_policy 由 backends/utils/context-mapper.js 决定（当前恒为 danger-full-access / never）。
 */
export function codexConfigToml() {
  return `# Project-level Codex configuration
# Codex-only config — does NOT read .claude/settings.json hooks.
# Hooks are in .codex/hooks.json only.

sandbox = "danger-full-access"
approval_policy = "never"

# Enable lifecycle hooks loaded from .codex/hooks.json (Codex requires this flag)
[features]
hooks = true

# Hooks in .codex/hooks.json only (cleaner separation)
# Rules in .codex/rules/default.rules
`;
}
