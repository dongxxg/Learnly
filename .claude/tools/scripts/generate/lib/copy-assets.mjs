// lib/copy-assets.mjs — 把 .claude/ 下的框架目录完整复制到目标 agent 目录。
// 设计约束（install.sh --type）：目标 agent 目录必须是自包含的【真实副本】，不存在指向 .claude/ 的软链接。
// 单事实源仍是 .claude/；每次 generator 运行覆盖同步（rmSync + cpSync / copyDirExcept）。
import { join, sep as SEP } from 'node:path';
import { existsSync, readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { copyDir, copyDirExcept, listDirs, REPO_ROOT } from './common.mjs';

function countEntries(p) {
  if (!existsSync(p)) return 0;
  return readdirSync(p).filter((n) => {
    // 统计角色 .md 文件（不计 extensions 子目录本身的目录条目）
    if (statSync(join(p, n)).isDirectory()) return n === 'extensions';
    return n.endsWith('.md');
  }).length;
}

// 递归统计目录下的所有条目（文件 + 子目录），用于生成报告的准确计数。
// 旧实现只统计一级子目录（listDirs），导致纯文件目录（templates/workflows/reference）
// 显示为 0，掩盖了真实复制状态（issue P2）。
function countAllEntries(p) {
  if (!existsSync(p)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      n++;
      const sp = join(d, name);
      if (statSync(sp).isDirectory()) walk(sp);
    }
  };
  walk(p);
  return n;
}

// 文本文件判定：含 NUL 字节视为二进制跳过；其余按 UTF-8 处理。
// 不再依赖扩展名白名单 —— 这样无扩展名的 git hook（commit-msg / pre-commit /
// pre-push / pre-receive）也能被重写，消除「非 claude 环境脚本里残留 .claude」的盲区。
function isBinary(buf) {
  return buf.includes(0);
}

// ── 框架路径重写 ──────────────────────────────────────────────────────────
// `.claude/` → `$HARNESS_ROOT/` 让生成目录自包含。但以下场景必须保持字面 `.claude/`：
//
//   1. 用户家目录数据路径（~/.claude/projects、~/.claude/usage、$HOME/.claude/…、
//      $user_home/.claude/…）—— 真正的用户数据目录，重写为 $HARNESS_ROOT 会破坏
//      usage/transcript 落盘（变成 $HOME/$HARNESS_ROOT/projects 之类无意义路径）。
//
//   2. 源仓库引用路径（$source/.claude/…、$HARNESS_SOURCE/.claude/…、"$source"/.claude/…）
//      —— setup-harness.sh 从源仓库读模板，源仓库（install.sh 临时 git clone 得到）
//      永远是 `.claude/` 结构（generator 派生发生在 target，不在 source）。
//      重写为 $source/$HARNESS_ROOT/… 在 runtime 会指向不存在的 $source/.codebuddy/
//      等（issue: setup-harness.sh 的 merge_gitattributes / do_install_lite）。
//
// 用负向后顾排除这些前缀。
const USER_HOME_LOOKBEHIND = String.raw`(?<!~\/)(?<!HOME\/)(?<!user_home\/)`;
const SOURCE_REF_LOOKBEHIND = String.raw`(?<!\$source\/)(?<!"\$source"\/)(?<!\$HARNESS_SOURCE\/)(?<!"\$HARNESS_SOURCE"\/)`;

// 把 `.claude/` 字面量重写为 `$HARNESS_ROOT/`，排除用户家目录数据路径与源仓库引用路径。
function rewriteClaudeSlash(text) {
  return text.replace(
    new RegExp(`${USER_HOME_LOOKBEHIND}${SOURCE_REF_LOOKBEHIND}\\.claude\\/`, 'g'),
    '$HARNESS_ROOT/',
  );
}

/**
 * 从 git hook 的 HARNESS_ROOT 探测块里剥掉裸 `.claude` 标记，确保生成的非 Claude
 * 目标里完全不出现 `.claude`：
 *   - 候选目录列表尾部的 ` .claude`（探测循环里的一个候选目录）
 *   - 兜底默认值 `${HARNESS_ROOT:-.claude}` 里的 `.claude`
 * 仅对 hooks/git/* 下文件调用（hooks/shared/* 只剥兜底默认值，见 rewriteFileIfNeeded）。
 */
function stripBareInHook(text) {
  return text
    .replace(/\$\{HARNESS_ROOT:-\.claude\}/g, '${HARNESS_ROOT:-}') // 兜底默认值清零
    .replace(/\s\.claude(?=[\s;]|$)/g, ''); // 移除候选列表尾部 " .claude"
}

