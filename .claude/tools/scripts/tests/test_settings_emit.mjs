// test_settings_emit.mjs — claudeJsonSettings statusLine 路径内联策略单测。
// 断言：
//   1. targetRoot 给定 → 内联 resolve(REPO_ROOT, targetRoot) 绝对路径（不依赖子进程 CWD）
//   2. targetRoot 缺省 → 回退 $HARNESS_ROOT/（源不变，Claude 自身使用）
//   3. hooks 仍走 env 前缀 + $HARNESS_ROOT/ 重定位，不受 statusLine 策略影响
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { REPO_ROOT } from '../generate/lib/common.mjs';
import { claudeJsonSettings } from '../generate/lib/settings-emit.mjs';

const src = JSON.parse(
  (await import('node:fs')).readFileSync(resolve(REPO_ROOT, '.claude', 'settings.json'), 'utf8'),
);
assert.ok(src.statusLine && typeof src.statusLine.command === 'string', '源 settings.json 应有 statusLine.command');
assert.ok(
  src.statusLine.command.includes('.claude/tools/scripts/statusline/statusline-command.cjs'),
  '源 statusLine.command 应引用 statusline-command.cjs',
);

// ── 1. targetRoot 给定：绝对路径内联 ──
const withRoot = claudeJsonSettings({
  targetRoot: '.codebuddy',
  env: { HARNESS_BACKEND: 'codebuddy', HARNESS_ROOT: '.codebuddy' },
});
const absPrefix = resolve(REPO_ROOT, '.codebuddy').replace(/\\/g, '/');
assert.equal(
  withRoot.statusLine.command,
  `node "${absPrefix}/tools/scripts/statusline/statusline-command.cjs"`,
  'statusLine.command 应为绝对路径内联（posix 分隔符）',
);
assert.ok(withRoot.statusLine.command.startsWith('node "'), '命令形态保持 node "<path>"');
assert.ok(!withRoot.statusLine.command.includes('$HARNESS_ROOT'), 'statusLine 不得依赖 $HARNESS_ROOT（子进程不继承 env）');

// ── 2. targetRoot 缺省：$HARNESS_ROOT/ 回退 ──
const fallback = claudeJsonSettings({});
assert.ok(
  fallback.statusLine.command.includes('$HARNESS_ROOT/tools/scripts/statusline/statusline-command.cjs'),
  '缺省时回退 $HARNESS_ROOT/ 前缀',
);

// ── 3. hooks 不受影响：env 前缀 + $HARNESS_ROOT/ 重定位 ──
const hookCmds = JSON.stringify(withRoot.hooks);
assert.ok(hookCmds.includes('HARNESS_ROOT='), 'hooks 应带 HARNESS_ROOT env 前缀');
assert.ok(!hookCmds.includes('" .claude/hooks/'), 'hooks 命令不应残留字面量 .claude/hooks/ 相对路径');
// refreshInterval 等字段原样保留
assert.equal(withRoot.statusLine.refreshInterval, src.statusLine.refreshInterval, 'refreshInterval 应保留');

console.log('test_settings_emit: all tests passed');
