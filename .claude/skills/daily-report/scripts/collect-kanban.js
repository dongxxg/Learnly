'use strict';

const { parseArgs } = require('./lib/argv');
const { getJson, getRaw } = require('./lib/http');
const { fetchTeam, findByUsername } = require('./lib/person');
const { loadConfig, resolveCred: resolveCredDefault } = require('./lib/config');
const { todayCST } = require('./lib/time');

function resolveCred(args) {
  if (args.options['gitlab-token']) return args.options['gitlab-token'];
  return resolveCredDefault();
}

// --- markdown table parser ---
function parseTables(md) {
  const lines = md.split('\n');
  const tables = [];
  let currentHeaders = null;
  let currentRows = [];
  let currentSection = '';
  let currentSprint = '';

  for (const line of lines) {
    // ## level = Sprint heading
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      const heading = h2Match[1].trim();
      const sprintMatch = heading.match(/^(Sprint\s*\d+)/i);
      if (sprintMatch) {
        currentSprint = sprintMatch[1].replace(/\s+/g, ' ').trim();
        // Normalize: "Sprint 0" → "Sprint 0"
        const num = currentSprint.match(/\d+/);
        if (num) currentSprint = `Sprint ${num[0]}`;
      }
      currentSection = heading;
      continue;
    }

    // ### level = sub-section (main chain etc.)
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      currentSection = h3Match[1].trim();
      continue;
    }

    if (!line.startsWith('|')) {
      if (currentHeaders) {
        tables.push({ section: currentSection, sprint: currentSprint, headers: currentHeaders, rows: currentRows });
        currentHeaders = null;
        currentRows = [];
      }
      continue;
    }

    const cells = line.split('|').slice(1, -1).map((c) => c.trim());

    if (!currentHeaders) {
      currentHeaders = cells.map((c) => c.toLowerCase().replace(/^#+\s+/, '').trim());
      continue;
    }

    // skip separator rows
    if (cells.every((c) => /^[-:\s]+$/.test(c))) continue;

    currentRows.push(cells);
  }

  if (currentHeaders) {
    tables.push({ section: currentSection, sprint: currentSprint, headers: currentHeaders, rows: currentRows });
  }

  return tables;
}

// column name normalization
const COL_MAP = {
  id: ['#', '编号', '任务编号'],
  task: ['任务', '任务描述', '描述'],
  owner: ['owner', '执行者', '责任人', '负责人'],
  deadline: ['deadline', '截止日期', '截止'],
  status: ['状态'],
  notes: ['备注', '说明'],
  urgency: ['紧急度', '优先级'],
};

function findCol(headers, ...names) {
  for (const name of names) {
    const idx = headers.findIndex((h) => h === name || h.includes(name));
    if (idx !== -1) return idx;
  }
  return -1;
}

function extractCol(row, headers, ...names) {
  const idx = findCol(headers, ...names);
  return idx !== -1 && row[idx] !== undefined ? row[idx].trim() : '';
}

function ownerMatches(ownerStr, username) {
  if (!ownerStr || !username) return false;
  const segments = ownerStr.split(/[+,/\s]+/).map((s) => s.trim()).filter(Boolean);
  return segments.some((s) => s === username);
}