/**
 * 把单个文件内容里的框架路径 `.claude/` 重写为 `$HARNESS_ROOT/`（用户家目录数据
 * 路径除外），使生成目录自包含。跳过二进制（含 NUL 字节）。
 *
 * 这是 P1 修复的延伸：之前生成器只重写配置 JSON/TOML 与指令文档，漏掉批量复制的
 * 资产文件内容（如 reference/harness-rules.yaml、hooks/shared/*.sh、tools/*.sh、
 * hooks/git/* 无扩展名 git hook），导致 `.claude/` 字面量残留在目标目录，破坏
 * HARNESS_ROOT≠.claude 时的自包含性。
 *
 * @param {'hook'|'bare'|'entry'|false} mode
 *   - 'hook'   : hooks/git/* —— 额外剥掉探测块的裸 `.claude`（候选列表+兜底默认值）
 *   - 'bare'   : hooks/shared/* —— 只剥掉兜底默认值 `${HARNESS_ROOT:-.claude}`
 *   - 'entry'  : tools/scripts/setup/* —— 入口脚本注入 HARNESS_ROOT 默认值
 *                （需配合 harnessRoot 参数），让独立 bash 脚本不经 settings env 也能跑
 *   - false    : 其它文件 —— 仅做 `.claude/` → `$HARNESS_ROOT/`（用户家目录除外）
 * @param {string} [harnessRoot]  当 mode='entry' 时，注入的默认值（如 '.codex'）
 */
