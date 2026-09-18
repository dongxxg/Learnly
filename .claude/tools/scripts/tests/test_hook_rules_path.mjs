// test_hook_rules_path.mjs — Tests for git hook HARNESS_ROOT path fix
//
// 背景：commit-msg / pre-receive 源文件写死 .claude/rules/ai-git-commit-spec.md，
// 靠 generator 分发时字符串替换（rewriteClaudeSlash）修正为 $HARNESS_ROOT/rules/...。
// 这是脆弱的隐式依赖：
//   1. 源文件在 .claude backend 下「巧合正确」（源目录名恰好=运行时 harness root 名），
//      但语义上指向的是「源仓库相对路径」而非「运行时框架根」。
//   2. 分发产物引用 $HARNESS_ROOT 却无默认值兜底——set -u 下 HARNESS_ROOT 未设时
//      unbound 阻断（到达 error 提示行的 echo $HARNESS_ROOT 即 crash）。
//
// 修复：源文件直接用 $HARNESS_ROOT/rules/...，并在 set -euo pipefail 后注入
// HARNESS_ROOT="${HARNESS_ROOT:-.claude}" 默认值兜底。分发时 stripBareInHook 把
// 兜底 .claude 清零为空（${HARNESS_ROOT:-}），仍保证 set -u 下不 crash。
//
// Covers:
//   - 源 commit-msg / pre-receive 不写死 .claude/rules，改用 $HARNESS_ROOT/rules/
//   - 源文件在 set -euo pipefail 后注入 HARNESS_ROOT 默认值赋值
//   - 分发后（rewriteFileIfNeeded mode='hook'）无 .claude/rules 残留
//   - 功能：分发产物在 set -u + HARNESS_ROOT 未设时不 crash（exit 1 校验失败，非 unbound）
//   - 功能：HARNESS_ROOT 已设时提示路径正确
//
// Run: node .claude/tools/scripts/tests/test_hook_rules_path.mjs

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rewriteFileIfNeeded } from '../generate/lib/copy-assets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const HOOK_SRC = join(REPO_ROOT, '.claude', 'hooks', 'git');
const tests = [];

// Helper: 把源内容写到临时文件并跑 rewriteFileIfNeeded(mode='hook') 模拟分发
function distribute(srcContent, name = 'commit-msg') {
  const dir = mkdtempSync(join(tmpdir(), 'hook-rules-test-'));
  const p = join(dir, name);
  writeFileSync(p, srcContent, 'utf8');
  rewriteFileIfNeeded(p, 'hook');
  return { dir, path: p, out: readFileSync(p, 'utf8') };
}

// ── Test 1: 源 commit-msg 不写死 .claude/rules，改用 $HARNESS_ROOT ─────────
tests.push(function testSourceCommitMsgNoHardcodedPath() {
  const src = readFileSync(join(HOOK_SRC, 'commit-msg'), 'utf8');
  assert.ok(!src.includes('.claude/rules/'),
    '源 commit-msg 不应写死 .claude/rules/，应改用 $HARNESS_ROOT/rules/');
  assert.ok(src.includes('$HARNESS_ROOT/rules/'),
    '源 commit-msg 应引用 $HARNESS_ROOT/rules/ 动态路径');
});

// ── Test 2: 源 pre-receive 同理 ──────────────────────────────────────────
tests.push(function testSourcePreReceiveNoHardcodedPath() {
  const src = readFileSync(join(HOOK_SRC, 'pre-receive'), 'utf8');
  assert.ok(!src.includes('.claude/rules/'),
    '源 pre-receive 不应写死 .claude/rules/');
  assert.ok(src.includes('$HARNESS_ROOT/rules/'),
    '源 pre-receive 应引用 $HARNESS_ROOT/rules/ 动态路径');
});

