'use strict';

// render-report.js — taskboard-daily 技能的确定性渲染器。
//
// 输出格式：daily-report.schema.json 兼容（git + kanban + ai 三段）。
// 下游自动发送日报服务无感切换。
//
// 输入：
//   --date YYYY-MM-DD          日报日期
//   --user <git_username>      作者（git_username）
//   --repo <repo_name>         仓库名（basename）
//   --tasks <file.json>        taskboard 归一化任务数组（由 MCP 拉取后合成）
//   --git <file.json>          collect-git.js 输出（可选；逗号分隔多文件；缺失则填空 git 段）
//   --ai <file.json>           collect-ai.js 输出（可选；换行分隔多文件；缺失则填空 ai 段）
//   --output <file.md>         渲染 MD 路径
//   --json-output <file.json>  渲染 JSON 路径（ jsonData 字段源）
//
// 三流独立：stdin/stdout/stderr 不混用。校验失败只往 stderr 写单行 + 非零退出码。

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('./lib/argv');
const { validateDailyReport } = require('./lib/schema-validator');

// ===== 输入解析 =====

function readJsonInput(rawArg, label) {
  if (!rawArg || typeof rawArg !== 'string') return null;
  if (rawArg.startsWith('@')) {
    const filePath = rawArg.slice(1);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return JSON.parse(rawArg);
}

function fail(stderrLine) {
  process.stderr.write(stderrLine + '\n');
  process.exit(1);
}

// ===== 会话 Token 口径求和（Issue !275）=====
//
// 混合 backend 时 token 不可用统一公式求和：
//   - codex：官方累计 total_tokens 的 input 已含 cached_input_tokens，再加 cacheRead 即双重计数；
//     有官报 total（>0）时直接用 total。
//   - Claude：无官报 total，退化为 input + output + cacheRead（Claude 的 input 不含 cache）。
// 该口径与「会话 Token 统计」表的行口径（!242 引入）完全一致，保证「工作量统计 → Token 用量」
// 与「会话 Token 统计 → 合计」两处数字对得上。
function sessionBucketTotal(bucket) {
  const input = bucket.input_tokens || 0;
  const output = bucket.output_tokens || 0;
  const cacheRead = bucket.cache_read_tokens || 0;
  const hasTotal = bucket.total_tokens != null && bucket.total_tokens > 0;
  return hasTotal ? bucket.total_tokens : input + output + cacheRead;
}

// 按 session_by_project 分桶求和；桶为空时退回 summary 聚合字段旧口径。
function computeSessionTotalTokens(summary) {
  const buckets = (summary && summary.session_by_project) || {};
  const keys = Object.keys(buckets);
  if (keys.length === 0) {
    return (summary && summary.session_input_tokens || 0)
      + (summary && summary.session_output_tokens || 0)
      + (summary && summary.session_cache_read_input_tokens || 0);
  }
  let total = 0;
  for (const k of keys) total += sessionBucketTotal(buckets[k]);
  return total;
}

// ===== taskboard task → daily-report kanban-task 字段映射 =====
//
// daily-report 的 kanban-task 字段（来自 kanban-task.schema.json）：
//   id, task, owner, owners, deadline, status, sprint, main_chain, notes, urgency
//
// 字段映射规则：
//   id         ← task.code（如 "630-83"），无 code 时用 task.id
//   task       ← task.title（去掉前缀 [] 标签如 "[E-04]"）
//   owner      ← 当前 git_username（taskboard 任务都属于"我"）
//   owners     ← [owner]
//   deadline   ← M/D 格式（从 YYYY-MM-DD 转换）
//   status     ← emoji（✅/🔵/🟡/🔴/⬜）
//   sprint     ← ""（taskboard 无 sprint 概念）
//   main_chain ← task.priority 转中文（高/中/低）—— 借用 main_chain 字段保留优先级信息
//   notes      ← task.status.name（人类可读状态文字）
//   urgency    ← task.priority 转中文

function statusToEmoji(status) {
  if (!status) return '⬜';
  if (status.is_terminal) return '✅';
  const name = status.name || '';
  if (name.includes('阻塞')) return '🔴';
  if (name.includes('风险')) return '🟡';
  if (name.includes('进行')) return '🔵';
  return '⬜';
}

function priorityToZh(p) {
  if (p === 'high') return '高';
  if (p === 'low') return '低';
  return '中';
}

function isoToMD(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  return `${Number(m[2])}/${Number(m[3])}`;
}

function titleStripPrefix(title) {
  // 去掉 "[S0-07]" "[B-01]" "[E-04]" 之类的前缀
  return String(title || '').replace(/^\[[^\]]+\]\s*/, '');
}

function mapTask(t, gitUser) {
  const status = t.status || {};
  const emoji = statusToEmoji(status);
  const priorityZh = priorityToZh(t.priority);
  return {
    id: t.code || t.id || '',
    task: titleStripPrefix(t.title),
    owner: gitUser,
    owners: [gitUser],
    deadline: isoToMD(t.due_date),
    status: emoji,
    sprint: '',
    main_chain: priorityZh, // 借用字段保留优先级
    notes: status.name || '',
    urgency: priorityZh,
  };
}

// ===== stats 计算（基于 emoji，6 字段）=====

function computeStats(kanbanTasks) {
  const s = { total: kanbanTasks.length, done: 0, in_progress: 0, at_risk: 0, blocked: 0, not_started: 0 };
  for (const t of kanbanTasks) {
    switch (t.status) {
      case '✅': s.done++; break;
      case '🔵': s.in_progress++; break;
      case '🟡': s.at_risk++; break;
      case '🔴': s.blocked++; break;
      case '⬜': s.not_started++; break;
    }
  }
  return s;
}