export function rewriteFileIfNeeded(p, mode = false, harnessRoot = null) {
  if (!existsSync(p)) return false;
  let buf;
  try {
    buf = readFileSync(p);
  } catch (_) {
    return false;
  }
  if (isBinary(buf)) return false; // 二进制
  const text = buf.toString('utf8');
  let out = rewriteClaudeSlash(text);
  if (mode === 'hook') out = stripBareInHook(out);
  else if (mode === 'bare') out = out.replace(/\$\{HARNESS_ROOT:-\.claude\}/g, '${HARNESS_ROOT:-}');
  else if (mode === 'entry') out = injectHarnessRootDefault(out, harnessRoot);
  if (harnessRoot && mode !== 'hook' && mode !== 'bare') {
    out = out.replace(/\$\{HARNESS_ROOT:-\.claude\}/g, `\${HARNESS_ROOT:-${harnessRoot}}`);
    // Node 运行入口可能由用户直接执行，不经过 settings/hook env 注入。
    // 将 JS 中的 HARNESS_ROOT 默认目录同步派生到目标 backend，保证自包含。
    out = out.replace(
      /process\.env\.HARNESS_ROOT\s*\|\|\s*(['"])\.claude\1/g,
      `process.env.HARNESS_ROOT || '${harnessRoot}'`,
    );
  }
  if (out === text) return false;
  writeFileSync(p, out, 'utf8');
  return true;
}

/**
 * 在 `set -euo pipefail`（或任意 `set -...u...` 行）后注入 HARNESS_ROOT 默认值。
 *
 * 背景：generator 把 `.claude/` 重写为 `$HARNESS_ROOT/` 让生成目录自包含；`HARNESS_ROOT`
 * 的值本应由 settings.json env 注入。但 `setup-harness.sh` / `sync-settings-hooks.sh`
 * 是独立 bash 脚本——不经 settings.json 的 env 注入链路——直接跑时 `set -u` 下
 * `$HARNESS_ROOT` unbound 立即阻断（issue: setup-harness --check 报 unbound）。
 *
 * 修复策略（design.md Decisions #1/#3）：开头注入一次默认值，其余 `$HARNESS_ROOT`
 * 引用共享它，单点维护，避免每处都 `${HARNESS_ROOT:-.<backend>}` 冗长易漏。
 *
 * 注入条件（全部满足才注入）：
 *   1. 文件含 `set -...u...` 行（有 `-u` flag，unbound 才会阻断）
 *   2. rewriteClaudeSlash 后文件含 `$HARNESS_ROOT` 引用（用得上才注入）
 *   3. 文件不含已有 `HARNESS_ROOT=` 赋值（保留脚本自带探测块，如 setup-hooks.sh）
 *
 * 幂等：含已有 `HARNESS_ROOT="${HARNESS_ROOT:-...}"` 默认赋值时不重复注入。
 *
 * @param {string} text      已经过 rewriteClaudeSlash 处理的文本
 * @param {string} harnessRoot  backend 的 HARNESS_ROOT 值，如 '.codex' / '.codebuddy'
 * @returns {string} 注入后的文本（或原文本，若无须/无法注入）
 */
function injectHarnessRootDefault(text, harnessRoot) {
  if (!harnessRoot) return text;
  // 条件 2：文件不引用 $HARNESS_ROOT → 无意义注入
  if (!text.includes('$HARNESS_ROOT') && !text.includes('${HARNESS_ROOT')) return text;
  // 条件 3：已含 HARNESS_ROOT= 赋值（自带探测块/已注入过） → 保留，不重复
  if (/^[ \t]*(export[ \t]+)?HARNESS_ROOT=/m.test(text)) return text;
  // 条件 1：找 `set -...u...` 行（必须含 u flag 才会因 unbound 阻断）
  const setLineMatch = text.match(/^[ \t]*set[ \t]+-[^\n]*$/m);
  if (!setLineMatch) return text;
  const setLine = setLineMatch[0];
  if (!/[ \t]-[a-zA-Z]*u/.test(setLine)) return text; // set 行无 u flag → 跳过
  // 在 set 行后插入默认值定义
  const setLineIdx = setLineMatch.index;
  const insertAt = setLineIdx + setLine.length;
  const injection =
    '\n\n' +
    '# HARNESS_ROOT 默认值：独立脚本不经 settings.json env 注入，由 generator 按 backend\n' +
    '# 派生（issue: setup-harness.sh --check 报 HARNESS_ROOT: unbound variable）。\n' +
    `HARNESS_ROOT="\${HARNESS_ROOT:-${harnessRoot}}"\n` +
    'export HARNESS_ROOT';
  return text.slice(0, insertAt) + injection + text.slice(insertAt);
}

/**
 * 递归重写 rootDir 下所有文本文件内容的 `.claude/` → `$HARNESS_ROOT/`（用户家目录
 * 数据路径除外）。调用时机：assets 复制完成后。
 *
 * 例外：
 *   - 二进制文件（含 NUL）跳过；
 *   - `templates/gitignore.harness` 不重写 —— 用户要求保留「忽略所有常见 agent
 *     目录」的宽松列表（含 .claude/.codex/.codebuddy/.trae 等），重写为
 *     $HARNESS_ROOT 反而破坏 gitignore 语义（git 不展开 env 变量）；
 *   - `hooks/git/*` 额外剥掉裸 `.claude`（探测块候选/兜底），确保非 Claude 目标
 *     零 `.claude` 引用；
 *   - `hooks/shared/*` 只剥兜底默认值 `${HARNESS_ROOT:-.claude}`（注：git-guard
 *     等含 `\.claude` 框架保护正则的文件已在源码层改为 HARNESS_ROOT 注入，无需
 *     生成器剥裸）；
 *   - `tools/scripts/**` 独立脚本注入 HARNESS_ROOT 默认值——这些是不经 settings.json
 *     env 注入的 bash 脚本，`set -u` 下 `$HARNESS_ROOT` unbound 直接阻断
 *     （issue: setup-harness.sh --check / sync-settings-hooks.sh / submit-harness-issue.sh /
 *      misc/pre-commit-tdd-check.sh 等）。注入由 injectHarnessRootDefault 的 3 个条件
 *     精确门控，幂等且不会覆盖脚本自带的探测块（如 setup-hooks.sh）。
 *
 * @param {string} rootDir      目标 agent 根目录（如 ".codex"）
 * @param {string} [harnessRoot]  backend 的 HARNESS_ROOT 值（如 '.codex'），用于
 *                                'entry' 模式注入；不传则跳过入口注入。
 */
export function rewriteClaudePaths(rootDir, harnessRoot = null) {
  const root = join(REPO_ROOT, rootDir);
  if (!existsSync(root)) return;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (p.endsWith(join('templates', 'gitignore.harness'))) continue;
      const parts = p.split(SEP);
      let mode = false;
      if (parts.includes('hooks')) {
        // git hook 额外剥候选列表里的裸 .claude；shared hook 只剥兜底默认值
        mode = parts.includes('git') ? 'hook' : 'bare';
      } else if (
        harnessRoot &&
        parts.includes('tools') &&
        parts.includes('scripts') &&
        name.endsWith('.sh')
      ) {
        // tools/scripts/**/*.sh 独立脚本：注入 HARNESS_ROOT 默认值
        // （injectHarnessRootDefault 的 3 条件门控：set -u + $HARNESS_ROOT 引用 + 无已有赋值）
        mode = 'entry';
      }
      rewriteFileIfNeeded(p, mode, harnessRoot);
    }
  };
  walk(root);
}

// 需要完整拷贝的框架支持目录（除 tools 需排除子集外，均整目录拷贝）。
const SUPPORT_DIRS = ['hooks', 'backends', 'templates', 'workflows', 'reference'];
const TOOLS_EXCLUDE = ['tests', 'generate'];

