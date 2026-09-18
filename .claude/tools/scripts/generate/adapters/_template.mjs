// adapters/_template.mjs — 新增 agent 的模板。
// 用法：复制为 adapters/<youragent>.mjs，在 targets.json 的 targets 下加一个块，实现 run(target)。
//
// targets.json 中一个 target 块的字段约定：
//   rootDir        目标 agent 配置根目录，如 ".newagent"
//   backend        HARNESS_BACKEND 取值（传给脚本 env）
//   configFormat   "json" | "toml"
//   configFile     主配置文件路径（如 ".newagent/settings.json"）
//   hooksFile      可选，独立 hooks 文件路径
//   rulesFile      可选，deny 规则文件路径
//   instructionFile 可选，根指令文档（如 "NEWAGENT.md"）
//   denyFormat     "array"（json deny）| "prefix_rule"（codex toml）
//   hookFormat     "claude-json" | "codex-json"
//   skillMode      "copy"（当前仅支持 copy）
//   env            { HARNESS_BACKEND, HARNESS_ROOT, HARNESS_USAGE_DIR, HARNESS_PROJECTS_DIR }
//
// 复用 lib：
//   settings-emit: claudeJsonSettings({env}) | codexHooksJson({env}) | codexConfigToml()
//   deny-emit:     toCodexRulesToml() | toDenyArray()
//   instruction-emit: codebuddyInstruction()（可仿写）
//   copy-assets:   copyAssets(rootDir)
//   common:        writeJson/writeText/REPO_ROOT/frameworkVersion/...

import { join } from 'node:path';
import { REPO_ROOT, writeJson, writeText } from '../lib/common.mjs';
import { claudeJsonSettings, codexHooksJson, codexConfigToml } from '../lib/settings-emit.mjs';
import { toCodexRulesToml, toDenyArray } from '../lib/deny-emit.mjs';
import { copyAssets } from '../lib/copy-assets.mjs';

/**
 * 示例实现：根据 hookFormat / denyFormat 自动选择 emit 函数。
 * 复制后按需裁剪。
 */
export function run(target) {
  const { rootDir, configFile, hooksFile, rulesFile, instructionFile, denyFormat, hookFormat, env } = target;

  if (configFile) {
    if (hookFormat === 'codex-json') {
      writeText(join(REPO_ROOT, configFile), codexConfigToml());
    } else {
      writeJson(join(REPO_ROOT, configFile), claudeJsonSettings({ env }));
    }
  }
  if (hooksFile) {
    writeJson(join(REPO_ROOT, hooksFile), codexHooksJson({ env }));
  }
  if (rulesFile) {
    const text = denyFormat === 'prefix_rule' ? toCodexRulesToml() : JSON.stringify(toDenyArray(), null, 2);
    writeText(join(REPO_ROOT, rulesFile), text);
  }
  if (instructionFile) {
    writeText(join(REPO_ROOT, instructionFile), '# Generated instruction file for ' + rootDir + '\n');
  }
  const copied = copyAssets(rootDir);
  return { rootDir, skills: copied.skills.length, agents: copied.agents.length };
}

export default { run };
