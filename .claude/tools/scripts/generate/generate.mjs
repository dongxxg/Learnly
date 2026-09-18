#!/usr/bin/env node
// generate.mjs — Uni-AURI 多 agent 配置生成器（编排器）。
//
// 事实源：.claude/（settings.json / skills / agents / hooks / reference）
// 产出：每个 target agent 的配置/挂钩/技能/角色/插件（见 targets.json）。
//
// 用法：
//   node generate.mjs                 # 生成全部 target
//   node generate.mjs codebuddy       # 仅生成 codebuddy
//   node generate.mjs codex           # 仅生成 codex
//   node generate.mjs codebuddy codex # 指定多个
//
// 新增 agent：在 targets.json 加一个块 + 复制 adapters/_template.mjs 为 adapters/<name>.mjs。

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readJson } from './lib/common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const targets = argv.filter((a) => !a.startsWith('-'));
  const flags = argv.filter((a) => a.startsWith('-'));
  return { targets, quiet: flags.includes('--quiet') || flags.includes('-q') };
}

async function main() {
  const argv = process.argv.slice(2);
  const { targets: requested, quiet } = parseArgs(argv);

  const manifest = readJson(join(HERE, 'targets.json'));
  const allTargets = Object.keys(manifest.targets);
  const wanted = requested.length ? requested : allTargets;

  const unknown = wanted.filter((t) => !allTargets.includes(t));
  if (unknown.length) {
    console.error(`[generate] 未知 target: ${unknown.join(', ')}。可选: ${allTargets.join(', ')}`);
    process.exit(2);
  }

  const summary = [];
  for (const name of wanted) {
    const target = manifest.targets[name];
    const adapterPath = join(HERE, 'adapters', `${name}.mjs`);
    if (!existsSync(adapterPath)) {
      console.error(`[generate] 缺少适配器: ${adapterPath}`);
      process.exit(3);
    }
    const mod = await import(`./adapters/${name}.mjs`);
    const fn = mod.run || (mod.default && mod.default.run);
    if (typeof fn !== 'function') {
      console.error(`[generate] 适配器 ${name} 未导出 run()`);
      process.exit(4);
    }
    const result = fn(target);
    summary.push({ target: name, ...result });
    if (!quiet) {
      console.log(`[generate] ✓ ${name}: ${JSON.stringify(result)}`);
    }
  }

  if (!quiet) {
    console.log(`\n[generate] 完成。事实源: .claude/ → 生成 ${wanted.length} 个 agent 配置。`);
    console.log(`[generate] 验证: node --check generate.mjs && bash -n .claude/hooks/shared/*.sh`);
  }
  return summary;
}

main().catch((err) => {
  console.error('[generate] 失败:', err);
  process.exit(1);
});
