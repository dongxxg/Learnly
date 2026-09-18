// test_copy_assets_entry_inject.mjs — Unit tests for HARNESS_ROOT default injection
//
// 背景：generator 把 `.claude/` 重写为 `$HARNESS_ROOT/`，但 setup-harness.sh /
// sync-settings-hooks.sh 是独立 bash 脚本，不经 settings.json env 注入，
// `set -u` 下 `$HARNESS_ROOT` unbound 直接阻断。修复：generator 对「入口脚本」
// （tools/scripts/setup/ 下的 .sh）在 `set -euo pipefail` 后注入
// `HARNESS_ROOT="${HARNESS_ROOT:-.<backend>}"` 默认值。
//
// Covers:
//   - 入口脚本注入 codex/codebuddy 默认值
//   - 注入位置在 set -euo pipefail 之后
//   - .claude/ → $HARNESS_ROOT/ 重写仍生效
//   - 幂等（二次运行不重复注入）
//   - 无 set -u 行 / 无 $HARNESS_ROOT 引用 / mode≠entry 时不注入
//   - 文件已含 HARNESS_ROOT= 赋值时不重复注入（setup-hooks.sh 自带探测块）
//
// Run: node .claude/tools/scripts/tests/test_copy_assets_entry_inject.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteFileIfNeeded } from '../generate/lib/copy-assets.mjs';

const tests = [];

