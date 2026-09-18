'use strict';

// Shared kanban markdown parser.
//
// Both kanban-update.js (writes the kanban mirror JSON) and collect-kanban.js
// (fetches remote md for daily-report consumption) used to ship their own
// table parsers. Field names had already drifted between the two
// (task_id vs id, section vs main_chain, is_risk vs urgency).
//
// This module is the single source of truth for turning kanban md into
// KanbanTask[] (aligned with kanban-task.schema.json). Both consumers now
// require() it and add their own secondary shaping on top.
//
// Key design decision (N-3 fix): values are located by HEADER COLUMN NAME,
// not by heuristic scanning of every cell in a row. Previously, a notes
// cell containing "5/8" could be mistaken for a deadline, or a notes cell
// containing "🔴" could be mistaken for status. Column-name lookup eliminates
// that class of bugs.

const STATUS_EMOJIS = ['✅', '🔵', '🟡', '🔴', '⬜'];

// Task ID variants recognized in the first column of a task row.
//   PA-01 / S0-01 / D-29 / D-12a / BP-00 / E2E-01 / PG-01 / H-06 / R-01 ...
const TASK_ID_RE = /^([A-Z][A-Z0-9]{0,3}-\d+[a-z]?)(?=\s|$)/;

// Skip sections: risk registry, blocker registry. Their tables look like
// task tables but must not be counted as Sprint work.
const SKIP_SECTION_RE = /^##\s+(风险|风险登记簿|风险与阻塞|阻塞)/;

// --- Helpers ---

function detectStatusEmoji(cell) {
  if (!cell) return '';
  for (const e of STATUS_EMOJIS) {
    if (cell.includes(e)) return e;
  }
  return '';
}

// Split "张三+李四" / "张三,李四" / "张三、李四" into ["张三","李四"]
function splitOwners(ownerCell) {
  if (!ownerCell) return [];
  return ownerCell
    .split(/[+,/，、\s]+/)
    .map((s) => s.replace(/\*\*/g, '').trim())
    .filter(Boolean);
}

// Column-name → index lookup. Tries multiple aliases per logical column.
const COLUMN_ALIASES = {
  id: ['#', '编号', '任务编号', 'id'],
  task: ['任务', '任务描述', '描述'],
  owner: ['owner', '执行者', '责任人', '负责人'],
  deadline: ['deadline', '截止日期', '截止'],
  status: ['状态'],
  main_chain: ['主线', '主链', '工作域'],
  notes: ['备注', '说明'],
  urgency: ['紧急度', '优先级'],
};

function buildColumnIndex(headers) {
  const idx = {};
  for (const [logical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const found = headers.findIndex((h) => h === alias || h.includes(alias));
      if (found !== -1) {
        idx[logical] = found;
        break;
      }
    }
  }
  return idx;
}

function cellAt(row, idx) {
  return idx !== undefined && idx >= 0 && idx < row.length ? (row[idx] || '').trim() : '';
}

// --- Block-based parser ---
//
// Walk lines tracking Sprint (## header) and main_chain (### header).
// When a contiguous run of '|' lines is found, hand the whole block to
// processTableBlock which resolves columns by header name and emits tasks.
function parseKanbanMd(mdContent, options = {}) {
  const opts = {
    extractUrgency: options.extractUrgency !== false, // default true
    year: options.year || new Date().getFullYear(),
  };

  const lines = mdContent.split('\n');
  const tasks = [];
  const sprintStats = {};
  const ownerStats = {};
  const chainStats = {};

  let currentSprint = '';
  let currentMainChain = '';
  let inSkipSection = false;
  let lastValidColIdx = null;
  const warnings = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      const heading = h2[1].trim();
      if (SKIP_SECTION_RE.test(line)) {
        inSkipSection = true;
        currentSprint = '';
        currentMainChain = '';
      } else {
        inSkipSection = false;
        const sprintM = heading.match(/Sprint\s*(\d+)/i);
        if (sprintM) {
          currentSprint = `Sprint ${sprintM[1]}`;
        } else {
          const s0style = heading.match(/^S(\d+)\s/);
          currentSprint = s0style ? `Sprint ${s0style[1]}` : '';
        }
        currentMainChain = '';
      }
      i++;
      continue;
    }

    const h3 = line.match(/^###\s+(.+)/);
    if (h3) {
      if (!inSkipSection) {
        currentMainChain = h3[1].trim();
        // ### headers indicate a new sub-section with its own table header.
        // Clear the cached column index to avoid reusing a stale header.
        lastValidColIdx = null;
      }
      i++;
      continue;
    }

    if (inSkipSection) {
      if (line === '---') inSkipSection = false;
      i++;
      continue;
    }

    if (!line.startsWith('|')) {
      i++;
      continue;
    }

    // Gather the contiguous table block starting here.
    const blockLines = [];
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      blockLines.push(lines[i].trim());
      i++;
    }
    processTableBlock(blockLines, {
      currentSprint,
      currentMainChain,
      extractUrgency: opts.extractUrgency,
      tasks,
      sprintStats,
      ownerStats,
      chainStats,
      _lastColIdx: lastValidColIdx,
      _setLastColIdx: (v) => { lastValidColIdx = v; },
      _warnings: warnings,
    });
  }

  return {
    tasks,
    stats: {
      sprint_stats: sprintStats,
      owner_stats: ownerStats,
      chain_stats: chainStats,
    },
    warnings,
  };
}

