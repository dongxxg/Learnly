'use strict';

// lib/kanban-view.js — 把 kanban-source mirror 转换为日报渲染所需的个人视角 JSON。
//
// 提取自 collect-kanban.js，让 render-report.js 在直接消费 kanban-update.js 输出
// （全量任务 mirror）时也能按 owner 过滤，避免"日报变全团队看板"问题。
//
// 核心导出：
//   buildPersonalView({ mirror, username, userMeta, year, todayStr }) → KanbanSection

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

function countByStatus(list, emoji) {
  return list.filter((t) => t.status && t.status.includes(emoji)).length;
}

function computeStats(taskList) {
  return {
    total: taskList.length,
    done: countByStatus(taskList, '✅'),
    in_progress: countByStatus(taskList, '🔵'),
    at_risk: countByStatus(taskList, '🟡'),
    blocked: countByStatus(taskList, '🔴'),
    not_started: countByStatus(taskList, '⬜'),
  };
}

function computeDeadlineCalendar(taskList, year, todayStr) {
  // 历史 5 桶 schema：overdue/today/tomorrow/day_after/unscheduled。
  // classifyDeadline 还会返回 'later'（>2 天），不属于这 5 桶，忽略以保持向后兼容。
  const calendar = { overdue: [], today: [], tomorrow: [], day_after: [], unscheduled: [] };
  for (const t of taskList) {
    if (t.status && t.status.includes('✅')) continue;
    const dlDate = parseDeadline(t.deadline, year);
    const cat = classifyDeadline(dlDate, todayStr);
    if (calendar[cat]) calendar[cat].push(t);
  }
  return calendar;
}

const { todayCST } = require('./time');

function defaultTodayStr() {
  return todayCST();
}

// 把全量 kanban-source mirror 转为个人视角 JSON。
//   mirror    — kanban-source schema 合规对象（{source_file, tasks:[...], updated_at?, ...}）
//   username  — git_username，空串表示不过滤（团队视角）
//   userMeta  — { git_username, group }，由调用方从 team.json 解析；null 时保留 null
//   year      — 4 位年份，用于把 'M/D' 解析为完整日期
//   todayStr  — 'YYYY-MM-DD'，缺省时用当前日期（UTC+8）
function buildPersonalView({ mirror, username = '', userMeta = null, year, todayStr }) {
  const allTasks = Array.isArray(mirror.tasks) ? mirror.tasks : [];
  const tasks = username
    ? allTasks.filter((t) => ownerMatches(t.owner, username))
    : allTasks;

  const stats = computeStats(tasks);
  const today = todayStr || defaultTodayStr();
  const calendar = computeDeadlineCalendar(tasks, year, today);

  return {
    source_file: mirror.source_file || '',
    last_updated: mirror.updated_at || '',
    user: userMeta,
    tasks,
    stats,
    deadline_calendar: calendar,
  };
}

module.exports = {
  ownerMatches,
  parseDeadline,
  classifyDeadline,
  countByStatus,
  computeStats,
  computeDeadlineCalendar,
  buildPersonalView,
};
