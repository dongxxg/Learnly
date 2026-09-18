// adapters/codex.mjs — 重新生成 Codex 适配（.codex/* + AGENTS.md）。
// 与现有手写 .codex/* 行为等价，但改由 generator 产出（单一事实源在 .claude/），且完全自包含。
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { REPO_ROOT, writeJson, writeText, readJson } from '../lib/common.mjs';
import { codexHooksJson, codexConfigToml } from '../lib/settings-emit.mjs';
import { toCodexRulesToml } from '../lib/deny-emit.mjs';
import { copyAssets, rewriteFileIfNeeded } from '../lib/copy-assets.mjs';

/**
 * 由 .claude/settings.local.json 生成 .codex/config.local.toml（best-effort）。
 * Codex 无文档化的项目本地覆盖文件，此文件仅供参考/待按实际版本验证。
 */
function codexLocalConfig() {
  const src = join(REPO_ROOT, '.claude', 'settings.local.json');
  if (!existsSync(src)) return null;
  const local = readJson(src);
  const allow = local?.permissions?.allow ?? [];
  const allowComments = allow.map((a) => `#   ${a}`).join('\n');
  return `# Auto-generated from .claude/settings.local.json (development local overrides).
# NOTE: Codex has no documented project-local override file; verify against your Codex version.
# Mirror of Claude Code's permissions.allow (informational — Codex uses approval_policy):
${allowComments || '#   (none)'}

# Permissive approval so local dev is not blocked (matches settings.local.json intent):
approval_policy = "never"
`;
}

/**
 * @param {object} target targets.json 中 codex 的配置块
 */
export function run(target) {
  const { rootDir, configFile, hooksFile, rulesFile, env } = target;

  // 1. config.toml（sandbox / approval_policy）
  if (configFile) writeText(join(REPO_ROOT, configFile), codexConfigToml());

  // 2. hooks.json（复用 .claude/ 脚本 + env 前缀，命令已重定位为 $HARNESS_ROOT/）
  if (hooksFile) writeJson(join(REPO_ROOT, hooksFile), codexHooksJson({ env }));

  // 3. rules/default.rules（deny → prefix_rule TOML）
  if (rulesFile) {
    writeText(join(REPO_ROOT, rulesFile), toCodexRulesToml());
  }

  // 4. 完整复制 skills / agents / 框架支持目录（真实副本，自包含，无软链接指向 .claude/）
  //    rulesMd=false：Codex 只读 default.rules（Starlark，第3步已生成），不识别 .md
  //    harnessRoot 传给 generator，在 tools/scripts/setup/* 入口脚本注入
  //    HARNESS_ROOT="${HARNESS_ROOT:-.codex}" 默认值（独立脚本不经 settings env）。
  const copied = copyAssets(rootDir, { skills: true, agents: true, support: true, rulesMd: false, harnessRoot: env.HARNESS_ROOT });

  // 4.1 清理历史遗留的 .codex/rules/*.md（旧版 generator 误派生；Codex 不读）
  //     default.rules 在第 3 步已写入，这里只清 .md
  const rulesDir = join(REPO_ROOT, rootDir, 'rules');
  if (existsSync(rulesDir)) {
    for (const name of readdirSync(rulesDir)) {
      if (name.endsWith('.md') && statSync(join(rulesDir, name)).isFile()) {
        unlinkSync(join(rulesDir, name));
      }
    }
  }

  // 4.2 把 .claude/rules/*.md 内容拼到 .codex/reference/AGENTS.md 末尾。
  //     原因：Codex 不读 rules/*.md（只读 default.rules Starlark）；但 session-start.sh 会把
  //     reference/AGENTS.md 整体注入会话上下文（line 130），所以把 rules 内容拼到这里，
  //     Codex 会话才能拿到与 CodeBuddy 等价的协作规则。
  //     CodeBuddy 走原生 .codebuddy/rules/*.md 自动加载，不需要拼接。
  const codexAgentsMd = join(REPO_ROOT, rootDir, 'reference', 'AGENTS.md');
  const srcRulesDir = join(REPO_ROOT, '.claude', 'rules');
  if (existsSync(codexAgentsMd) && existsSync(srcRulesDir)) {
    const ruleFiles = readdirSync(srcRulesDir)
      .filter((n) => n.endsWith('.md') && statSync(join(srcRulesDir, n)).isFile())
      .sort();
    if (ruleFiles.length) {
      let base = readFileSync(codexAgentsMd, 'utf8').trimEnd();
      base += '\n\n---\n\n## 项目规则详情（来自 .claude/rules/*.md）\n\n';
      for (const rf of ruleFiles) {
        const content = readFileSync(join(srcRulesDir, rf), 'utf8').trim();
        base += `${content}\n\n---\n\n`;
      }
      writeText(codexAgentsMd, base);
    }
  }

  // 5. 本地覆盖配置（best-effort）
  let localFile = null;
  const localToml = codexLocalConfig();
  if (localToml) {
    localFile = join(rootDir, 'config.local.toml');
    writeText(join(REPO_ROOT, localFile), localToml);
    rewriteFileIfNeeded(join(REPO_ROOT, localFile)); // P1：config.local.toml 在 copyAssets 之后写入
  }

  return {
    config: configFile,
    hooks: hooksFile,
    rules: rulesFile,
    skills: copied.skills,
    agents: copied.agents,
    support: copied.support,
    local: localFile,
  };
}

export default { run };
