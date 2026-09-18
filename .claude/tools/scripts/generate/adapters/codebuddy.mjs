// adapters/codebuddy.mjs — 生成 CodeBuddy 适配（.codebuddy/）。
import { join } from 'node:path';
import { REPO_ROOT, writeJson, copyFile } from '../lib/common.mjs';
import { claudeJsonSettings } from '../lib/settings-emit.mjs';
import { copyAssets, rewriteFileIfNeeded } from '../lib/copy-assets.mjs';

/**
 * @param {object} target targets.json 中 codebuddy 的配置块
 */
export function run(target) {
  const { rootDir, configFile, env } = target;

  // 1. settings.json（permissions/hooks/env/statusLine，hook 命令已重定位为 $HARNESS_ROOT/）
  //    CodeBuddy 规范：去掉 Claude 专属 `if` 字段，SessionStart matcher 改为 startup|resume|clear|compact
  //    statusLine 子进程不继承 settings.env，故传 targetRoot 让生成器内联 .codebuddy/ 的绝对路径。
  const settings = claudeJsonSettings({
    env,
    targetRoot: rootDir,
    transforms: { stripIf: true, sessionStartMatcher: 'startup|resume|clear|compact' },
  });
  writeJson(join(REPO_ROOT, configFile), settings);

  // 2. 完整复制 skills / agents / 框架支持目录（真实副本，自包含，无软链接指向 .claude/）
  //    harnessRoot 传给 generator，在 tools/scripts/setup/* 入口脚本注入
  //    HARNESS_ROOT="${HARNESS_ROOT:-.codebuddy}" 默认值（独立脚本不经 settings env）。
  const copied = copyAssets(rootDir, { skills: true, agents: true, support: true, harnessRoot: env.HARNESS_ROOT });

  // 3. 本地覆盖配置（permissions.allow 等开发便捷项）
  const localSrc = join(REPO_ROOT, '.claude', 'settings.local.json');
  const localDst = join(REPO_ROOT, rootDir, 'settings.local.json');
  if (copyFile(localSrc, localDst)) {
    rewriteFileIfNeeded(localDst); // P1：settings.local.json 在 copyAssets 之后写入，单独重写
    copied.local = localDst;
  }

  return {
    config: configFile,
    skills: copied.skills,
    agents: copied.agents,
    support: copied.support,
    local: copied.local,
  };
}

export default { run };
