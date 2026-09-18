'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── .harness-projects discovery ──
// Strategy: CWD → ancestor chain → HARNESS_PROJECTS_FILE env（绝对路径）
// collect-all / collect-ai 共用，保证多仓库工作区发现机制一致（issue !239）
function findHarnessProjectsFile(startDir) {
  const fname = process.env.HARNESS_PROJECTS_FILE || '.harness-projects';

  // 1) CWD
  const cwdFile = path.resolve(startDir, fname);
  if (fs.existsSync(cwdFile)) return cwdFile;

  // 2) Ancestor chain (up to root)
  let dir = startDir;
  while (true) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const candidate = path.join(dir, fname);
    if (fs.existsSync(candidate)) return candidate;
  }

  // 3) Env override（绝对路径，避免 path.join(cwd, abs) 拼错）
  if (process.env.HARNESS_PROJECTS_FILE) {
    const envFile = path.resolve(process.env.HARNESS_PROJECTS_FILE);
    if (fs.existsSync(envFile)) return envFile;
  }

  return null;
}

// ── .harness-projects parser ──
// Lines: empty / # comment / ; comment / relative-path / absolute-path

function parseHarnessProjects(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const baseDir = path.dirname(filePath);
  const projects = [];

  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const absPath = path.isAbsolute(line) ? path.resolve(line) : path.resolve(baseDir, line);
    let exists = false;
    let hasHarness = false;
    try {
      const st = fs.statSync(absPath);
      exists = st.isDirectory();
      // 子仓统一用 .harness 作标记（主仓 HARNESS_ROOT/.claude 仅是兜底，兼容旧布局）
      hasHarness = exists && (
        fs.existsSync(path.join(absPath, '.harness')) ||
        fs.existsSync(path.join(absPath, process.env.HARNESS_ROOT || '.claude'))
      );
    } catch (_) { /* stat failed: path doesn't exist */ }

    projects.push({ path: absPath, relative: line, exists, has_harness: hasHarness });
  }

  return projects;
}

// 返回可用的子仓绝对路径列表（collect-ai 补采 pipeline dispatch 用）
function subRepoDirs(startDir) {
  const hpFile = findHarnessProjectsFile(startDir);
  if (!hpFile) return [];
  return parseHarnessProjects(hpFile)
    .filter((p) => p.exists && p.has_harness)
    .map((p) => p.path);
}

module.exports = { findHarnessProjectsFile, parseHarnessProjects, subRepoDirs };
