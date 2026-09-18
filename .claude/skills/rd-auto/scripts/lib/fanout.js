// lib/fanout.js — Tasks.md parser, worktree integration, fanout plan, complexity detection
import { existsSync, readFileSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { execSync } from 'node:child_process';
import { PROJECT_ROOT, DEFAULT_FANOUT_CONCURRENCY } from './constants.js';

// ─── Tasks.md Parser ───

/**
 * parseTasksMd(changeDir) — parse tasks.md into work_items array.
 * Extracts ## N Title sections and ### N.M Title sub-sections.
 * Sections with sub-sections produce individual work items per sub-section.
 * Sections without sub-sections produce a single work item.
 * Returns [{id, title, parent?}]
 */
export function parseTasksMd(changeDir) {
  const tasksPath = join(changeDir, 'tasks.md');
  if (!existsSync(tasksPath)) return [];
  const content = readFileSync(tasksPath, 'utf8');
  const lines = content.split('\n');

  const sections = [];
  let currentSection = null;
  let inHtmlComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Multi-line HTML comment tracking
    if (inHtmlComment) {
      if (trimmed.includes('-->')) inHtmlComment = false;
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inHtmlComment = true;
      continue;
    }

    // Skip blank lines
    if (trimmed === '') continue;

    // C008: accept period or whitespace after number (## 1. Title or ## 1 Title)
    const topMatch = line.match(/^## (\d+)[.\s]\s*(.+)/);
    const subMatch = line.match(/^### (\d+\.\d+)[.\s]\s*(.+)/);

    if (topMatch) {
      currentSection = { id: `WI-${topMatch[1]}`, title: topMatch[2].trim(), items: [] };
      sections.push(currentSection);
    } else if (subMatch && currentSection) {
      currentSection.items.push({ id: `WI-${subMatch[1]}`, title: subMatch[2].trim() });
    }
  }

  // Flatten: sections with sub-items → each sub-item as work_item; otherwise → section as work_item
  const workItems = [];
  for (const sec of sections) {
    if (sec.items.length > 0) {
      for (const sub of sec.items) {
        workItems.push({ id: sub.id, title: sub.title, parent: sec.id });
      }
    } else {
      workItems.push({ id: sec.id, title: sec.title });
    }
  }
  return workItems;
}

// ─── Worktree Artifact Integration ───

/**
 * integrateWorktreeArtifacts(changeName, workItems)
 * Copy artifact files from worktree paths to the main repository.
 * Skips missing source files (with warning). Creates target dirs as needed.
 * Last-writer-wins on path overlap (with warning).
 */
export function integrateWorktreeArtifacts(changeName, workItems) {
  const mainRoot = PROJECT_ROOT;
  const seenPaths = new Map(); // relPath -> work_item_id
  const warnings = [];

  // team mode 终态是 reviewed（developer→implemented→reviewer→reviewed），不存在 'done' 状态；
  // 旧代码用 'done' 过滤导致 artifact 永不复制
  for (const wi of workItems) {
    if (wi.status !== 'reviewed' || !wi.artifact_paths || !wi.artifact_paths.length) continue;
    const worktreeRoot = wi.worktree_path;
    if (!worktreeRoot) continue;

    for (const relPath of wi.artifact_paths) {
      // Check overlap
      if (seenPaths.has(relPath)) {
        const prevWi = seenPaths.get(relPath);
        const msg = `artifact path overlap: ${relPath} from ${wi.id} overwrites ${prevWi}`;
        process.stderr.write(`[integrateWorktreeArtifacts] WARNING: ${msg}\n`);
        warnings.push(msg);
      }
      seenPaths.set(relPath, wi.id);

      const src = join(worktreeRoot, relPath);
      const dst = join(mainRoot, relPath);

      // P1-SEC-01a: source path traversal guard
      const resolvedSrc = resolve(src);
      if (!resolvedSrc.startsWith(resolve(worktreeRoot) + sep) && resolvedSrc !== resolve(worktreeRoot)) {
        const msg = `source path traversal blocked: ${relPath} resolves to ${resolvedSrc} (outside ${worktreeRoot}), skipping (from ${wi.id})`;
        process.stderr.write(`[integrateWorktreeArtifacts] WARNING: ${msg}\n`);
        warnings.push(msg);
        continue;
      }

      // P1-SEC-01b: destination path traversal guard
      const resolvedDst = resolve(dst);
      if (!resolvedDst.startsWith(resolve(mainRoot) + sep) && resolvedDst !== resolve(mainRoot)) {
        const msg = `path traversal blocked: ${relPath} resolves to ${resolvedDst} (outside ${mainRoot}), skipping (from ${wi.id})`;
        process.stderr.write(`[integrateWorktreeArtifacts] WARNING: ${msg}\n`);
        warnings.push(msg);
        continue;
      }

      if (!existsSync(src)) {
        const msg = `source file missing, skipping: ${src} (from ${wi.id})`;
        process.stderr.write(`[integrateWorktreeArtifacts] WARNING: ${msg}\n`);
        warnings.push(msg);
        continue;
      }

      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
  return warnings;
}

// ─── Fanout Dispatch Plan Builder ───

/**
 * fanoutDispatchPlan(state)
 * Build the next batch of agents from available work_items.
 * Priority: implement (available) first, then review (implemented) items.
 * Returns { agents: [...], remaining_count: N }
 */
export function fanoutDispatchPlan(state) {
  const workItems = state.team.work_items || [];
  const maxConcurrent = Math.max(1, state.team.max_concurrent || DEFAULT_FANOUT_CONCURRENCY);

  // Count currently in-progress agents
  const inProgress = workItems.filter(wi => wi.status === 'in_progress' || wi.status === 'in_review').length;
  const slots = maxConcurrent - inProgress;
  if (slots <= 0) return { agents: [], remaining_count: 0 };

  // Priority 1: available work-items → implement
  const available = workItems.filter(wi => wi.status === 'available');
  // Priority 2: implemented work-items → review
  const implemented = workItems.filter(wi => wi.status === 'implemented');
  // Priority 3: review-rework items → implement (rework)
  const rework = workItems.filter(wi => wi.status === 'review_rework');

  const agents = [];
  let remaining = slots;

  // Dispatch implements first (higher priority)
  for (const wi of available) {
    if (remaining <= 0) break;
    agents.push({ work_item_id: wi.id, role: 'developer', description: wi.title });
    remaining--;
  }

  // Dispatch reworks before initial reviews (review_rework → implement)
  for (const wi of rework) {
    if (remaining <= 0) break;
    agents.push({ work_item_id: wi.id, role: 'developer', description: `[返工] ${wi.title}`, rework_context: wi.rework_context });
    remaining--;
  }

  // Dispatch reviews for implemented items
  for (const wi of implemented) {
    if (remaining <= 0) break;
    agents.push({ work_item_id: wi.id, role: 'reviewer', description: `[增量review] ${wi.title}`, review_target: wi.id });
    remaining--;
  }

  return {
    agents,
    remaining_count: available.length + implemented.length + rework.length - agents.length,
  };
}

// ─── Worktree Management ───

/**
 * createWorktrees(changeName, agents) — 为每个 agent 创建独立 git worktree
 *
 * 路径：.harness/.worktrees/<changeName>/<wi-id>/
 * 基引用：HEAD（detached HEAD 模式）
 * 单 worktree 创建失败不阻塞其他，失败项附加 error 字段
 *
 * @param {string} changeName
 * @param {Array<{work_item_id: string, role: string, description: string}>} agents
 * @returns {Array} agents 数组（附加 worktree_path 字段，失败项附加 error 字段）
 */
export function createWorktrees(changeName, agents) {
  const baseDir = join(PROJECT_ROOT, '.harness', '.worktrees', changeName);
  mkdirSync(baseDir, { recursive: true });

  return agents.map(agent => {
    const worktreePath = join(baseDir, agent.work_item_id);

    // C007: reuse existing worktree for ANY role (not just reviewer).
    // - reviewer needs to see developer's implementation
    // - developer rework needs to see first implementation (not rewrite from HEAD)
    // - cleanupOrphanWorktrees doesn't clean 'implemented' status, so worktree survives
    if (existsSync(worktreePath)) {
      return { ...agent, worktree_path: worktreePath };
    }

    // Worktree doesn't exist → create new (detached HEAD)
    try {
      execSync(`git worktree add --detach "${worktreePath}" HEAD`, { stdio: 'pipe', cwd: PROJECT_ROOT });
      return { ...agent, worktree_path: worktreePath };
    } catch (e) {
      const errMsg = (e.stderr || e.message || String(e)).split('\n')[0].slice(0, 200);
      process.stderr.write(`[createWorktrees] FAILED: work_item_id=${agent.work_item_id}, path=${worktreePath}, error=${errMsg}\n`);
      return { ...agent, worktree_path: null, error: `worktree create failed: ${errMsg}` };
    }
  });
}

/**
 * cleanupWorktrees(changeName, workItems) — 清理已完成的 worktree
 *
 * 遍历 status === 'reviewed' 的 work_item，执行 git worktree remove --force
 * 单清理失败不阻塞其他，输出 warning 日志
 *
 * @param {string} changeName
 * @param {Array<{id: string, status: string, worktree_path: string}>} workItems
 * @returns {Array<{id: string, cleaned: boolean, error?: string}>} 清理结果数组
 */
export function cleanupWorktrees(changeName, workItems) {
  const results = [];

  for (const wi of workItems) {
    if (wi.status !== 'reviewed' || !wi.worktree_path) continue;
    try {
      if (existsSync(wi.worktree_path)) {
        execSync(`git worktree remove --force "${wi.worktree_path}"`, { stdio: 'pipe', cwd: PROJECT_ROOT });
      }
      results.push({ id: wi.id, cleaned: true });
    } catch (e) {
      const errMsg = (e.stderr || e.message || String(e)).split('\n')[0].slice(0, 200);
      process.stderr.write(`[cleanupWorktrees] WARNING: failed to remove worktree for ${wi.id} (${wi.worktree_path}): ${errMsg}\n`);
      results.push({ id: wi.id, cleaned: false, error: errMsg });
    }
  }

  // 清理空的 change 目录（在 worktree 目录全部移除后）
  const changeDir = join(PROJECT_ROOT, '.harness', '.worktrees', changeName);
  try {
    if (existsSync(changeDir)) {
      const remaining = readdirSync(changeDir);
      if (remaining.length === 0) {
        rmSync(changeDir, { recursive: true, force: true });
      }
    }
  } catch { /* mute */ }

  // prune 清理 .git/worktrees 中的残留引用
  try {
    execSync('git worktree prune', { stdio: 'pipe', cwd: PROJECT_ROOT });
  } catch { /* mute */ }

  return results;
}

/**
 * cleanupOrphanWorktrees(changeName, workItems) — advance 入口 orphan 检测
 *
 * 清理安全范围内的 stale worktree（不破坏 artifact 集成）：
 *   - blocked / blocked_permanent：agent 已熔断，artifact 无效
 *   - available 但 worktree_path != null：state 已重置，路径悬空
 *   - reviewed：artifact 已被 integrateWorktreeArtifacts 复制（如已执行）
 *
 * 不清理（保留）：
 *   - in_progress / in_review：可能 agent 还在跑
 *   - implemented：等 reviewer
 *
 * 同步将 worktree_path 置 null，避免后续 createWorktrees 误判。
 *
 * @returns {Array<{id: string, cleaned: boolean, reason: string, error?: string}>}
 */
export function cleanupOrphanWorktrees(changeName, workItems) {
  const CLEANABLE = new Set(['blocked', 'blocked_permanent', 'available', 'reviewed']);
  const results = [];

  for (const wi of workItems || []) {
    if (!wi.worktree_path) continue;
    if (!CLEANABLE.has(wi.status)) continue;

    // available 状态下 worktree_path 不为 null 才算悬空（正常 rework 时已置 null）
    if (wi.status === 'available' && !existsSync(wi.worktree_path)) {
      // 路径已不存在，仅清指针
      wi.worktree_path = null;
      results.push({ id: wi.id, cleaned: true, reason: 'stale_pointer_only' });
      continue;
    }

    let cleaned = false;
    let error = null;
    if (existsSync(wi.worktree_path)) {
      try {
        execSync(`git worktree remove --force "${wi.worktree_path}"`, { stdio: 'pipe', cwd: PROJECT_ROOT });
        cleaned = true;
      } catch (e) {
        error = (e.stderr || e.message || String(e)).split('\n')[0].slice(0, 200);
        process.stderr.write(`[cleanupOrphanWorktrees] WARNING: ${wi.id} (${wi.worktree_path}): ${error}\n`);
      }
    } else {
      // 目录已不存在，视为已清理
      cleaned = true;
    }

    // 不管 remove 是否成功，状态终态时都置 null（避免下次再尝试删除已不存在的目录）
    if (wi.status !== 'available' || cleaned) {
      wi.worktree_path = null;
    }
    results.push({ id: wi.id, cleaned, reason: wi.status, error });
  }

  // 清理空的 change 目录
  const changeDir = join(PROJECT_ROOT, '.harness', '.worktrees', changeName);
  try {
    if (existsSync(changeDir)) {
      const remaining = readdirSync(changeDir);
      if (remaining.length === 0) {
        rmSync(changeDir, { recursive: true, force: true });
      }
    }
  } catch { /* mute */ }

  try {
    execSync('git worktree prune', { stdio: 'pipe', cwd: PROJECT_ROOT });
  } catch { /* mute */ }

  return results;
}

// ─── Determine Complexity ───

export function determineComplexity(changeName) {
  const changeDir = join(PROJECT_ROOT, '.harness', 'spec', 'changes', changeName);
  const searchPaths = [
    join(changeDir, 'design.md'),
    join(changeDir, 'proposal.md'),
    join(changeDir, '.openspec.yaml'),
  ];
  for (const p of searchPaths) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf8');
    const match = content.match(/(?:complexity|复杂度)\s*[:：]\s*(S|M|L|XL)/i);
    if (match) return match[1].toUpperCase();
  }
  return 'M'; // default: run design-review
}
