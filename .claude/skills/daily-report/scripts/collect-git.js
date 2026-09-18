'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { parseArgs } = require('./lib/argv');
const { fetchTeam } = require('./lib/person');

// --- commit message 正则 (复用 commitlint-ai-plugin.js 的 OPERATOR_TYPES) ---
const OPERATOR_RE = /\[(AI·(?:Developer|Architect|Tester|Reviewer|Debate|Doc|UX|Cond)|AI-[a-zA-Z0-9_-]+\.(?:Developer|Architect|Tester|Reviewer|Debate|Doc|UX|Cond)|H-[a-zA-Z0-9_-]+)\]$/;
const SUBJECT_RE = /^\[.*?\]\s+(DEV|BUG|CM|TEST|DOCS|REFACTOR)\s+(.+?)\[/;


const FRAMEWORK_REPOS = new Set(['rd_harness']);

function getExcludedPaths() {
  const repo = path.basename(process.cwd());
  if (FRAMEWORK_REPOS.has(repo)) return [];
  return [
    ':(exclude).claude/**',
    // .harness/ 下只排除运行时状态（机器生成，无人工工作内容），保留项目资产
    // （spec/knowledge/adr/interfaces/... 有人工编辑的 SPEC、设计、决策）。
    // 与 setup-harness.sh 的 gitignore 目标不同：gitignore 控"是否提交到仓库"，
    // pathspec 控"是否计入日报"——业务方把 SPEC 提交进 .harness/spec/ 是合法操作，
    // 这些工作必须出现在日报里。issue !135。
    ':(exclude).harness/.harness-version',
    ':(exclude).harness/tasks/**',
    ':(exclude).harness/memory/**',
    ':(exclude).harness/shared-state/**',
    ':(exclude).harness/audit/**',
  ];
}

function classifyOperator(subject) {
  const m = subject.match(OPERATOR_RE);
  if (!m) return { type: 'human', detail: '' };
  const op = m[1];
  if (op.startsWith('AI·')) return { type: 'ai_independent', detail: op };
  if (op.startsWith('AI-')) return { type: 'ai_collaborative', detail: op };
  if (op.startsWith('H-')) return { type: 'human', detail: op };
  return { type: 'human', detail: '' };
}

// git stash 自动生成的内部快照 commit，不反映真实工作，过滤掉。
// 两种 subject 格式（均来自 git stash.c 源码，固定不变）：
//   1. 默认格式（git stash create 自动生成）：
//        "WIP on <branch>" / "index on <branch>" / "untracked files on <branch>"
//   2. 自定义消息格式（git stash push -m "msg" / git stash save "msg"）：
//        "On <branch>: <msg>"
//      注意：branch 名不能含空格/冒号（git ref 规范），用 \S+ 严格匹配；
//      冒号后必须有空格 + 非空 msg，避免误报人工 commit（如 "On main" 这类
//      罕见起首词，或 "On main:no-space" 这种非规范格式）。
//
// 只过滤 stash，不要顺手扩到 merge / rebase / cherry-pick —— 那些有人工
// 操作意图，有审计价值，保留为 human。
function isStashCommit(subject) {
  // 默认 stash subject
  if (/^(WIP on |untracked files on |index on )/.test(subject)) return true;
  // 自定义消息 stash subject
  if (/^On \S+: .+/.test(subject)) return true;
  return false;
}

function shortHash(h) { return h.slice(0, 8); }

// CST 时区工具（统一走 lib/time.js）
const { todayCST } = require('./lib/time');

// Force UTF-8 output from git regardless of host locale / code page.
// Locale env vars alone are insufficient on Windows: when the active code page
// is GBK (chcp 936), git still emits commit subjects and paths in GBK and Node
// decodes them as UTF-8, producing garbled text in the daily report. These -c
// flags override git's encoding decisions directly.
const GIT_UTF8_FLAGS = [
  '-c', 'core.quotepath=false',
  '-c', 'i18n.logOutputEncoding=utf-8',
  '-c', 'i18n.commitEncoding=utf-8',
];

// execFileSync with array args avoids shell quoting pitfalls entirely.
// The previous execSync(string) form relied on bash-style single-quote escaping
// which fails on Windows cmd.exe / PowerShell (single quotes are literal there,
// so git would receive 'show' instead of show). Passing args as an array lets
// Node hand them to git verbatim with no shell in the loop.
function runGit(args) {
  try {
    const env = Object.assign({}, process.env, {
      LC_ALL: process.env.LC_ALL || 'C.UTF-8',
      LANG: process.env.LANG || 'C.UTF-8',
    });
    return execFileSync('git', [...GIT_UTF8_FLAGS, ...args], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return '';
  }
}

function commitTouchesIncludedPaths(hash) {
  return Boolean(runGit(['show', '--name-only', '--format=', hash, '--', '.', ...getExcludedPaths()]).trim());
}

// 批量检查多个 commit 是否触碰 included paths（单次 git show 替代逐 commit fork）
// 返回 Set<fullHash> 表示有文件触碰 included paths 的 commit 集合
function batchCommitTouchesIncludedPaths(hashes) {
  if (hashes.length === 0) return new Set();
  if (hashes.length === 1) {
    return commitTouchesIncludedPaths(hashes[0]) ? new Set(hashes) : new Set();
  }
  // 单次 git show 所有 candidate，格式：每个 commit 以 %H 开头，后跟文件列表
  const args = ['show', '--name-only', '--format=%H', ...hashes, '--', '.', ...getExcludedPaths()];
  const output = runGit(args);
  const touched = new Set();
  if (!output) return touched;

  // 解析：按行分割，hash 行（40 字符 hex）后的文件行属于该 commit
  let currentHash = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // hash 行：40 字符 hex（可能带 ^ 前缀表示 root commit）
    const hashMatch = /^(\^[0-9a-f]{40}|[0-9a-f]{40})$/.exec(line);
    if (hashMatch) {
      currentHash = hashMatch[1].replace(/^\^/, '');
      continue;
    }
    // 非 hash 行 = 文件路径 → 该 commit 触碰 included paths
    if (currentHash) {
      touched.add(currentHash);
    }
  }
  return touched;
}

// Resolve filterUser against team.json. Returns { aliases, canonical }:
//   - aliases: Set of strings that should count as this user's commit
//     (git_username / name / abbr unioned). Used for author/committer matching.
//   - canonical: the team.json git_username to use as the report's authoritative
//     git_username, so the same person doesn't show up under different strings
//     ("wangzk" vs "WZK" vs "王某某") when downstream aggregators group by it.
//     null when team.json can't be loaded or filterUser isn't a known member —
//     caller should fall back to the local git config user.name in that case.
function buildUserAliases(team, filterUser) {
  const aliases = new Set();
  if (!filterUser) return { aliases, canonical: null };
  aliases.add(filterUser);

  if (!team || !Array.isArray(team.members) || team.members.length === 0) {
    return { aliases, canonical: null };
  }

  const matches = team.members.filter((m) =>
    m && (m.git_username === filterUser || m.name === filterUser || m.abbr === filterUser)
  );

  let canonical = null;
  for (const m of matches) {
    if (m.git_username) {
      aliases.add(m.git_username);
      // First match wins; in well-maintained team.json each filterUser maps to
      // exactly one member, so this branch is unambiguous in practice.
      if (!canonical) canonical = m.git_username;
    }
    if (m.name) aliases.add(m.name);
    if (m.abbr) aliases.add(m.abbr);
  }

  return { aliases, canonical };
}

function commitNumstat(hash) {
  const out = runGit(['show', '--numstat', '--format=', hash, '--', '.', ...getExcludedPaths()]);
  const stat = { files_changed: 0, insertions: 0, deletions: 0 };
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [insertions, deletions, filePath] = line.split('\t');
    if (!filePath) continue;
    stat.files_changed += 1;
    if (/^\d+$/.test(insertions)) stat.insertions += parseInt(insertions, 10);
    if (/^\d+$/.test(deletions)) stat.deletions += parseInt(deletions, 10);
  }
  return stat;
}