// Helper: 把 content 写到临时文件，跑 rewriteFileIfNeeded，返回结果文本。
function rewrite(content, mode, harnessRoot) {
  const dir = mkdtempSync(join(tmpdir(), 'copy-assets-test-'));
  const p = join(dir, 'setup-harness.sh');
  writeFileSync(p, content, 'utf8');
  rewriteFileIfNeeded(p, mode, harnessRoot);
  const out = readFileSync(p, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return out;
}

// ── Test 1: 入口脚本注入 .codex 默认值 ─────────────────────────────────────
tests.push(function testEntryInjectsCodexDefault() {
  const src = [
    '#!/usr/bin/env bash',
    '# setup-harness.sh',
    'set -euo pipefail',
    '',
    'cp .claude/tools/foo.sh /tmp/',
    '',
  ].join('\n');
  const out = rewrite(src, 'entry', '.codex');
  // .claude/ → $HARNESS_ROOT/
  assert.ok(out.includes('$HARNESS_ROOT/tools/foo.sh'),
    '应把 .claude/ 重写为 $HARNESS_ROOT/');
  // 注入默认值
  assert.ok(out.includes('HARNESS_ROOT="${HARNESS_ROOT:-.codex}"'),
    '应注入 HARNESS_ROOT=".codex" 默认值');
  // 顺序：set -euo pipefail 在注入之前
  const setIdx = out.indexOf('set -euo pipefail');
  const injectIdx = out.indexOf('HARNESS_ROOT="${HARNESS_ROOT:-.codex}"');
  assert.ok(setIdx > -1 && injectIdx > setIdx,
    '注入应在 set -euo pipefail 之后');
});

// ── Test 2: codebuddy 默认值 ──────────────────────────────────────────────
tests.push(function testEntryInjectsCodebuddyDefault() {
  const src = 'set -euo pipefail\ncp .claude/foo /tmp/\n';
  const out = rewrite(src, 'entry', '.codebuddy');
  assert.ok(out.includes('HARNESS_ROOT="${HARNESS_ROOT:-.codebuddy}"'),
    '应注入 HARNESS_ROOT=".codebuddy" 默认值');
});

// ── Test 3: 幂等 — 二次运行不重复注入 ─────────────────────────────────────
tests.push(function testIdempotent() {
  const dir = mkdtempSync(join(tmpdir(), 'copy-assets-test-'));
  const p = join(dir, 'setup-harness.sh');
  const src = 'set -euo pipefail\ncp .claude/foo /tmp/\n';
  writeFileSync(p, src, 'utf8');
  rewriteFileIfNeeded(p, 'entry', '.codex');
  const first = readFileSync(p, 'utf8');
  // 二次运行
  rewriteFileIfNeeded(p, 'entry', '.codex');
  const second = readFileSync(p, 'utf8');
  assert.equal(second, first, '二次运行不应改变内容');
  const count = (second.match(/HARNESS_ROOT="\$\{HARNESS_ROOT:-\.codex\}"/g) || []).length;
  assert.equal(count, 1, '注入只出现一次');
  rmSync(dir, { recursive: true, force: true });
});

// ── Test 4: 无 set -u 系列行 → 不注入（但仍重写 .claude/） ─────────────────
tests.push(function testNoSetLine() {
  const src = '#!/usr/bin/env bash\ncp .claude/foo /tmp/\n';
  const out = rewrite(src, 'entry', '.codex');
  assert.ok(!out.includes('HARNESS_ROOT="${HARNESS_ROOT'),
    '无 set -euo pipefail 时不应注入');
  assert.ok(out.includes('$HARNESS_ROOT/foo'),
    '仍应把 .claude/ 重写为 $HARNESS_ROOT/');
});

// ── Test 5: 文件无 $HARNESS_ROOT 引用 → 不注入 ────────────────────────────
tests.push(function testNoHarnessRootRef() {
  const src = '#!/usr/bin/env bash\nset -euo pipefail\necho hello\n';
  const out = rewrite(src, 'entry', '.codex');
  assert.ok(!out.includes('HARNESS_ROOT="${HARNESS_ROOT'),
    '无 $HARNESS_ROOT 引用时不应注入');
});

// ── Test 6: mode=false（其它文件） → 不注入 ───────────────────────────────
tests.push(function testModeFalseNoInject() {
  const src = 'set -euo pipefail\ncp .claude/foo /tmp/\n';
  const out = rewrite(src, false, '.codex');
  assert.ok(!out.includes('HARNESS_ROOT="${HARNESS_ROOT'),
    'mode=false 时不应注入');
  assert.ok(out.includes('$HARNESS_ROOT/foo'),
    'mode=false 时仍应重写 .claude/');
});

// ── Test 7: 文件已含 HARNESS_ROOT= 赋值 → 不重复注入（setup-hooks.sh 场景） ─
tests.push(function testExistingAssignmentPreserved() {
  // setup-hooks.sh 源在 line 82 有 export HARNESS_ROOT="$_bd" 探测块
  const src = [
    'set -euo pipefail',
    'for _bd in .codex .claude; do',
    '  export HARNESS_ROOT="$_bd"',
    'done',
    'cp .claude/foo /tmp/',
    '',
  ].join('\n');
  const out = rewrite(src, 'entry', '.codex');
  assert.ok(!out.includes('HARNESS_ROOT="${HARNESS_ROOT'),
    '文件已定义 HARNESS_ROOT= 时不应注入（保留原有探测块）');
  assert.ok(out.includes('export HARNESS_ROOT="$_bd"'),
    '原有 export HARNESS_ROOT 应保留');
});

// ── Test 8: 注入位置紧跟 set 行，且在任何 $HARNESS_ROOT 使用之前 ───────────
tests.push(function testInjectionImmediatelyAfterSet() {
  const src = 'set -euo pipefail\ncp .claude/foo /tmp/\n';
  const out = rewrite(src, 'entry', '.codex');
  const lines = out.split('\n');
  const setLineIdx = lines.findIndex((l) => /^set -euo pipefail/.test(l));
  const injectLineIdx = lines.findIndex((l) => l.includes('HARNESS_ROOT="${HARNESS_ROOT:-.codex}"'));
  assert.ok(setLineIdx >= 0 && injectLineIdx > setLineIdx,
    `注入行 (${injectLineIdx}) 应在 set 行 (${setLineIdx}) 之后`);
  // 关键不变式：bash 自顶向下执行，默认值必须在使用之前赋值。
  // 验证 $HARNESS_ROOT 首次「实际引用」位置 > 注入位置（否则 unbound 仍会发生）。
  // 排除注入行本身（含 ${HARNESS_ROOT:-} 默认赋值）与 export 行。
  const firstUseIdx = lines.findIndex(
    (l) => /\$HARNESS_ROOT[\/\"]|\$\{HARNESS_ROOT\}/.test(l),
  );
  assert.ok(firstUseIdx > injectLineIdx,
    `$HARNESS_ROOT 首次实际引用 (${firstUseIdx}) 应在注入 (${injectLineIdx}) 之后`);
});

// ── Test 9: 仅 set -e（无 u） → 不注入（无 unbound 风险） ──────────────────
tests.push(function testNoUFlag() {
  const src = 'set -eo pipefail\ncp .claude/foo /tmp/\n';
  const out = rewrite(src, 'entry', '.codex');
  assert.ok(!out.includes('HARNESS_ROOT="${HARNESS_ROOT'),
    'set -e（无 u）时不需要注入（unbound 不会阻断）');
});

// ── Test 10: setup-harness.sh 真实场景模拟 ────────────────────────────────
tests.push(function testRealisticSetupHarnessSlice() {
  // 模拟源 setup-harness.sh 关键片段
  const src = [
    '#!/usr/bin/env bash',
    '# setup-harness.sh — Uni-AURI 框架安装与升级脚本',
    'set -euo pipefail',
    '',
    'NPM_SCOPE="@infra-ai"',
    '',
    'if [ -f .claude/manifest ]; then',
    '  cp .claude/manifest /tmp/',
    'fi',
    '',
    'bash .claude/hooks/shared/foo.sh',
    '',
  ].join('\n');
  const out = rewrite(src, 'entry', '.codex');
  // 验证修复目标
  assert.ok(out.includes('HARNESS_ROOT="${HARNESS_ROOT:-.codex}"'),
    '应注入默认值');
  assert.ok(out.includes('$HARNESS_ROOT/manifest'),
    '.claude/manifest → $HARNESS_ROOT/manifest');
  assert.ok(out.includes('$HARNESS_ROOT/hooks/shared/foo.sh'),
    '.claude/hooks/shared/foo.sh → $HARNESS_ROOT/...');
  assert.ok(out.includes('export HARNESS_ROOT'),
    '应 export 让子进程可见');
});

// ── Test 11: submit-harness-issue.sh 场景 —— $HARNESS_ROOT 在 git 命令里被求值 ─
tests.push(function testSubmitHarnessIssueScenario() {
  // 源 .claude 版：git log -- .claude/  → 生成版：git log -- $HARNESS_ROOT/
  // 在 set -u 下会 unbound 阻断（issue: 同类 bug 排查）
  const src = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'RECENT_COMMITS=$(git log --oneline -3 -- .claude/ .harness/ 2>/dev/null || echo "none")',
    '',
  ].join('\n');
  const out = rewrite(src, 'entry', '.codex');
  assert.ok(out.includes('HARNESS_ROOT="${HARNESS_ROOT:-.codex}"'),
    'submit-harness-issue 同类 bug 也应被注入修复');
  assert.ok(out.includes('-- $HARNESS_ROOT/'),
    '.claude/ → $HARNESS_ROOT/ 在 git 命令里');
});

// ── Test 12: pre-commit-tdd-check.sh 场景 —— $HARNESS_ROOT 在 case 模式里 ──
tests.push(function testCasePatternScenario() {
  // bash 的 set -u 在 case 模式里也会因 $HARNESS_ROOT unbound 阻断
  const src = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'case "$path" in',
    '  .claude/*|.harness/*) return 0 ;;',
    'esac',
    '',
  ].join('\n');
  const out = rewrite(src, 'entry', '.codex');
  assert.ok(out.includes('HARNESS_ROOT="${HARNESS_ROOT:-.codex}"'),
    'case 模式下的 $HARNESS_ROOT 也应被注入修复');
});

// ── 跑测 ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`  PASS  ${t.name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${t.name}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}
console.log(`\n${passed}/${tests.length} passed, ${failed} failed`);
if (failed) process.exit(1);