// ===== deadline_calendar 计算 =====
//
// 五桶：overdue / today / tomorrow / day_after / unscheduled
// 每桶是 kanban-task 数组（不含已完成 ✅ 任务，因为已完成的不再卡 deadline）

function parseDate(dateStr) {
  // dateStr: YYYY-MM-DD → Date at local midnight
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dayDiff(a, b) {
  // 整天差值（a, b 都是 local-midnight Date）
  const ms = a.getTime() - b.getTime();
  return Math.round(ms / 86400000);
}

function computeDeadlineCalendar(rawTasks, todayStr, gitUser) {
  const cal = { overdue: [], today: [], tomorrow: [], day_after: [], unscheduled: [] };
  const today = parseDate(todayStr);
  if (!today) return cal;

  for (const t of rawTasks) {
    // 已完成任务（is_terminal=true）跳过：不再卡 deadline
    if (t.status && t.status.is_terminal) continue;
    if (!t.due_date) {
      cal.unscheduled.push(mapTask(t, gitUser));
      continue;
    }
    const due = parseDate(t.due_date);
    if (!due) {
      cal.unscheduled.push(mapTask(t, gitUser));
      continue;
    }
    const diff = dayDiff(due, today);
    const mapped = mapTask(t, gitUser);
    if (diff < 0) cal.overdue.push(mapped);
    else if (diff === 0) cal.today.push(mapped);
    else if (diff === 1) cal.tomorrow.push(mapped);
    else if (diff === 2) cal.day_after.push(mapped);
    else cal.unscheduled.push(mapped); // 远期任务归到 unscheduled
  }
  return cal;
}

// ===== kanban 段构造 =====

function buildKanbanSection({ gitUser, group, rawTasks, todayStr }) {
  const kanbanTasks = rawTasks.map((t) => mapTask(t, gitUser));
  const stats = computeStats(kanbanTasks);
  const deadlineCalendar = computeDeadlineCalendar(rawTasks, todayStr, gitUser);
  return {
    source_file: 'taskboard://mine', // 标识数据源是 taskboard 而非 MD 文件
    user: { git_username: gitUser, group: group || '' },
    tasks: kanbanTasks,
    stats,
    deadline_calendar: deadlineCalendar,
  };
}

// ===== 空段构造 =====

function emptyGitSection() {
  return {
    stats: { commits: 0, files_changed: 0, insertions: 0, deletions: 0 },
    classification: {
      ai_independent: { count: 0, hashes: [] },
      ai_collaborative: { count: 0, hashes: [] },
      human: { count: 0, hashes: [] },
    },
    tags: {},
    commits: [],
  };
}

// collect-git.js 输出含顶层 date/git_username/repo（schema 不允许），剥掉只保留 stats/classification/tags/commits
function normalizeGitSection(raw) {
  if (!raw || typeof raw !== 'object') return emptyGitSection();
  return {
    stats: raw.stats || emptyGitSection().stats,
    classification: raw.classification || emptyGitSection().classification,
    tags: raw.tags || {},
    commits: Array.isArray(raw.commits) ? raw.commits : [],
  };
}

// 多仓库 git 段合并：--git 支持逗号分隔多文件（a.json,b.json）或 @a.json,@b.json
// 累加 stats / classification / tags，commits 数组拼接（每个 commit 已带 repo 字段）
function mergeGitSections(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return emptyGitSection();
  if (sections.length === 1) return normalizeGitSection(sections[0]);
  const merged = {
    stats: { commits: 0, files_changed: 0, insertions: 0, deletions: 0 },
    classification: {
      ai_independent: { count: 0, hashes: [] },
      ai_collaborative: { count: 0, hashes: [] },
      human: { count: 0, hashes: [] },
    },
    tags: {},
    commits: [],
  };
  for (const sec of sections) {
    const g = normalizeGitSection(sec);
    merged.stats.commits += g.stats.commits || 0;
    merged.stats.files_changed += g.stats.files_changed || 0;
    merged.stats.insertions += g.stats.insertions || 0;
    merged.stats.deletions += g.stats.deletions || 0;
    for (const bucket of ['ai_independent', 'ai_collaborative', 'human']) {
      merged.classification[bucket].count += g.classification[bucket].count || 0;
      merged.classification[bucket].hashes.push(...(g.classification[bucket].hashes || []));
    }
    for (const [tag, items] of Object.entries(g.tags || {})) {
      if (!merged.tags[tag]) merged.tags[tag] = [];
      merged.tags[tag].push(...items);
    }
    merged.commits.push(...g.commits);
  }
  return merged;
}

// 解析 --git 参数：支持 "a.json,b.json" / "@a.json,@b.json" / 单文件
function parseGitArg(rawArg) {
  if (!rawArg) return [];
  // 换行分隔（路径不含换行，安全）；兼容旧版逗号分隔
  const sep = rawArg.includes('\n') ? '\n' : ',';
  return rawArg.split(sep).map((s) => s.trim()).filter(Boolean).map((token) => {
    if (token.startsWith('@')) {
      return JSON.parse(fs.readFileSync(token.slice(1), 'utf-8'));
    }
    return JSON.parse(token);
  });
}

// 归一化 AI section 结构
function normalizeAiSection(raw, date) {
  if (!raw || typeof raw !== 'object') return emptyAiSection(date);
  return {
    date: raw.date || date,
    harness_version: raw.harness_version || null,
    client_name: raw.client_name || null,
    client_version: raw.client_version || null,
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    summary: raw.summary || emptyAiSection(date).summary,
  };
}

// 多仓库 ai 段合并：--ai 支持逗号分隔多文件
// 累加 tasks/summary scalar/spec_stats/concern_stats/session，合并 dispatch_by_trigger / session_by_project / session_by_model
// 当前 collect-ai 只在主仓跑一次（collect-all.js:139），故本函数总是收到单元素数组，走 L269 直接返回。
// 保留多文件合并能力以备未来多 AI 数据源扩展。
function mergeAiSections(sections, date) {
  if (!Array.isArray(sections) || sections.length === 0) return emptyAiSection(date);
  if (sections.length === 1) return normalizeAiSection(sections[0], date);

  const merged = emptyAiSection(date);
  const ms = merged.summary;

  for (const sec of sections) {
    const a = normalizeAiSection(sec, date);
    const as = a.summary;

    merged.tasks.push(...a.tasks);

    // Issue !189 Bug2: harness_version / client_name / client_version 多仓合并丢失
    // 取首非空（这些字段是环境元信息，所有子仓应一致；取第一个非空值即可）
    if (!merged.harness_version && a.harness_version) merged.harness_version = a.harness_version;
    if (!merged.client_name && a.client_name) merged.client_name = a.client_name;
    if (!merged.client_version && a.client_version) merged.client_version = a.client_version;

    // summary scalars
    ms.total_input_tokens += as.total_input_tokens || 0;
    ms.total_output_tokens += as.total_output_tokens || 0;
    ms.total_dispatches += as.total_dispatches || 0;
    ms.total_wall_clock_ms += as.total_wall_clock_ms || 0;
    ms.session_input_tokens += as.session_input_tokens || 0;
    ms.session_output_tokens += as.session_output_tokens || 0;
    ms.session_cache_creation_input_tokens += as.session_cache_creation_input_tokens || 0;
    ms.session_cache_read_input_tokens += as.session_cache_read_input_tokens || 0;
    ms.session_total_tokens += as.session_total_tokens || 0;
    ms.session_reasoning_tokens += as.session_reasoning_tokens || 0;
    ms.session_count += as.session_count || 0;

    // dispatch_by_trigger（Issue !279：main 桶随多源合并一起累加）
    for (const trigger of ['pipeline', 'natural', 'main']) {
      const mt = ms.dispatch_by_trigger[trigger];
      const at = as.dispatch_by_trigger && as.dispatch_by_trigger[trigger] || {};
      mt.dispatch_count += at.dispatch_count || 0;
      mt.input_tokens += at.input_tokens || 0;
      mt.output_tokens += at.output_tokens || 0;
      mt.cache_read_tokens += at.cache_read_tokens || 0;
      mt.cache_creation_tokens += at.cache_creation_tokens || 0;
      for (const [role, bucket] of Object.entries(at.by_role || {})) {
        if (!mt.by_role[role]) mt.by_role[role] = { dispatch_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
        mt.by_role[role].dispatch_count += bucket.dispatch_count || 0;
        mt.by_role[role].input_tokens += bucket.input_tokens || 0;
        mt.by_role[role].output_tokens += bucket.output_tokens || 0;
        mt.by_role[role].cache_read_tokens += bucket.cache_read_tokens || 0;
        mt.by_role[role].cache_creation_tokens += bucket.cache_creation_tokens || 0;
      }
      for (const [model, bucket] of Object.entries(at.by_model || {})) {
        if (!mt.by_model[model]) mt.by_model[model] = { dispatch_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
        mt.by_model[model].dispatch_count += bucket.dispatch_count || 0;
        mt.by_model[model].input_tokens += bucket.input_tokens || 0;
        mt.by_model[model].output_tokens += bucket.output_tokens || 0;
        mt.by_model[model].cache_read_tokens += bucket.cache_read_tokens || 0;
        mt.by_model[model].cache_creation_tokens += bucket.cache_creation_tokens || 0;
      }
    }

    // by_backend 合并（新）
    mergeByBackend(ms.by_backend, as.by_backend);
    ms.backend_fallback_count += as.backend_fallback_count || 0;

    // spec_stats
    const mss = ms.spec_stats;
    const ass = as.spec_stats || {};
    mss.total_changes += ass.total_changes || 0;
    mss.closed_loop += ass.closed_loop || 0;
    mss.open += ass.open || 0;
    for (const [phase, count] of Object.entries(ass.by_phase || {})) {
      mss.by_phase[phase] = (mss.by_phase[phase] || 0) + count;
    }

    // concern_stats
    const mcs = ms.concern_stats;
    const acs = as.concern_stats || {};
    mcs.total += acs.total || 0;
    mcs.p0_found += acs.p0_found || 0;
    mcs.p0_closed += acs.p0_closed || 0;
    mcs.p1_found += acs.p1_found || 0;
    mcs.p1_closed += acs.p1_closed || 0;
    // Issue !278: 缺 author 未计入条数跨源累加（老数据无此字段，|| 0 兜底）
    mcs.missing_author_skipped = (mcs.missing_author_skipped || 0) + (acs.missing_author_skipped || 0);

    // session_by_project
    for (const [proj, bucket] of Object.entries(as.session_by_project || {})) {
      if (!ms.session_by_project[proj]) {
        ms.session_by_project[proj] = { slug: bucket.slug || proj, count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, model: null, total_tokens: 0, reasoning_tokens: 0 };
      }
      ms.session_by_project[proj].count += bucket.count || 0;
      ms.session_by_project[proj].input_tokens += bucket.input_tokens || 0;
      ms.session_by_project[proj].output_tokens += bucket.output_tokens || 0;
      ms.session_by_project[proj].cache_read_tokens += bucket.cache_read_tokens || 0;
      ms.session_by_project[proj].cache_creation_tokens += bucket.cache_creation_tokens || 0;
      ms.session_by_project[proj].total_tokens += bucket.total_tokens || 0;
      ms.session_by_project[proj].reasoning_tokens += bucket.reasoning_tokens || 0;
      if (bucket.model) ms.session_by_project[proj].model = bucket.model;
    }

    // session_by_model
    for (const [model, bucket] of Object.entries(as.session_by_model || {})) {
      if (!ms.session_by_model[model]) {
        ms.session_by_model[model] = { count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, model: null, total_tokens: 0, reasoning_tokens: 0 };
      }
      ms.session_by_model[model].count += bucket.count || 0;
      ms.session_by_model[model].input_tokens += bucket.input_tokens || 0;
      ms.session_by_model[model].output_tokens += bucket.output_tokens || 0;
      ms.session_by_model[model].cache_read_tokens += bucket.cache_read_tokens || 0;
      ms.session_by_model[model].cache_creation_tokens += bucket.cache_creation_tokens || 0;
      ms.session_by_model[model].total_tokens += bucket.total_tokens || 0;
      ms.session_by_model[model].reasoning_tokens += bucket.reasoning_tokens || 0;
      if (bucket.model) ms.session_by_model[model].model = bucket.model;
    }
  }

  // finalize merged by_backend buckets（多仓库合并后才需要）
  finalizeMergedByBackend(merged.summary.by_backend);

  return merged;
}

function emptyAiSection(date) {
  return {
    date,
    harness_version: null,
    client_name: null,
    client_version: null,
    tasks: [],
    summary: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_dispatches: 0,
      total_wall_clock_ms: 0,
      dispatch_by_trigger: {
        pipeline: {
          dispatch_count: 0, input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_creation_tokens: 0, by_role: {}, by_model: {},
        },
        natural: {
          dispatch_count: 0, input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_creation_tokens: 0, by_role: {}, by_model: {},
        },
        // Issue !279: 主会话直出桶（渲染单列，不计 dispatch 合计）
        main: {
          dispatch_count: 0, input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_creation_tokens: 0, by_role: {}, by_model: {},
        },
      },
      // by_backend：按 backend 分组聚合 token（Claude/Codex 不混合求和）
      by_backend: {},
      backend_fallback_count: 0,
      spec_stats: { total_changes: 0, closed_loop: 0, open: 0, by_phase: {} },
      concern_stats: { total: 0, p0_found: 0, p0_closed: 0, p1_found: 0, p1_closed: 0, missing_author_skipped: 0 },
      session_input_tokens: 0,
      session_output_tokens: 0,
      session_cache_creation_input_tokens: 0,
      session_cache_read_input_tokens: 0,
      session_total_tokens: 0,
      session_reasoning_tokens: 0,
      session_count: 0,
      session_by_project: {},
      session_by_model: {},
    },
  };
}

// 合并两个 by_backend bucket（多仓库 --ai 合并场景）
function mergeByBackend(target, src) {
  for (const [backend, sb] of Object.entries(src || {})) {
    if (!target[backend]) {
      target[backend] = {
        dispatch_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        model: null,
        _modelCounts: {},
        _seen: { input: false, output: false, cached: false, reasoning: false, total: false },
      };
    }
    const tb = target[backend];
    tb.dispatch_count += sb.dispatch_count || 0;
    // null 视为「不可用」不累加；非 null 累加并标记 seen
    if (sb.input_tokens !== null && sb.input_tokens !== undefined) { tb.input_tokens += sb.input_tokens; tb._seen.input = true; }
    if (sb.output_tokens !== null && sb.output_tokens !== undefined) { tb.output_tokens += sb.output_tokens; tb._seen.output = true; }
    if (sb.cached_tokens !== null && sb.cached_tokens !== undefined) { tb.cached_tokens += sb.cached_tokens; tb._seen.cached = true; }
    if (sb.reasoning_tokens !== null && sb.reasoning_tokens !== undefined) { tb.reasoning_tokens += sb.reasoning_tokens; tb._seen.reasoning = true; }
    if (sb.total_tokens !== null && sb.total_tokens !== undefined) { tb.total_tokens += sb.total_tokens; tb._seen.total = true; }
  }
}

// finalize merged by_backend：dominant model + 未见过非 null 的字段设 null
function finalizeMergedByBackend(byBackend) {
  for (const bucket of Object.values(byBackend)) {
    const entries = Object.entries(bucket._modelCounts || {});
    if (entries.length > 0) {
      bucket.model = entries.sort((a, b) => b[1] - a[1])[0][0];
    }
    delete bucket._modelCounts;
    const seen = bucket._seen || {};
    if (!seen.input) bucket.input_tokens = null;
    if (!seen.output) bucket.output_tokens = null;
    if (!seen.cached) bucket.cached_tokens = null;
    if (!seen.reasoning) bucket.reasoning_tokens = null;
    if (!seen.total) bucket.total_tokens = null;
    delete bucket._seen;
  }
}

// ===== 顶层 report 构造 =====

function buildReportObject({ date, gitUser, repo, branch, group, rawTasks, gitData, aiData }) {
  const kanban = buildKanbanSection({
    gitUser,
    group,
    rawTasks,
    todayStr: date,
  });
  return {
    date,
    git_username: gitUser,
    repo,
    branch: branch || '',
    git: gitData || emptyGitSection(),
    kanban,
    ai: aiData || emptyAiSection(date),
  };
}

// ===== Markdown 渲染（对齐 daily-report-tmp/2026-06-25-wangzk.md 模板）=====

function renderMarkdown(report) {
  const { date, git_username, repo, branch, git, kanban, ai } = report;
  const lines = [];

  // 标题
  lines.push(`# 个人日报 - ${date}`);
  lines.push('');

  // 基本信息
  lines.push('## 基本信息');
  lines.push('| 看板 | 内容 |');
  lines.push('|------|------|');
  lines.push(`| 作者 | ${git_username} |`);
  lines.push(`| 组 | ${kanban.user && kanban.user.group ? kanban.user.group : '—'} |`);
  // 多仓库时 repo 显示为汇总（用 commits 里的 repo 列表）
  const repoList = collectRepoList(git);
  const repoDisplay = repoList.length > 0 ? repoList.join(' / ') : repo;
  lines.push(`| 仓库 | ${repoDisplay} |`);
  lines.push(`| 分支 | ${escapePipe(branch || '—')} |`);
  const harnessVer = ai && ai.harness_version ? ai.harness_version : '—';
  lines.push(`| Harness 版本 | ${harnessVer} |`);
  lines.push(`| 报告日期 | ${date} |`);
  lines.push('');

  // 已完成任务（按 commit 列出）
  lines.push('### 已完成任务 ✅');
  lines.push('');
  const commits = git.commits || [];
  if (commits.length === 0) {
    lines.push('_（今日无 Git 提交）_');
    lines.push('');
  } else {
    for (const c of commits) {
      const stageLabel = stageToZh(c.stage);
      const moduleLabel = c.module || '—';
      const repoTag = c.repo ? ` (${c.repo})` : '';
      lines.push(`- [${stageLabel}] ${escapePipe(moduleLabel)} — ${c.hash}${repoTag}`);
      // body 第一段作为说明（去掉空行）
      const firstPara = pickCommitBodySummary(c.body);
      if (firstPara) {
        lines.push(`  ${escapePipe(firstPara)}`);
      }
    }
    lines.push('');
  }

  // 进行中任务（来自 taskboard，status=🔵）
  const inProgress = (kanban.tasks || []).filter((t) => t.status === '🔵');
  lines.push('### 进行中任务 ⚠️');
  lines.push('');
  if (inProgress.length === 0) {
    lines.push('_（无进行中任务）_');
    lines.push('');
  } else {
    lines.push('| 任务 | 进展 | 预计完成 |');
    lines.push('|------|------|----------|');
    for (const t of inProgress) {
      const title = `${t.id} ${escapePipe(t.task)}`;
      const progress = escapePipe(t.notes || '');
      const due = t.deadline || '—';
      lines.push(`| ${title} | ${progress} | ${due} |`);
    }
    lines.push('');
  }

  // 工作量统计
  lines.push('### 工作量统计');
  lines.push('| 指标 | 数值 |');
  lines.push('|------|------|');
  lines.push(`| 提交数 | ${git.stats.commits} |`);
  lines.push(`| 变更文件数 | ${git.stats.files_changed} |`);
  lines.push(`| 新增行数 | +${git.stats.insertions} |`);
  lines.push(`| 删除行数 | -${git.stats.deletions} |`);
  if (ai && ai.summary) {
    // Issue !158: 用 session 维度（含主会话）而非 dispatch 维度（仅 sub-agent 调度）
    // Issue !265: codex 采集层已把 input 拆为净 input（不含 cached）+ cache_read；
    // Issue !275: 渲染层进一步按 session_by_project 分桶求和（行口径与会话表一致），
    // 结构性保证「Token 用量」恒等于「会话 Token 统计」合计，不再依赖两侧公式巧合对齐。
    const totalTokens = computeSessionTotalTokens(ai.summary);
    lines.push(`| Token 用量 | ${totalTokens.toLocaleString()} |`);
  }
  lines.push('');

  // 提交协作分析
  lines.push('## 提交协作分析');
  lines.push('| 分类 | 提交数 | 占比 | 提交列表 |');
  lines.push('|------|--------|------|----------|');
  const cls = git.classification || {};
  const total = git.stats.commits || 0;
  const buckets = [
    { key: 'ai_independent', label: '🤖 AI 独立完成' },
    { key: 'ai_collaborative', label: '🤝 AI 协作提交' },
    { key: 'human', label: '👤 人工独立提交' },
  ];
  for (const b of buckets) {
    const cnt = cls[b.key] ? cls[b.key].count : 0;
    const pct = total > 0 ? Math.round((cnt / total) * 100) : 0;
    const hashes = cls[b.key] && cls[b.key].hashes ? cls[b.key].hashes.join(' / ') : '—';
    lines.push(`| ${b.label} | ${cnt} | ${pct}% | ${hashes} |`);
  }
  lines.push('');
  lines.push('> **分类依据**：commit 首行末尾 `[...]` 中的操作者类型标识');
  lines.push('');

  // AI 员工效能
  if (ai && ai.summary) {
    renderAiSection(ai, lines);
  }

  // 规划对照（基于看板）
  lines.push('## 规划对照分析（基于个人看板）');
  lines.push('| 看板编号 | 任务 | 计划 Deadline | 今日状态 | 进展说明 |');
  lines.push('|----------|------|--------------|---------|---------|');
  for (const t of kanban.tasks || []) {
    const statusZh = emojiToStatusLabel(t.status);
    const progress = escapePipe(t.notes || '');
    lines.push(`| ${t.id} | ${escapePipe(t.task)} | ${t.deadline || '—'} | ${statusZh} | ${progress} |`);
  }
  lines.push('');

  // 完成率
  const totalTasks = kanban.stats.total || 0;
  const doneTasks = kanban.stats.done || 0;
  if (totalTasks > 0) {
    const rate = Math.round((doneTasks / totalTasks) * 100);
    lines.push(`完成率: ${doneTasks}/${totalTasks}（${rate}%）`);
  }

  return lines.join('\n');
}

// ===== 渲染辅助函数 =====

function collectRepoList(git) {
  const set = new Set();
  for (const c of git.commits || []) {
    if (c.repo) set.add(c.repo);
  }
  return Array.from(set);
}

function stageToZh(stage) {
  const map = {
    DEV: '功能开发',
    BUG: '缺陷修复',
    FIX: '缺陷修复',
    REFACTOR: '重构',
    CM: '配置管理',
    TEST: '测试',
    DOCS: '文档',
    PERF: '性能优化',
    SEC: '安全修复',
    CI: 'CI',
    REL: '发布',
    HOTFIX: '热修复',
    MIGRATE: '数据迁移',
    WIP: '进行中',
  };
  return map[stage] || stage || '其他';
}

function pickCommitBodySummary(body) {
  if (!body) return '';
  // 取第一段非空行（去掉 commit-msg hook 注入的 GATE_BYPASS 等元数据）
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.filter((l) => !l.startsWith('GATE_BYPASS') && !l.startsWith('PM-Approved') && !l.startsWith('Reason:'));
  return meaningful[0] || '';
}

function emojiToStatusLabel(emoji) {
  const map = { '✅': '✅', '🔵': '🔵', '🟡': '🟡', '🔴': '🔴', '⬜': '⬜' };
  return map[emoji] || emoji;
}

function escapePipe(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

function renderAiSection(ai, lines) {
  const sum = ai.summary;
  lines.push('## AI 员工效能');
  lines.push('');

  // 调度统计：dispatch 维度 token 来自 usage.jsonl（含 subagent 用量）。
  // issue !152 原前提"subagent token 未计入主 transcript"在 usage.jsonl 路径下已不成立
  // （collect-ai.js collectUsageJsonl L807-814 已按 role 聚合 subagent token）。
  // 仅短命只读 subagent 有 ~11% 采样缺口（tokens:null），以 — 标注。
  // session 维度总量见上方「Token 用量」行。
  const fmtRoleTok = (v) => (v ? Number(v).toLocaleString() : '—');
  lines.push('### AI 员工调度统计');
  lines.push('| 角色 | 调度类型 | Dispatch 数 | Input | Output | Cached |');
  lines.push('|------|---------|------------|-------|--------|--------|');
  // inTotal=false：Issue !279 PM 口径——主会话直出单列展示，dispatch_count 不计入合计
  const triggerBuckets = [
    { key: 'pipeline', label: 'AI自动调度', inTotal: true },
    { key: 'natural', label: '人工调度', inTotal: true },
    { key: 'main', label: '主会话直出', inTotal: false },
  ];
  let totalDispatch = 0;
  for (const trig of triggerBuckets) {
    const tb = sum.dispatch_by_trigger[trig.key] || {};
    const byRole = tb.by_role || {};
    for (const [role, bucket] of Object.entries(byRole)) {
      lines.push(`| ${role} | ${trig.label} | ${bucket.dispatch_count} | ${fmtRoleTok(bucket.input_tokens)} | ${fmtRoleTok(bucket.output_tokens)} | ${fmtRoleTok(bucket.cache_read_tokens)} |`);
      if (trig.inTotal) totalDispatch += bucket.dispatch_count;
    }
  }
  if (totalDispatch === 0) {
    lines.push('| _今日无 subagent dispatch 活动_ | — | — | — | — | — |');
  }
  lines.push(`| **合计** | — | **${totalDispatch}** |`);
  lines.push('');
  lines.push('> dispatch token 含 subagent 用量（usage.jsonl 采集），— 为短命 subagent 采样缺口；Token 总量另见上方「Token 用量」。');
  if (sum.sampled_gap_count > 0) {
    lines.push(`> ⚠️ ${sum.sampled_gap_count} 条短命 subagent 记录因采样缺口未计入 token（tokens:null）`);
  }
  lines.push('');

  // ── by_backend 分组（Claude/Codex 各算各的，混合求和的口径不可加）──
  // Claude 表：含 Input/Output/Cached 列；Codex 表：用 Total 列替代，稀疏字段显示 —
  // 子表（by_role/by_model/session_by_*）保持原样但仅含 Claude 条目（design 决策 D4）
  const byBackend = sum.by_backend || {};
  const backends = Object.keys(byBackend).filter(b => (byBackend[b].dispatch_count || 0) > 0);
  if (backends.length > 0) {
    lines.push('### AI Worker 用量（按 Backend 分组）');
    lines.push('');
    // Claude 子表（Input/Output/Cached）
    if (byBackend.claude && byBackend.claude.dispatch_count > 0) {
      const c = byBackend.claude;
      lines.push('#### Claude 后端');
      lines.push('| Dispatches | Input | Output | Cached | Model |');
      lines.push('|-----------|-------|--------|--------|-------|');
      const inStr = c.input_tokens != null ? c.input_tokens.toLocaleString() : '—';
      const outStr = c.output_tokens != null ? c.output_tokens.toLocaleString() : '—';
      const cachedStr = c.cached_tokens != null ? c.cached_tokens.toLocaleString() : '—';
      const modelStr = c.model || '—';
      lines.push(`| ${c.dispatch_count} | ${inStr} | ${outStr} | ${cachedStr} | ${modelStr} |`);
      lines.push('');
    }
    // CodeBuddy 子表（issue !226 Bug2：与 Claude 同列结构，token 字段格式一致）
    if (byBackend.codebuddy && byBackend.codebuddy.dispatch_count > 0) {
      const cb = byBackend.codebuddy;
      lines.push('#### CodeBuddy 后端');
      lines.push('| Dispatches | Input | Output | Cached | Model |');
      lines.push('|-----------|-------|--------|--------|-------|');
      const inStr = cb.input_tokens != null ? cb.input_tokens.toLocaleString() : '—';
      const outStr = cb.output_tokens != null ? cb.output_tokens.toLocaleString() : '—';
      const cachedStr = cb.cached_tokens != null ? cb.cached_tokens.toLocaleString() : '—';
      const modelStr = cb.model || '—';
      lines.push(`| ${cb.dispatch_count} | ${inStr} | ${outStr} | ${cachedStr} | ${modelStr} |`);
      lines.push('');
    }
    // Codex 子表（Total 列；input/output/cached 显示 —）
    if (byBackend.codex && byBackend.codex.dispatch_count > 0) {
      const c = byBackend.codex;
      lines.push('#### Codex 后端');
      lines.push('| Dispatches | Total |');
      lines.push('|-----------|-------|');
      const totalStr = c.total_tokens != null ? c.total_tokens.toLocaleString() : '—';
      lines.push(`| ${c.dispatch_count} | ${totalStr} |`);
      lines.push('');
      lines.push('> Codex token 当前仅 total；input/output/cached 拆分依赖 ZDR 改进');
      lines.push('');
    }
    if (byBackend.qoder && byBackend.qoder.dispatch_count > 0) {
      const q = byBackend.qoder;
      lines.push('#### Qoder 后端');
      lines.push('| Dispatches | Total |');
      lines.push('|-----------|-------|');
      const totalStr = q.total_tokens != null ? q.total_tokens.toLocaleString() : '—';
      lines.push(`| ${q.dispatch_count} | ${totalStr} |`);
      lines.push('');
      lines.push('> Qoder token 当前按 headless 结果汇总为 total');
      lines.push('');
    }
    // unknown backend（未来扩展场景）
    if (byBackend.unknown && byBackend.unknown.dispatch_count > 0) {
      const u = byBackend.unknown;
      lines.push('#### Unknown 后端');
      lines.push(`> ⚠️ 检测到 ${u.dispatch_count} 条未知 backend 条目（已聚合到此组，请检查数据源）`);
      lines.push('');
    }
    // 兜底标注（issue !226 Bug2：文案改通用措辞，不再硬编码 claude）
    if (sum.backend_fallback_count > 0) {
      lines.push(`> 注：${sum.backend_fallback_count} 条历史记录按当前客户端估算（无 backend 字段）`);
      lines.push('');
    }
  }

  // 流水线任务
  if (ai.tasks && ai.tasks.length > 0) {
    lines.push('### 流水线任务');
    for (const t of ai.tasks) {
      const scoreStr = Object.entries(t.scores || {})
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | ');
      const caller = t.caller ? ` | 发起: ${t.caller}` : '';
      lines.push(`- **${t.change_name}** — ${escapePipe(t.title || '')}`);
      lines.push(`  阶段: ${t.current_phase} | 进度: ${t.phases_completed}/${t.phases_total}${scoreStr ? ' | Scores: ' + scoreStr : ''}${caller}`);
    }
    lines.push('');
  }

  // 质量指标
  lines.push('### 质量指标');
  lines.push('| 指标 | 数值 |');
  lines.push('|------|------|');
  const firstPass = sum.spec_stats && sum.spec_stats.total_changes
    ? Math.round((sum.spec_stats.closed_loop / sum.spec_stats.total_changes) * 100) + '%'
    : '—';
  lines.push(`| 首次通过率 | ${firstPass} |`);
  lines.push(`| 总耗时 | ${Math.round((sum.total_wall_clock_ms || 0) / 60000)}m |`);
  lines.push('');

  // 会话 Token 统计
  if (sum.session_by_project && Object.keys(sum.session_by_project).length > 0) {
    lines.push('### 会话 Token 统计');
    lines.push('| 看板 | 会话数 | 模型 | Input | Output | Cache Read | 总用量 |');
    lines.push('|------|--------|------|-------|--------|-----------|--------|');
    let sessCount = 0, sessInput = 0, sessOutput = 0, sessCache = 0, sessTotalAll = 0, hasSessTotal = false;
    for (const [proj, bucket] of Object.entries(sum.session_by_project)) {
      const input = bucket.input_tokens || 0;
      const output = bucket.output_tokens || 0;
      const cacheRead = bucket.cache_read_tokens || 0;
      // Issue !242: codex 会话 total_tokens（当日增量口径）优先；Claude 退化为 input+output+cacheRead。
      // 合计按各行的"行口径 total"求和（Claude 行=input+output+cache；codex 行=当日增量 total），
      // 避免混合 backend 时合计漏掉一侧。行口径统一走 sessionBucketTotal（!275），与工作量统计同源。
      const hasTotal = bucket.total_tokens != null && bucket.total_tokens > 0;
      const total = sessionBucketTotal(bucket);
      const modelStr = bucket.model || '—';
      lines.push(`| ${proj} | ${bucket.count} | ${modelStr} | ${input.toLocaleString()} | ${output.toLocaleString()} | ${cacheRead.toLocaleString()} | ${total.toLocaleString()} |`);
      sessCount += bucket.count;
      sessInput += input;
      sessOutput += output;
      sessCache += cacheRead;
      sessTotalAll += total;
      if (hasTotal) hasSessTotal = true;
    }
    const cacheDisplay = hasSessTotal ? '—' : sessCache.toLocaleString();
    lines.push(`| **合计** | **${sessCount}** | — | **${sessInput.toLocaleString()}** | **${sessOutput.toLocaleString()}** | **${cacheDisplay}** | **${sessTotalAll.toLocaleString()}** |`);
    lines.push('');
    lines.push('> session_count 统计当日有活动的会话数，跨天会话会在多个日期各计一次');
    if (hasSessTotal) {
      lines.push('> Codex 会话取当日事件增量求和（Input 已拆分不含 Cache Read）；Claude 总用量 = Input + Output + Cache Read');
    }
    lines.push('');
  }

  // SPEC 闭环统计
  if (sum.spec_stats) {
    lines.push('### SPEC 闭环统计');
    lines.push('| 指标 | 数值 |');
    lines.push('|------|------|');
    const closedRate = sum.spec_stats.total_changes
      ? Math.round((sum.spec_stats.closed_loop / sum.spec_stats.total_changes) * 100)
      : 0;
    lines.push(`| 闭环变更 | ${sum.spec_stats.closed_loop} / ${sum.spec_stats.total_changes} (${closedRate}%) |`);
    lines.push(`| 进行中 | ${sum.spec_stats.open} |`);
    lines.push('');
  }

  // Concerns 统计
  if (sum.concern_stats) {
    lines.push('### Concerns 统计');
    lines.push('| 级别 | 发现 | 已关闭 | 关闭率 |');
    lines.push('|------|------|--------|--------|');
    const cs = sum.concern_stats;
    const p0Rate = cs.p0_found ? Math.round((cs.p0_closed / cs.p0_found) * 100) + '%' : '-';
    const p1Rate = cs.p1_found ? Math.round((cs.p1_closed / cs.p1_found) * 100) + '%' : '-';
    lines.push(`| P0 | ${cs.p0_found} | ${cs.p0_closed} | ${p0Rate} |`);
    lines.push(`| P1 | ${cs.p1_found} | ${cs.p1_closed} | ${p1Rate} |`);
    lines.push(`| **合计** | **${cs.total}** | **${cs.p0_closed + cs.p1_closed}** | — |`);
    // Issue !278: 缺 author 被采集端跳过的条数在日报明示，不再静默归零
    if (cs.missing_author_skipped) {
      lines.push('');
      lines.push(`> ⚠ ${cs.missing_author_skipped} 条 concerns 缺 author 字段，未计入上表（需升级 Reviewer/Debate 写入端必填 author）`);
    }
    lines.push('');
  }
}

function escapePipe(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|');
}

// ===== 主入口 =====

function main() {
  const args = parseArgs(process.argv, {
    flags: [],
    options: {
      date: '',
      user: '',
      repo: '',
      tasks: '',
      git: '',
      ai: '',
      output: '',
      'json-output': '',
      branch: '',
      group: '',
    },
  });

  const opts = args.options;
  const required = ['date', 'user', 'repo', 'tasks', 'output', 'json-output'];
  const missing = required.filter((k) => !opts[k]);
  if (missing.length) {
    fail(`render-report.js: missing required option(s): ${missing.join(', ')}`);
  }

  // groupName 可选：taskboard create-project-report 的 groupName 字段允许 null，
  // 空串表示用户未配置 groupName（默认行为，不再阻断渲染）。
  const group = opts.group || '';

  // 解析 tasks
  let rawTasks;
  try {
    rawTasks = readJsonInput(opts.tasks, 'tasks');
  } catch (e) {
    fail(`render-report.js: invalid --tasks: ${e.message}`);
  }
  if (!Array.isArray(rawTasks)) {
    fail('render-report.js: --tasks must be a JSON array');
  }

  // 解析 git（可选，支持逗号分隔多文件）
  let gitData = null;
  if (opts.git) {
    try {
      const gitSections = parseGitArg(opts.git);
      gitData = mergeGitSections(gitSections);
    } catch (e) {
      fail(`render-report.js: invalid --git: ${e.message}`);
    }
  }

  // 解析 ai（可选，支持逗号分隔多文件）
  let aiData = null;
  if (opts.ai) {
    try {
      const aiSections = parseGitArg(opts.ai);
      aiData = mergeAiSections(aiSections, opts.date);
    } catch (e) {
      fail(`render-report.js: invalid --ai: ${e.message}`);
    }
  }

  const report = buildReportObject({
    date: opts.date,
    gitUser: opts.user,
    repo: opts.repo,
    branch: opts.branch || '',
    group,
    rawTasks,
    gitData,
    aiData,
  });

  // MD 渲染先用 commit.repo + 完整 body，渲染完再 strip/trancate 以通过 schema
  const markdown = renderMarkdown(report);
  for (const c of report.git.commits) {
    delete c.repo;
    // 截断 body 为首行（下游 report_builder.go 只取首行，全量 body 浪费 JSON 体积）
    if (c.body) {
      const nl = c.body.indexOf('\n');
      if (nl > 0) c.body = c.body.slice(0, nl).trimEnd();
    }
  }

  const verdict = validateDailyReport(report);
  if (!verdict.valid) {
    fail(`render-report.js: schema validation failed: ${verdict.errors.join('; ')}`);
  }

  const outputDir = path.dirname(opts.output);
  const jsonOutputDir = path.dirname(opts['json-output']);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(jsonOutputDir, { recursive: true });
  } catch (e) {
    fail(`render-report.js: failed to create output dir: ${e.message}`);
  }

  try {
    fs.writeFileSync(opts.output, markdown, 'utf-8');
  } catch (e) {
    fail(`render-report.js: failed to write --output: ${e.message}`);
  }
  try {
    fs.writeFileSync(opts['json-output'], JSON.stringify(report, null, 2) + '\n', 'utf-8');
  } catch (e) {
    fail(`render-report.js: failed to write --json-output: ${e.message}`);
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      output: opts.output,
      json_output: opts['json-output'],
      stats: report.kanban.stats,
      git_commits: report.git.stats.commits,
      ai_dispatches: report.ai.summary.total_dispatches,
    }) + '\n'
  );
}

// require.main 守卫：CLI 行为不变，测试可 require 本模块复用行口径函数（!275）。
if (require.main === module) {
  main();
}

module.exports = { sessionBucketTotal, computeSessionTotalTokens };