async function main() {
  const args = parseArgs(process.argv, {
    options: { date: todayCST(), user: '', cwd: '' },
  });

  // --cwd: 切到指定仓库目录采集（多仓库日报支持）
  if (args.options.cwd) {
    try {
      process.chdir(args.options.cwd);
    } catch (e) {
      process.stderr.write(`[collect-git] failed to chdir to "${args.options.cwd}": ${e.message}\n`);
      process.exit(1);
    }
  }

  const date = args.options.date;
  const gitUsername = runGit(['config', 'user.name']).trim();
  const filterUser = args.options.user || gitUsername;
  if (!gitUsername) {
    process.stderr.write('[collect-git] cannot determine git user.name\n');
    process.exit(1);
  }

  // team.json is the authoritative source for who "filterUser" really is.
  // Fetch it best-effort; on failure we degrade to strict filterUser matching.
  const team = await fetchTeam().catch((e) => {
    process.stderr.write(`[collect-git] WARNING: team.json unavailable, falling back to strict match: ${e.message}\n`);
    return null;
  });
  const { aliases: userAliases, canonical } = buildUserAliases(team, filterUser);
  // Canonicalize the report's git_username to team.json's git_username so
  // downstream aggregation keys are stable regardless of local git config.
  // Fall back to filterUser (which is --user value, or local git config when
  // --user wasn't passed) so an explicit non-member --user isn't silently
  // rewritten to the local git user.name.
  const reportUser = canonical || filterUser;

  // next day for --until
  const [y, m, d] = date.split('-').map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d) + 86400000);
  const nextDayStr = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDay.getUTCDate()).padStart(2, '0')}`;

  // git log with NUL/SOH delimiters; include committer name (%cn) so merge
  // commits created by GitLab (where author is the human but committer is the
  // integration account, or vice versa) can still be attributed correctly.
  const log = runGit([
    'log',
    '--format=%H%x00%ai%x00%an%x00%cn%x00%s%x00%b%x01',
    `--since=${date} 00:00:00`,
    `--until=${nextDayStr} 00:00:00`,
    '--all',
  ]);

  // 调试统计（issue !146）：默认静默，仅当 COLLECT_GIT_DEBUG 环境变量存在时
  // 在 process.exit(0) 前 stderr 输出，让用户/AI 能看到 commit 被过滤的原因。
  // 必须写 stderr——stdout 是 JSON 给下游消费的，绝不能污染。
  const filterStats = {
    total_commits: 0,
    filtered_by_user: 0,
    filtered_by_stash: 0,
    filtered_by_path: 0,
    included: 0,
  };

  const commits = [];
  if (log) {
    const records = log.split('\x01').filter((r) => r.trim());

    // 第一阶段：收集通过 user + stash 过滤的 candidate commits
    // 昂贵的 git show（path 过滤）放到第二阶段批量处理
    const candidates = [];
    for (const rec of records) {
      filterStats.total_commits++;
      const parts = rec.split('\x00');
      if (parts.length < 5) continue;
      const [rawHash, datetime, author, committer, subject, ...bodyParts] = parts;
      const fullHash = rawHash.replace(/^[\n\r]+/, '');
      const body = bodyParts.join('\x00')
        .replace(/[\x00]+$/g, '')
        .replace(/\r\n/g, '\n')
        .trim();

      if (filterUser && !userAliases.has(author) && !userAliases.has(committer)) {
        filterStats.filtered_by_user++;
        continue;
      }
      // 在昂贵的 git show（path 过滤）之前过滤 stash 快照，
      // 让 "WIP on / untracked files on / index on" 跳过这次性能开销。
      if (isStashCommit(subject)) {
        filterStats.filtered_by_stash++;
        continue;
      }

      candidates.push({ fullHash, datetime, author, committer, subject, body });
    }

    // 第二阶段：批量 git show 检查 path 过滤（单次 fork 替代逐 commit fork）
    const touchedHashes = batchCommitTouchesIncludedPaths(candidates.map(c => c.fullHash));

    // 第三阶段：构建最终 commits 数组
    for (const c of candidates) {
      if (!touchedHashes.has(c.fullHash)) {
        filterStats.filtered_by_path++;
        continue;
      }

      const op = classifyOperator(c.subject);
      const sm = c.subject.match(SUBJECT_RE);
      const stage = sm ? sm[1] : '';
      const mod = sm ? sm[2].trim() : c.subject.replace(/\[.*?\]/g, '').trim();

      filterStats.included++;
      commits.push({
        hash: shortHash(c.fullHash),
        full_hash: c.fullHash,
        datetime: c.datetime,
        author: c.author,
        subject: c.subject,
        body: c.body,
        operator_type: op.type,
        operator_detail: op.detail,
        stage,
        module: mod,
      });
    }
  }

  // 可选调试输出（issue !146）：仅 stderr，不污染 stdout JSON
  if (process.env.COLLECT_GIT_DEBUG) {
    process.stderr.write(`[collect-git] filter stats: ${JSON.stringify(filterStats)}\n`);
  }

  // classification summary
  const classification = { ai_independent: { count: 0, hashes: [] }, ai_collaborative: { count: 0, hashes: [] }, human: { count: 0, hashes: [] } };
  for (const c of commits) {
    classification[c.operator_type].count++;
    classification[c.operator_type].hashes.push(c.hash);
  }

  // stage grouping
  const tags = {};
  for (const c of commits) {
    const key = c.stage || 'OTHER';
    if (!tags[key]) tags[key] = [];
    tags[key].push({ hash: c.hash, title: c.subject.replace(/\[.*?\]\s*/g, '').replace(/\[.*?\]$/, '').trim() });
  }

  // stats exclude framework runtime/scaffold directories, consistent with commit list
  let stats = { commits: commits.length, files_changed: 0, insertions: 0, deletions: 0 };
  for (const c of commits) {
    const s = commitNumstat(c.full_hash);
    stats.files_changed += s.files_changed;
    stats.insertions += s.insertions;
    stats.deletions += s.deletions;
  }

  // repo name
  const repo = path.basename(process.cwd());

  // 每个 commit 标记 repo 来源（多仓库日报合并时区分）
  for (const c of commits) {
    c.repo = repo;
  }

  const output = { date, git_username: reportUser, repo, stats, commits, classification, tags };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

module.exports = { classifyOperator, isStashCommit, getExcludedPaths };

main();
