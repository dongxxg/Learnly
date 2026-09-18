// adapters/qoder.mjs — generate the Qoder CN CLI project adapter (.qoder/).
import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { REPO_ROOT, copyFile, writeJson } from '../lib/common.mjs';
import { qoderJsonSettings } from '../lib/settings-emit.mjs';
import { copyAssets } from '../lib/copy-assets.mjs';

function inlineQoderRootInMarkdown(rootDir) {
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

/** @param {object} target targets.json qoder configuration */
export function run(target) {
  const { rootDir, configFile, env } = target;
  writeJson(join(REPO_ROOT, configFile), qoderJsonSettings({ env }));

  const copied = copyAssets(rootDir, {
    skills: true,
    agents: true,
    support: true,
    rulesMd: true,
    harnessRoot: env.HARNESS_ROOT,
  });

  // Qoder loads .qoder/rules/**/*.md natively. Include the framework's core
  // collaboration rules in addition to the topic rules copied by copyAssets.
  const frameworkRule = join(REPO_ROOT, rootDir, 'rules', '00-uni-auri.md');
  copyFile(join(REPO_ROOT, '.claude', 'reference', 'AGENTS.md'), frameworkRule);
  const frameworkRuleSource = readFileSync(frameworkRule, 'utf8');
  writeFileSync(frameworkRule, frameworkRuleSource.replaceAll('.claude/', `${rootDir}/`), 'utf8');

  // Qoder 没有文档化的项目级 env。Markdown 会被直接注入模型上下文，
  // 因而把裸 `$HARNESS_ROOT/` 固化为 `.qoder/`；shell/JS 文件仍使用 hook 前缀 env。
  inlineQoderRootInMarkdown(rootDir);

  return {
    config: configFile,
    skills: copied.skills,
    agents: copied.agents,
    support: copied.support,
  };
}

export default { run };
