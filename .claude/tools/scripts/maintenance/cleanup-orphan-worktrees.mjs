#!/usr/bin/env node
// cleanup-orphan-worktrees.mjs — 扫描 .harness/.worktrees/ 并清理孤儿 worktree
//
// 何时调用：
//   - SessionStart hook（每次新会话开始）
//   - PM 手动：node cleanup-orphan-worktrees.mjs [--dry-run]
//
// 清理判定（保守策略）：
//   1. worktree 目录在磁盘存在
//   2. 对应的 pipeline-state.json 不存在 → 直接清（孤儿）
//   3. state 存在但 change 不在 implement 阶段 → 清（worktree 已不需要）
//   4. state 存在且在 implement 阶段 → 检查 work item 状态：
//      - in_progress / in_review / implemented → 保留（可能还在跑）
//      - 其他状态 → 清
//
// 输出 JSON：{ scanned, cleaned, retained, errors, details: [] }

import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const PROJECT_ROOT = process.cwd();
const WORKTREES_BASE = join(PROJECT_ROOT, '.harness', '.worktrees');
const TASKS_DIR = join(PROJECT_ROOT, '.harness', 'tasks');

const dryRun = process.argv.includes('--dry-run');
const quiet = process.argv.includes('--quiet');

const RETAINABLE = new Set(['in_progress', 'in_review', 'implemented']);

function log(msg) {
  if (!quiet) process.stderr.write(`[cleanup-orphan-worktrees] ${msg}\n`);
}

function loadState(changeName) {
  const stateFile = join(TASKS_DIR, changeName, 'pipeline-state.json');
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function findWorkItem(state, worktreePath) {
  if (!state || !state.team || !Array.isArray(state.team.work_items)) return null;
  return state.team.work_items.find(wi => wi.worktree_path === worktreePath) || null;
}

function shouldClean(state, workItem, worktreeAbsPath) {
  // 无 state 文件 = 孤儿，直接清
  if (!state) return { clean: true, reason: 'no_pipeline_state' };

  // 不在 implement 阶段 = worktree 不再需要
  if (state.current_phase !== 'implement' || state.mode !== 'team') {
    return { clean: true, reason: `phase=${state.current_phase || '?'}/mode=${state.mode || '?'}` };
  }

  // 在 implement 阶段：检查 work item 状态
  if (!workItem) return { clean: true, reason: 'worktree_path_not_in_state' };

  if (RETAINABLE.has(workItem.status)) {
    return { clean: false, reason: `status=${workItem.status}（保留，可能运行中）` };
  }

  return { clean: true, reason: `status=${workItem.status}` };
}

function rmWorktree(worktreeAbsPath) {
  if (!existsSync(worktreeAbsPath)) return { ok: true, already_gone: true };
  try {
    execSync(`git worktree remove --force "${worktreeAbsPath}"`, { stdio: 'pipe', cwd: PROJECT_ROOT });
    return { ok: true };
  } catch (e) {
    // git worktree remove 失败时 fallback 到 rmSync
    try {
      rmSync(worktreeAbsPath, { recursive: true, force: true });
      return { ok: true, fallback: true };
    } catch (e2) {
      return { ok: false, error: (e2.message || String(e2)).slice(0, 200) };
    }
  }
}

function main() {
  const result = { scanned: 0, cleaned: 0, retained: 0, errors: 0, details: [] };

  if (!existsSync(WORKTREES_BASE)) {
    // 没有任何 worktree 目录，直接返回
    if (!quiet) process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const changes = readdirSync(WORKTREES_BASE, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const changeName of changes) {
    const changeDir = join(WORKTREES_BASE, changeName);
    const state = loadState(changeName);
    const workItems = readdirSync(changeDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const wiName of workItems) {
      const worktreeAbsPath = resolve(join(changeDir, wiName));
      result.scanned++;

      const workItem = findWorkItem(state, worktreeAbsPath);
      const decision = shouldClean(state, workItem, worktreeAbsPath);

      if (!decision.clean) {
        result.retained++;
        result.details.push({ path: worktreeAbsPath, action: 'retain', reason: decision.reason });
        continue;
      }

      if (dryRun) {
        result.details.push({ path: worktreeAbsPath, action: 'would_clean', reason: decision.reason });
        continue;
      }

      const rm = rmWorktree(worktreeAbsPath);
      if (rm.ok) {
        result.cleaned++;
        result.details.push({
          path: worktreeAbsPath,
          action: 'cleaned',
          reason: decision.reason,
          fallback: rm.fallback || false,
          already_gone: rm.already_gone || false,
        });
      } else {
        result.errors++;
        result.details.push({ path: worktreeAbsPath, action: 'error', reason: decision.reason, error: rm.error });
      }
    }

    // 清理空的 change 目录
    if (!dryRun) {
      try {
        const remaining = readdirSync(changeDir);
        if (remaining.length === 0) {
          rmSync(changeDir, { recursive: true, force: true });
        }
      } catch { /* mute */ }
    }
  }

  // git worktree prune
  if (!dryRun && result.cleaned > 0) {
    try {
      execSync('git worktree prune', { stdio: 'pipe', cwd: PROJECT_ROOT });
    } catch { /* mute */ }
  }

  log(`scanned=${result.scanned} cleaned=${result.cleaned} retained=${result.retained} errors=${result.errors}${dryRun ? ' (dry-run)' : ''}`);
  process.stdout.write(JSON.stringify(result) + '\n');
}

main();