/**
 * 把 .claude/rules/*.md（规则文档）拷入 rootDir/rules/。
 *
 * Backend 差异：
 *   - CodeBuddy / Claude Code：自动加载 `.codebuddy/rules/*.md` / `.claude/rules/*.md`
 *     作为项目规则（与 CODEBUDDY.md 同级），复制是必需的。
 *   - Codex：只读 `default.rules`（Starlark 语法），不识别 .md。复制 .md 是噪音，
 *     由调用方传 copyRulesMd=false 跳过。
 *
 * 不动 codex adapter 已生成的 rules/default.rules（扩展名非 .md）。
 */
function copyRulesMd(rootDir) {
  const src = join(REPO_ROOT, '.claude', 'rules');
  const dst = join(REPO_ROOT, rootDir, 'rules');
  if (!existsSync(src)) return 0;
  const files = readdirSync(src).filter((n) => n.endsWith('.md') && statSync(join(src, n)).isFile());
  if (files.length && !existsSync(dst)) mkdirSync(dst, { recursive: true });
  for (const f of files) {
    writeFileSync(join(dst, f), readFileSync(join(src, f)));
  }
  return files.length;
}

/**
 * 拷贝框架支持目录到目标 root（真实副本，无软链接）。
 * @param {string} rootDir
 * @param {object} [opts]
 * @param {boolean} [opts.rulesMd=true]  是否拷贝 rules/*.md（CodeBuddy/Claude 需要，Codex 不需要）
 * @returns {Record<string, number>} 各目录拷入条目数
 */
export function copySupportDirs(rootDir, { rulesMd = true } = {}) {
  const counts = {};
  for (const d of SUPPORT_DIRS) {
    const copied = copyDir(join(REPO_ROOT, '.claude', d), join(REPO_ROOT, rootDir, d));
    counts[d] = copied ? countAllEntries(join(REPO_ROOT, rootDir, d)) : 0;
  }
  // tools 仅拷运行期子集（排除 tests/ 与 generate/ 自身，避免自包含生成器）
  const toolsCopied = copyDirExcept(
    join(REPO_ROOT, '.claude', 'tools'),
    join(REPO_ROOT, rootDir, 'tools'),
    TOOLS_EXCLUDE,
  );
  counts.tools = toolsCopied ? countAllEntries(join(REPO_ROOT, rootDir, 'tools')) : 0;
  // rules/*.md（CodeBuddy/Claude 需要；Codex 跳过——它只读 default.rules）
  counts.rules = rulesMd ? copyRulesMd(rootDir) : 0;
  return counts;
}

/**
 * @param {string} rootDir  目标 agent 根目录（如 ".codebuddy" / ".codex"）
 * @param {object} [opts]
 * @param {boolean} [opts.skills=true]
 * @param {boolean} [opts.agents=true]
 * @param {boolean} [opts.support=true]    是否拷贝 hooks/backends/tools/templates/workflows/reference/rules
 * @param {boolean} [opts.rulesMd=true]    是否拷贝 rules/*.md（CodeBuddy/Claude 需要，Codex 不需要）
 * @param {string}  [opts.harnessRoot=null] backend 的 HARNESS_ROOT 值（如 '.codex'），
 *                                          传给 rewriteClaudePaths 用于入口脚本注入；
 *                                          不传则跳过入口注入（.claude 源仓库无需注入）
 * @returns {{skills: number, agents: number, support?: object}}
 */
export function copyAssets(rootDir, { skills = true, agents = true, support = true, rulesMd = true, harnessRoot = null } = {}) {
  const srcSkills = join(REPO_ROOT, '.claude', 'skills');
  const srcAgents = join(REPO_ROOT, '.claude', 'agents');
  const dstSkills = join(REPO_ROOT, rootDir, 'skills');
  const dstAgents = join(REPO_ROOT, rootDir, 'agents');

  if (skills) copyDir(srcSkills, dstSkills);
  if (agents) copyDir(srcAgents, dstAgents);
  const supportCounts = support ? copySupportDirs(rootDir, { rulesMd }) : undefined;

  // P1 修复：递归重写所有复制进来的文本文件内容，把 `.claude/` 字面量改为
  // `$HARNESS_ROOT/`，保证生成目录自包含（HARNESS_ROOT 运行时指向自身 root）。
  // 需在 copy 之后执行；config 文件由 adapter 在 copyAssets 之前写入，同样被覆盖，
  // 但它们已使用 $HARNESS_ROOT，重写幂等。
  //
  // harnessRoot：入口脚本（tools/scripts/setup/*）注入默认值的 backend 标识，
  // 来自 targets.json 的 env.HARNESS_ROOT；adapter 应传入（.claude 源仓库不传）。
  rewriteClaudePaths(rootDir, harnessRoot);

  return {
    skills: listDirs(dstSkills).length,
    agents: countEntries(dstAgents),
    ...(supportCounts ? { support: supportCounts } : {}),
  };
}
