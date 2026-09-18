#!/usr/bin/env node
'use strict';

// absolutize-statusline.cjs — 把 settings.json 的 statusLine.command 校准为当前位置绝对路径。
//
// 背景：statusLine 子进程不继承 settings.env（$HARNESS_ROOT 展开为空），且 CWD 不保证
// 在项目根（子目录启动 / 后端差异），相对路径 `node ".claude/tools/..."` 会解析失败 →
// 状态栏静默消失。安装时（install.sh）内联绝对路径；仓库 move 后绝对路径失效，
// session-start hook 每次启动用本脚本自愈校准。两种调用共用同一幂等语义：
//
//   形态 A（相对）：  node ".claude/tools/..."        → 绝对化到当前位置
//   形态 B（旧绝对）：node "/old/path/.claude/..."    → 前缀重写为当前位置
//   形态 C（已正确）：node "/cur/path/.claude/..."    → no-op
//
// 用法：node absolutize-statusline.cjs <settings.json> [more...]
//   - 只改写 statusLine.command，其余字段原样保留（JSON round-trip，2 空格缩进）
//   - 幂等：形态 C 恒等替换不产生变更；替换锚定为引号/空白/行首，路径中间不命中
//   - best-effort：文件缺失/解析失败告警跳过，退出码恒 0（不阻断安装/启动）
//
// 与 generator 的分工：backend 副本（.codebuddy/ 等）由 settings-emit.mjs 生成时内联
// 绝对路径；本脚本负责落地后的 .claude/settings.json（claude 类型安装不经 generator）
// 及 move 后的自愈校准（session-start.sh 调用，框架源仓库由调用方跳过）。

const fs = require('node:fs');
const path = require('node:path');

// 统一 posix 分隔符：Windows 反斜杠路径在双引号 shell 命令串里易被转义破坏，正斜杠全平台可用
function toPosix(p) {
  return p.replace(/\\/g, '/');
}

// 被行首/引号/空白锚定的相对形态：`.claude/`（或其它 backend 目录）前缀。
// 绝对化后残留的 `.claude/`（前面是 `/`）不再命中 → 幂等。
const RELATIVE_BACKEND_RE = /(^|["\s])\.(?:claude|codebuddy|codex|qoder)\//g;

// 被锚定的绝对形态：`/.../.claude/`（任意 backend 目录结尾的绝对前缀）。
// 命中后统一重写为当前位置（含当前位置时为恒等替换 → 幂等）。
const ABSOLUTE_BACKEND_RE = /(^|["\s])\/[^\s"']*\/\.(?:claude|codebuddy|codex|qoder)\//g;

function calibrate(cmd, absBase) {
  return cmd
    .replace(ABSOLUTE_BACKEND_RE, (m, anchor) => `${anchor}${absBase}/`)
    .replace(RELATIVE_BACKEND_RE, (m, anchor) => `${anchor}${absBase}/`);
}

function absolutizeFile(file) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    process.stderr.write(`[absolutize-statusline] 跳过 ${file}: 读取/解析失败 (${e.message})\n`);
    return;
  }
  const cmd = settings && settings.statusLine && settings.statusLine.command;
  if (typeof cmd !== 'string') return;

  // settings.json 所在目录（如 <target>/.claude）的绝对路径即脚本前缀基址
  const absBase = toPosix(path.resolve(path.dirname(file)));
  const rewritten = calibrate(cmd, absBase);
  if (rewritten === cmd) return;

  settings.statusLine.command = rewritten;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log(`  statusLine 已校准: ${file}`);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('用法: node absolutize-statusline.cjs <settings.json> [more...]\n');
  process.exit(0);
}
for (const f of files) absolutizeFile(f);