// ── Test 3: 源 commit-msg 在 set -euo pipefail 后注入 HARNESS_ROOT 默认值 ─
tests.push(function testSourceCommitMsgHasHarnessRootDefault() {
  const src = readFileSync(join(HOOK_SRC, 'commit-msg'), 'utf8');
  const setIdx = src.indexOf('set -euo pipefail');
  assert.ok(setIdx > -1, '源 commit-msg 应有 set -euo pipefail');
  // 查找 HARNESS_ROOT 默认值赋值行（含 ${HARNESS_ROOT:-...} 兜底）
  const assignMatch = src.match(/^[ \t]*HARNESS_ROOT=.*\$\{HARNESS_ROOT:-/m);
  assert.ok(assignMatch, '源 commit-msg 应注入 HARNESS_ROOT 默认值赋值（${HARNESS_ROOT:-...}）');
  const assignIdx = src.indexOf(assignMatch[0]);
  assert.ok(assignIdx > setIdx,
    'HARNESS_ROOT 默认值赋值应在 set -euo pipefail 之后（否则 set -u 下仍 unbound）');
});

// ── Test 4: 源 pre-receive 同理注入默认值 ──────────────────────────────────
tests.push(function testSourcePreReceiveHasHarnessRootDefault() {
  const src = readFileSync(join(HOOK_SRC, 'pre-receive'), 'utf8');
  const setIdx = src.indexOf('set -euo pipefail');
  assert.ok(setIdx > -1, '源 pre-receive 应有 set -euo pipefail');
  const assignMatch = src.match(/^[ \t]*HARNESS_ROOT=.*\$\{HARNESS_ROOT:-/m);
  assert.ok(assignMatch, '源 pre-receive 应注入 HARNESS_ROOT 默认值赋值');
  const assignIdx = src.indexOf(assignMatch[0]);
  assert.ok(assignIdx > setIdx,
    'HARNESS_ROOT 默认值赋值应在 set -euo pipefail 之后');
});

// ── Test 5: 分发 commit-msg 后无 .claude/rules 残留 ────────────────────────
tests.push(function testDistributedCommitMsgNoLeak() {
  const src = readFileSync(join(HOOK_SRC, 'commit-msg'), 'utf8');
  const { out, dir } = distribute(src);
  assert.ok(!out.includes('.claude/rules'),
    '分发后 commit-msg 不应残留 .claude/rules 字面量');
  assert.ok(out.includes('$HARNESS_ROOT/rules'),
    '分发后 commit-msg 应保留 $HARNESS_ROOT/rules 引用');
  rmSync(dir, { recursive: true, force: true });
});

// ── Test 6: 分发 pre-receive 后无 .claude/rules 残留 ───────────────────────
tests.push(function testDistributedPreReceiveNoLeak() {
  const src = readFileSync(join(HOOK_SRC, 'pre-receive'), 'utf8');
  const { out, dir } = distribute(src, 'pre-receive');
  assert.ok(!out.includes('.claude/rules'),
    '分发后 pre-receive 不应残留 .claude/rules 字面量');
  assert.ok(out.includes('$HARNESS_ROOT/rules'),
    '分发后 pre-receive 应保留 $HARNESS_ROOT/rules 引用');
  rmSync(dir, { recursive: true, force: true });
});

// ── Test 7: 功能 — 分发后 commit-msg 在 HARNESS_ROOT 未设时不 crash ────────
//   这是本次修复的核心：分发产物引用 $HARNESS_ROOT，若未注入默认值，
//   set -u 下到达 error 提示行的 echo $HARNESS_ROOT 即 unbound crash。
tests.push(function testFunctionalNoUnboundWhenHarRootUnset() {
  const src = readFileSync(join(HOOK_SRC, 'commit-msg'), 'utf8');
  const { dir, path: hookPath } = distribute(src);
  chmodSync(hookPath, 0o755);
  // 构造非法 commit message（触发首行格式错误 → 进入 error 提示路径）
  const msgPath = join(dir, 'msg');
  writeFileSync(msgPath, 'totally bad commit message\n\nfeat: 触发校验错误路径\n', 'utf8');
  // 真正移除 HARNESS_ROOT（模拟独立执行，无 settings.json env 注入）
  const env = { ...process.env };
  delete env.HARNESS_ROOT;
  const result = spawnSync('bash', [hookPath, msgPath], { env, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  // 应以 exit 1 退出（校验失败），而非 unbound crash
  assert.equal(result.status, 1,
    `非法 message 应以 exit 1 退出（校验失败）。实际 status=${result.status}, stderr=${result.stderr}`);
  assert.ok(!result.stderr.toLowerCase().includes('unbound'),
    `set -u 下不应因 HARNESS_ROOT unbound crash。stderr: ${result.stderr}`);
  // 应打印了有益的校验错误提示（证明走到了 error 输出，而非 bash 语法层面 crash）
  assert.ok(result.stderr.includes('参考规范') || result.stderr.includes('ERROR'),
    `应输出校验错误提示。stderr: ${result.stderr}`);
});

// ── Test 8: 功能 — HARNESS_ROOT 已设时提示路径正确 ─────────────────────────
tests.push(function testFunctionalPathCorrectWhenHarRootSet() {
  const src = readFileSync(join(HOOK_SRC, 'commit-msg'), 'utf8');
  const { dir, path: hookPath } = distribute(src);
  chmodSync(hookPath, 0o755);
  const msgPath = join(dir, 'msg');
  writeFileSync(msgPath, 'totally bad commit message\n\nfeat: 触发校验错误路径\n', 'utf8');
  const result = spawnSync('bash', [hookPath, msgPath], {
    env: { ...process.env, HARNESS_ROOT: '.codex' },
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 1, '非法 message 应以 exit 1 退出');
  // HARNESS_ROOT=.codex 时，提示路径应含 .codex/rules/ai-git-commit-spec.md
  assert.ok(result.stderr.includes('.codex/rules/ai-git-commit-spec.md'),
    `HARNESS_ROOT=.codex 时提示应含 .codex/rules/ai-git-commit-spec.md。stderr: ${result.stderr}`);
});

// ── Test 9: 回归 — 合法 commit message 仍能通过（6 条校验规则不破坏） ──────
tests.push(function testValidMessageStillPasses() {
  const src = readFileSync(join(HOOK_SRC, 'commit-msg'), 'utf8');
  const { dir, path: hookPath } = distribute(src);
  chmodSync(hookPath, 0o755);
  const msgPath = join(dir, 'msg');
  // 合法 message：首行四字段 + 空行 + body type
  // 用 [AI·Developer] 简写形式，避免依赖 git config user.name
  writeFileSync(msgPath, '[730] BUG 测试模块[AI·Developer]\n\nfix: 测试合法 message\n', 'utf8');
  const result = spawnSync('bash', [hookPath, msgPath], {
    env: { ...process.env, HARNESS_ROOT: '.codex' },
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0,
    `合法 message 应以 exit 0 通过。实际 status=${result.status}, stderr=${result.stderr}`);
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
