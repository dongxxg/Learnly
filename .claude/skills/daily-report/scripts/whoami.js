'use strict';

// whoami.js — 查询当前 taskboard MCP 令牌对应的用户身份
//
// 替代 PM 手动调 mcp__taskboard__whoami 再传 --user 给日报脚本。
// 单一职责：MCP JSON-RPC 调用 + 身份解析。
//
// Usage:
//   node whoami.js                    # 输出: name <email>
//   node whoami.js --json             # 输出完整 JSON
//   node whoami.js --field user       # 输出 email 本地名（admin@x.com → admin）— 推荐用作日报 author
//   node whoami.js --field email      # 仅输出完整 email
//   node whoami.js --field id         # 仅输出 Seeder user id
//   node whoami.js --field token      # 输出 PAT 原值（不调 MCP，离线可用）— 用于 curl Bearer 鉴权
//   node whoami.js --field url        # 输出 MCP server URL（不调 MCP）— 派生 /api/reports 端点
//
// Token 来源（优先级）:
//   1. TASKBOARD_TOKEN 环境变量
//   2. .mcp.json 的 taskboard.headers.Authorization（去掉 "Bearer " 前缀）
//   3. .taskboard-config 文件的 taskboard_token=...
//
// URL 来源（优先级）:
//   1. TASKBOARD_MCP_URL 环境变量
//   2. .mcp.json 的 taskboard.url
//   3. 默认 http://192.168.5.115/api/mcp

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('./lib/argv');
const http = require('./lib/http');

const DEFAULT_MCP_URL = 'http://192.168.5.115/api/mcp';

// ── Token 与 URL 解析 ──

function findProjectRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (fs.existsSync(path.join(dir, '.mcp.json'))) return dir;
    if (fs.existsSync(path.join(dir, '.taskboard-config'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function readMcpJson(projectRoot) {
  const mcpFile = path.join(projectRoot, '.mcp.json');
  if (!fs.existsSync(mcpFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(mcpFile, 'utf-8'));
  } catch (e) {
    return null;
  }
}

function readTaskboardConfig(projectRoot) {
  const cfgFile = path.join(projectRoot, '.taskboard-config');
  if (!fs.existsSync(cfgFile)) return {};
  const result = {};
  for (const line of fs.readFileSync(cfgFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}

function resolveCredentials() {
  const projectRoot = findProjectRoot();
  const mcp = readMcpJson(projectRoot);
  const tbCfg = readTaskboardConfig(projectRoot);

  // .mcp.json schema: { mcpServers: { taskboard: { url, headers } } }
  // 兼容直挂 schema: { taskboard: { url, headers } }
  const taskboardCfg = (mcp && (mcp.taskboard || (mcp.mcpServers && mcp.mcpServers.taskboard))) || {};

  // Token 优先级
  let token = '';
  if (process.env.TASKBOARD_TOKEN) {
    token = process.env.TASKBOARD_TOKEN;
  } else if (taskboardCfg.headers && taskboardCfg.headers.Authorization) {
    const auth = taskboardCfg.headers.Authorization;
    token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  } else if (tbCfg.taskboard_token) {
    token = tbCfg.taskboard_token;
  }

  // URL 优先级
  let url = '';
  if (process.env.TASKBOARD_MCP_URL) {
    url = process.env.TASKBOARD_MCP_URL;
  } else if (taskboardCfg.url) {
    url = taskboardCfg.url;
  } else {
    url = DEFAULT_MCP_URL;
  }

  return { token, url };
}

// ── MCP whoami 调用 ──

async function callWhoami(url, token) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'whoami', arguments: {} },
  });

  const res = await http.request(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
  }, body);

  if (res.status !== 200) {
    throw new Error(`MCP whoami HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`MCP whoami 返回非 JSON: ${res.body.slice(0, 300)}`);
  }

  // MCP 错误响应
  if (parsed.error) {
    throw new Error(`MCP error ${parsed.error.code || 'unknown'}: ${parsed.error.message || ''}`);
  }
  if (!parsed.result) {
    throw new Error(`MCP whoami 无 result 字段: ${JSON.stringify(parsed).slice(0, 300)}`);
  }

  // isError 标志
  if (parsed.result.isError) {
    const text = parsed.result.content && parsed.result.content[0] && parsed.result.content[0].text;
    throw new Error(`MCP whoami 工具调用失败: ${text || 'unknown'}`);
  }

  // content[0].text 是嵌套 JSON 字符串
  const text = parsed.result.content && parsed.result.content[0] && parsed.result.content[0].text;
  if (!text) {
    throw new Error('MCP whoami 返回空 content');
  }

  try {
    const user = JSON.parse(text);
    // 派生字段 user：取 email 的 @ 之前部分，作为日报 author 标识
    // Seeder 系统不存 git_username，用 email local-part 作为短标识（如 admin@unitechs.com → admin）
    if (user.email && !user.user) {
      user.user = user.email.split('@')[0];
    }
    return user;
  } catch (e) {
    throw new Error(`MCP whoami content.text 非 JSON: ${text.slice(0, 300)}`);
  }
}

// ── 输出格式化 ──

function formatDefault(user) {
  // 人类可读: "name <email>"
  const name = user.name || user.id;
  const email = user.email ? ` <${user.email}>` : '';
  return `${name}${email}`;
}

function formatField(user, field) {
  if (!(field in user)) {
    process.stderr.write(`whoami.js: 字段 "${field}" 不存在。可用: ${Object.keys(user).join(', ')}\n`);
    process.exit(2);
  }
  return String(user[field] ?? '');
}

// ── 主入口 ──

async function main() {
  const args = parseArgs(process.argv, {
    flags: ['json', 'help', 'quiet'],
    options: { field: '' },
  });

  if (args.flags.help) {
    process.stderr.write([
      'Usage: node whoami.js [--json | --field <name> | --quiet]',
      '',
      'Output:',
      '  default: "name <email>" (human-readable)',
      '  --json:  full JSON {id, name, email, user, role, scope}',
      '  --field user:  email local-part (admin@x.com → admin) — recommended for report author',
      '  --field email: full email',
      '  --field id:    Seeder user id',
      '  --field name:  display name (may contain non-ASCII)',
      '  --field token: PAT raw value (no MCP call, works offline) — for curl -H "Authorization: Bearer ..."',
      '  --field url:   MCP server URL, e.g. http://192.168.5.115/api/mcp (no MCP call) — derive reports URL',
      '  --quiet: no stdout on success (use exit code)',
      '',
      'Token resolution (priority):',
      '  1. TASKBOARD_TOKEN env',
      '  2. .mcp.json taskboard.headers.Authorization',
      '  3. .taskboard-config taskboard_token=...',
      '',
      'URL resolution (priority):',
      '  1. TASKBOARD_MCP_URL env',
      '  2. .mcp.json taskboard.url',
      '  3. http://192.168.5.115/api/mcp',
      '',
    ].join('\n'));
    process.exit(0);
  }

  const { token, url } = resolveCredentials();
  if (!token) {
    process.stderr.write([
      'whoami.js: 未找到 taskboard token',
      '',
      '请通过以下任一方式提供:',
      '  1. export TASKBOARD_TOKEN="seed_pat_..."',
      '  2. 在 .mcp.json 的 taskboard.headers.Authorization 中配置',
      '  3. 在 .taskboard-config 文件中写入 taskboard_token=seed_pat_...',
      '',
    ].join('\n'));
    process.exit(1);
  }

  // ── 凭证字段短路：不调 MCP，直接返回 resolveCredentials() 的本地凭证 ──
  // Why：token/url 是本地凭证而非 MCP 返回值；离线、MCP 故障时也应可用。
  // 让 --field token 走 callWhoami 会失败（MCP whoami 返回的 user 对象不含 token 字段）。
  // 用途：SKILL.md Step 8 用 --field token 拿 PAT、--field url 派生 /api/reports 端点。
  if (args.options.field === 'token') {
    process.stdout.write(token + '\n');
    return;
  }
  if (args.options.field === 'url') {
    process.stdout.write(url + '\n');
    return;
  }

  let user;
  try {
    user = await callWhoami(url, token);
  } catch (e) {
    process.stderr.write(`whoami.js: ${e.message}\n`);
    process.exit(1);
  }

  if (args.flags.quiet) {
    return;
  }

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(user) + '\n');
    return;
  }

  if (args.options.field) {
    process.stdout.write(formatField(user, args.options.field) + '\n');
    return;
  }

  process.stdout.write(formatDefault(user) + '\n');
}

module.exports = { callWhoami, resolveCredentials, formatDefault, formatField };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`whoami.js: unexpected error: ${err.message}\n`);
    process.exit(1);
  });
}