function processTableBlock(blockLines, ctx) {
  if (blockLines.length < 1) return;

  // Quick scan: if no row in this block matches a task ID pattern,
  // it's a summary/overview table — skip silently, no structural check.
  const hasTaskRow = blockLines.some((line) => {
    const firstCell = (line.split('|')[1] || '').trim();
    return TASK_ID_RE.test(firstCell);
  });
  if (!hasTaskRow) return;

  const headers = blockLines[0]
    .split('|')
    .slice(1, -1)
    .map((c) => c.toLowerCase().replace(/^#+\s*/, '').trim());
  let colIdx = buildColumnIndex(headers);
  let dataStartRow = 1;

  if (colIdx.id === undefined || colIdx.owner === undefined || colIdx.status === undefined) {
    // First row isn't a recognized task-table header (e.g. data rows directly
    // under ## Sprint without a |#|任务|...| header). Fall back to the last
    // successfully parsed header from this sprint/sub-section.
    const firstDataLine = blockLines[0] || '';
    if (!ctx._lastColIdx) {
      // No fallback available — tasks in this block are silently lost.
      // This is a structural defect that must be fixed.
      ctx._warnings.push(
        `[${ctx.currentSprint || '?'}][${ctx.currentMainChain || '无小节标题'}] ` +
        `表格缺少表头行（#/任务/Owner/Deadline/状态/备注），且无上一个表头可回退，` +
        `该表格块 ${blockLines.length} 行任务数据被跳过。` +
        `首行: ${firstDataLine.slice(0, 80)}`
      );
      return;
    }
    colIdx = ctx._lastColIdx;
    dataStartRow = 0;
    ctx._warnings.push(
      `[${ctx.currentSprint || '?'}][${ctx.currentMainChain || '无小节标题'}] ` +
      `表格缺少表头行（#/任务/Owner/Deadline/状态/备注），已回退到上一个表头解析。` +
      `首行数据: ${firstDataLine.slice(0, 80)}`
    );
  } else {
    const saved = { ...colIdx };
    ctx._setLastColIdx(saved);
  }

  for (let r = dataStartRow; r < blockLines.length; r++) {
    const row = blockLines[r].split('|').slice(1, -1).map((c) => c.trim());
    if (row.every((c) => /^[-:\s]*$/.test(c))) continue; // separator

    const idCell = cellAt(row, colIdx.id);
    const m = idCell.match(TASK_ID_RE);
    if (!m) continue;
    const id = m[1];
    const status = detectStatusEmoji(cellAt(row, colIdx.status));
    if (!status) continue; // not an actionable task row

    const ownerCell = cellAt(row, colIdx.owner);
    const owners = splitOwners(ownerCell);
    const taskName = cellAt(row, colIdx.task).replace(/\*\*/g, '').trim();
    const deadline = cellAt(row, colIdx.deadline);
    const notes = colIdx.notes !== undefined ? cellAt(row, colIdx.notes) : '';
    const urgency = ctx.extractUrgency && colIdx.urgency !== undefined
      ? cellAt(row, colIdx.urgency)
      : '';

    const task = {
      id,
      task: taskName,
      owner: owners.join('+'),
      owners,
      deadline,
      status,
      sprint: ctx.currentSprint,
      main_chain: ctx.currentMainChain,
      notes,
      urgency,
    };
    // is_risk flags tasks outside any Sprint (legacy non-Sprint work);
    // absent for normal Sprint tasks so the schema's optional flag stays clean.
    if (!ctx.currentSprint) task.is_risk = true;

    ctx.tasks.push(task);

    const sprintKey = ctx.currentSprint || '__no_sprint__';
    if (!ctx.sprintStats[sprintKey]) ctx.sprintStats[sprintKey] = { total: 0, done: 0 };
    ctx.sprintStats[sprintKey].total++;
    if (status === '✅') ctx.sprintStats[sprintKey].done++;

    const chainKey = ctx.currentMainChain || '其他';
    if (!ctx.chainStats[chainKey]) ctx.chainStats[chainKey] = { total: 0, done: 0 };
    ctx.chainStats[chainKey].total++;
    if (status === '✅') ctx.chainStats[chainKey].done++;

    for (const o of owners) {
      if (!ctx.ownerStats[o]) ctx.ownerStats[o] = { total: 0, done: 0 };
      ctx.ownerStats[o].total++;
      if (status === '✅') ctx.ownerStats[o].done++;
    }
  }
}

module.exports = { parseKanbanMd };