// deadline parsing: "M/D" or "M/D–M/D"
function parseDeadline(dl, year) {
  if (!dl) return null;
  const m = dl.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function classifyDeadline(dlDate, today) {
  if (!dlDate) return 'unscheduled';
  if (dlDate < today) return 'overdue';
  if (dlDate === today) return 'today';
  const diffMs = new Date(dlDate).getTime() - new Date(today).getTime();
  const diffDays = diffMs / 86400000;
  if (diffDays <= 1) return 'tomorrow';
  if (diffDays <= 2) return 'day_after';
  return 'later';
}

async function main() {
  const args = parseArgs(process.argv, {
    options: {
      'gitlab-token': '',
      user: '',
      year: String(new Date().getFullYear()),
    },
  });

  const cred = resolveCred(args);
  if (!cred) {
    const output = { error: 'GITLAB_TOKEN not set', success: false };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  }

  const year = parseInt(args.options.year, 10);
  const team = await fetchTeam();
  const { gitlabUrl, projectId, branch, kanbanDir } = loadConfig();

  // resolve target user
  let targetUser = null;
  if (args.options.user) {
    targetUser = findByUsername(team, args.options.user);
  }

  // 1. list kanban directory — use configured dir, fallback to alternatives
  async function loadKanbanTree(dirName) {
    const dir = encodeURIComponent(`reports/${year}/${dirName}/`);
    const url = `${gitlabUrl}/api/v4/projects/${projectId}/repository/tree?path=${dir}&ref=${branch}`;
    const entries = await getJson(url, cred);
    const files = entries
      .filter((f) => f.type === 'blob' && /_kanban.*\.md$/.test(f.name))
      .sort((a, b) => b.name.localeCompare(a.name));
    return { dirName, files };
  }

  let kanbanDirName = kanbanDir || 'knowledge';
  let kanbanFiles = [];
  const fallbackDirs = ['knowledge', 'knownlage'].filter((d) => d !== kanbanDirName);

  try {
    const primary = await loadKanbanTree(kanbanDirName);
    kanbanFiles = primary.files;
  } catch {
    // primary dir not found
  }

  for (const fb of fallbackDirs) {
    if (kanbanFiles.length > 0) break;
    try {
      const result = await loadKanbanTree(fb);
      kanbanDirName = result.dirName;
      kanbanFiles = result.files;
    } catch {
      // try next fallback
    }
  }

  if (kanbanFiles.length === 0) {
    const taskList = [];
    const output = {
      source_file: '',
      last_updated: '',
      user: targetUser ? { git_username: targetUser.git_username, group: targetUser.group } : null,
      tasks: taskList,
      stats: {
        total: 0,
        done: 0,
        in_progress: 0,
        at_risk: 0,
        blocked: 0,
        not_started: 0,
      },
      deadline_calendar: { overdue: [], today: [], tomorrow: [], day_after: [], unscheduled: [] },
      kanban_available: false,
      message: `当年（${year}）无正式看板文件`,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }

  const kanbanFilename = kanbanFiles[0].name;

  // 2. fetch kanban content
  const kanbanPath = encodeURIComponent(`reports/${year}/${kanbanDirName}/${kanbanFilename}`);
  const rawUrl = `${gitlabUrl}/api/v4/projects/${projectId}/repository/files/${kanbanPath}/raw?ref=${branch}`;
  const kanbanMd = await getRaw(rawUrl, cred);

  // 3. extract last_updated
  const updatedMatch = kanbanMd.match(/\*最后更新[：:]\s*(\d{4}-\d{2}-\d{2})/);
  const lastUpdated = updatedMatch ? updatedMatch[1] : '';

  // 4. parse tables
  const tables = parseTables(kanbanMd);

  // 5. extract tasks for target user (or all users)
  const tasks = [];
  const allTasks = [];
  const targetUsername = targetUser ? targetUser.git_username : '';

  for (const table of tables) {
    if (table.headers.length < 3) continue;
    // must have owner and status columns
    const ownerIdx = findCol(table.headers, 'owner', '执行者', '责任人', '负责人');
    const statusIdx = findCol(table.headers, '状态');
    if (ownerIdx === -1 || statusIdx === -1) continue;

    for (const row of table.rows) {
      const owner = row[ownerIdx] || '';
      const status = row[statusIdx] || '';

      const task = {
        id: extractCol(row, table.headers, '#', '编号'),
        task: extractCol(row, table.headers, '任务'),
        owner: owner,
        deadline: extractCol(row, table.headers, 'deadline'),
        status: status,
        sprint: table.sprint || '',
        main_chain: table.section || '',
        notes: extractCol(row, table.headers, '备注'),
        urgency: extractCol(row, table.headers, '紧急度', '优先级'),
      };

      allTasks.push(task);

      if (targetUsername && ownerMatches(owner, targetUsername)) {
        tasks.push(task);
      }
    }
  }

  // 6. compute stats
  function countByStatus(list, emoji) { return list.filter((t) => t.status.includes(emoji)).length; }
  const taskList = targetUsername ? tasks : allTasks;
  const stats = {
    total: taskList.length,
    done: countByStatus(taskList, '✅'),
    in_progress: countByStatus(taskList, '🔵'),
    at_risk: countByStatus(taskList, '🟡'),
    blocked: countByStatus(taskList, '🔴'),
    not_started: countByStatus(taskList, '⬜'),
  };

  // 7. deadline calendar
  const todayStr = todayCST();
  const calendar = { overdue: [], today: [], tomorrow: [], day_after: [], unscheduled: [] };

  for (const t of taskList) {
    if (t.status.includes('✅')) continue;
    const dlDate = parseDeadline(t.deadline, year);
    const cat = classifyDeadline(dlDate, todayStr);
    if (calendar[cat]) calendar[cat].push(t);
  }

  const output = {
    source_file: kanbanFilename,
    last_updated: lastUpdated,
    user: targetUser ? { git_username: targetUser.git_username, group: targetUser.group } : null,
    tasks: targetUsername ? tasks : allTasks,
    stats,
    deadline_calendar: calendar,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(`[collect-kanban] error: ${e.message}\n`);
  process.exit(1);
});
