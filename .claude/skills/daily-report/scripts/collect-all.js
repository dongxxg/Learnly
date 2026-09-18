'use strict';

// collect-all.js — Multi-repo data collection orchestrator (cross-platform)
//
// Replaces collect-all.sh. Built-in .harness-projects discovery + parsing (no bash dependency).
// Windows / macOS / Linux compatible.
//
// Usage: node collect-all.js --date <YYYY-MM-DD> --user <name> --output-dir <dir> [--project-dir <path>]
//
// Output (stdout JSON):
//   { ok, date, user, output_dir, git_files, ai_files, repos, git_arg, ai_arg }

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('./lib/argv');
const { findHarnessProjectsFile, parseHarnessProjects } = require('./lib/harness-projects');

// ── Safe subprocess call ──
// Returns true if the collection script succeeded and output was written to outputFile.

function safeCollect(scriptPath, args, outputFile) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, stdout, 'utf-8');
    return true;
  } catch (e) {
    process.stderr.write(`[collect-all] ${path.basename(scriptPath)} failed (${args.join(' ')}): ${e.message.trim()}\n`);
    return false;
  }
}

// ── Main ──

function main() {
  const args = parseArgs(process.argv, {
    options: { date: '', user: '', 'output-dir': '', 'project-dir': '' },
  });

  const opts = args.options;
  if (!opts.date || !opts.user || !opts['output-dir']) {
    process.stderr.write('Usage: collect-all.js --date <YYYY-MM-DD> --user <name> --output-dir <dir> [--project-dir <path>]\n');
    process.exit(1);
  }

  const date = opts.date;
  const user = opts.user;
  const outDir = path.resolve(opts['output-dir']);

  // Switch to project dir if specified
  if (opts['project-dir']) {
    try {
      process.chdir(path.resolve(opts['project-dir']));
    } catch (e) {
      process.stderr.write(`[collect-all] failed to chdir to "${opts['project-dir']}": ${e.message}\n`);
      process.exit(1);
    }
  }

  const currentCwd = process.cwd();
  // Scripts are siblings in the same directory
  const collectGit = path.join(__dirname, 'collect-git.js');
  const collectAi = path.join(__dirname, 'collect-ai.js');

  fs.mkdirSync(outDir, { recursive: true });

  const currentRepo = path.basename(currentCwd);
  const gitFiles = [];
  const aiFiles = [];
  const repos = [];

  // Collect current repo
  const gitFile = path.join(outDir, `${date}-${user}.${currentRepo}.git.json`);
  const aiFile = path.join(outDir, `${date}-${user}.${currentRepo}.ai.json`);

  if (safeCollect(collectGit, [`--date=${date}`, `--user=${user}`], gitFile)) {
    gitFiles.push(gitFile);
    repos.push(currentRepo);
  }
  // Issue !180/!182/!195: collect-ai 只在主仓跑一次。
  // 原因：collect-ai.js 的 collectUsageJsonl / collectSessionTokens 读全局
  // ~/.claude/usage/usage.jsonl 和所有本地 session transcript，与 cwd 无关——
  // 给每个子仓跑一遍会把全局数据累加 N 倍（N=子仓数）。
  // git 数据是仓库特定的，仍按子仓各自采集。
  if (safeCollect(collectAi, [`--date=${date}`, `--user=${user}`], aiFile)) {
    aiFiles.push(aiFile);
  }

  // Discover sub-repos via .harness-projects
  const hpFile = findHarnessProjectsFile(currentCwd);
  if (hpFile) {
    const projects = parseHarnessProjects(hpFile);
    // Issue !180/!213: 同仓库多 worktree 去重——worktree 共享 .git 对象，commit 会被
    // collect-git.js 重复计入 N 次。
    // 修复：只在 .harness 物理路径重复时跳过（而非 .git 路径）。
    // worktree 各自有独立的 .harness/tasks/ 目录，同 common-dir 不代表数据重复。
    const seenHarnessDirs = new Set();
    // 主仓的 .harness 路径也加入，避免子仓里再次采到主仓
    const mainHarness = path.resolve(currentCwd, '.harness');
    seenHarnessDirs.add(mainHarness);

    for (const proj of projects) {
      if (!proj.exists || !proj.has_harness) continue;

      // worktree 去重：按 .harness 物理路径去重
      const projHarness = path.resolve(proj.path, '.harness');
      if (seenHarnessDirs.has(projHarness)) {
        process.stderr.write(`[collect-all] skip worktree duplicate: ${proj.path} (.harness ${projHarness} 已采)\n`);
        continue;
      }
      seenHarnessDirs.add(projHarness);

      const subName = path.basename(proj.path);
      const subGitFile = path.join(outDir, `${date}-${user}.${subName}.git.json`);

      if (safeCollect(collectGit, [`--date=${date}`, `--user=${user}`, `--cwd=${proj.path}`], subGitFile)) {
        gitFiles.push(subGitFile);
        repos.push(subName);
      }
      // 子仓不跑 collect-ai（全局数据，主仓已采过）
    }
  }

  // Output result JSON (single line to stdout)
  process.stdout.write(JSON.stringify({
    ok: true,
    date,
    user,
    output_dir: outDir,
    git_files: gitFiles,
    ai_files: aiFiles,
    repos,
    git_arg: gitFiles.map(f => '@' + f).join('\n'),
    ai_arg: aiFiles.map(f => '@' + f).join('\n'),
  }) + '\n');
}

main();
