'use strict';

// collect-ai-codex-session.test.js — codex session token 采集测试（Issue !265 / !268）
//
// 覆盖口径修复的核心场景：
//   1. resume 继承去重：total_token_usage 为会话累计且 resume 新文件基线继承全部历史，
//      文件内逐事件 Δtotal；文件首事件无基线时用 last_token_usage 校正继承历史
//   2. 合成事件剔除（Issue !268 核心）：官方 codex token_count 有多个发射点——
//      auto-compact/rollback 后 recompute（last=上下文估算合成值）、限流重试（last 原样
//      重发）、超窗 set_total_tokens_full（total 重置为 window、字段清零）——只有 total
//      单调递增，合成事件 Δ=0 自动剔除，Σlast 会把合成/重发值当增量（实测放大数倍）
//   3. 跨天事件过滤：按事件 timestamp（UTC→CST）只计当日增量
//   4. legacy schema 兜底：无 last_token_usage 时文件首事件退化为 total 全额
//   5. 口径拆分：codex input_tokens 已含 cached_input_tokens，须拆为净 input + cache_read
//      （与 Claude 口径一致，渲染层 input+output+cache_read 不再重复计 cache）
//   6. orca 内部分发零值样本（input/output/cached 全 0、仅 total 有值）不崩不重复

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COLLECT_AI = path.join(__dirname, '..', 'collect-ai.js');
const DATE = '2026-09-03';

function runCollectAi(work, date = DATE) {
  // Windows：os.homedir() 读 USERPROFILE，仅覆写 HOME 隔离不掉真实 ~/.claude、~/.zcode
  // 数据（session_count 被实机历史会话污染）。POSIX 无 USERPROFILE，置空无副作用。
  return JSON.parse(execFileSync(process.execPath, [COLLECT_AI, '--date', date, '--cwd', work], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      CODEX_HOME: path.join(work, '.codex'),
      HOME: work,
      USERPROFILE: work,
      ZCODE_ROLLOUT_DIR: path.join(work, 'zcode-rollout'),
    },
  }));
}

// 构造 rollout 文件（归档在启动日目录下，事件 timestamp 可跨天）
function writeRollout(work, name, lines) {
  const dir = path.join(work, '.codex', 'sessions', '2026', '09', '03');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function tokenEvent(ts, last, total) {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  };
}

function legacyTokenEvent(ts, total) {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total } },
  };
}

function turnContext(model) {
  return { type: 'turn_context', payload: { model } };
}

test('codex resume 继承去重：逐事件 Δtotal + 首事件 last 校正（Issue !265/!268 核心）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-resume-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 会话 1：两次调用，累计 total 158000（真实新增 = 105000 + 53000）
  writeRollout(work, 'rollout-a.jsonl', [
    turnContext('gpt-5.6-sol'),
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 5000, total_tokens: 105000 },
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 5000, total_tokens: 105000 }),
    tokenEvent('2026-09-03T02:00:00.000Z',
      { input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 3000, total_tokens: 53000 },
      { input_tokens: 150000, cached_input_tokens: 120000, output_tokens: 8000, total_tokens: 158000 }),
  ]);

  // 会话 2（resume 会话 1）：首条 total 基线已继承 158000，当日新增仅 62000
  writeRollout(work, 'rollout-b.jsonl', [
    turnContext('gpt-5.6-sol'),
    tokenEvent('2026-09-03T05:00:00.000Z',
      { input_tokens: 60000, cached_input_tokens: 50000, output_tokens: 2000, total_tokens: 62000 },
      { input_tokens: 210000, cached_input_tokens: 170000, output_tokens: 10000, total_tokens: 220000 }),
  ]);

  const out = runCollectAi(work);
  const s = out.summary;

  // 旧口径（Σ末尾 total）= 158000 + 220000 = 378000（重复计继承历史）
  // 新口径（逐事件 Δtotal + 首事件 last 校正）= 105000 + 53000 + 62000 = 220000
  assert.strictEqual(s.session_total_tokens, 220000);
  assert.strictEqual(s.session_count, 2);

  // 口径拆分：input 拆为净 input（不含 cached）
  // 净 input = (100000-80000) + (50000-40000) + (60000-50000) = 40000
  assert.strictEqual(s.session_input_tokens, 40000);
  assert.strictEqual(s.session_output_tokens, 5000 + 3000 + 2000);
  assert.strictEqual(s.session_cache_read_input_tokens, 80000 + 40000 + 50000);

  // 渲染层「Token 用量」三项相加 = 官方 total（cache 不再双计）
  assert.strictEqual(
    s.session_input_tokens + s.session_output_tokens + s.session_cache_read_input_tokens,
    s.session_total_tokens
  );

  const proj = s.session_by_project.codex;
  assert.ok(proj, 'session_by_project.codex 应存在');
  assert.strictEqual(proj.count, 2);
  assert.strictEqual(proj.total_tokens, 220000);
  assert.strictEqual(proj.model, 'gpt-5.6-sol');

  const model = s.session_by_model['gpt-5.6-sol'];
  assert.ok(model, 'session_by_model 按模型聚合');
  assert.strictEqual(model.count, 2);
  assert.strictEqual(model.total_tokens, 220000);
});

test('codex 跨天会话只计当日事件增量', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-crossday-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 昨日 CST 事件（2026-09-02T02:00Z = CST 09-02 10:00）+ 今日事件
  writeRollout(work, 'rollout-cross.jsonl', [
    tokenEvent('2026-09-02T02:00:00.000Z',
      { input_tokens: 900000, cached_input_tokens: 900000, output_tokens: 9000, total_tokens: 909000 },
      { input_tokens: 900000, cached_input_tokens: 900000, output_tokens: 9000, total_tokens: 909000 }),
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, total_tokens: 1100 },
      { input_tokens: 901000, cached_input_tokens: 900800, output_tokens: 9100, total_tokens: 910100 }),
  ]);

  const out = runCollectAi(work);
  const s = out.summary;
  assert.strictEqual(s.session_total_tokens, 1100, '只计今日增量（跨天用 total 差值）');
  assert.strictEqual(s.session_count, 1);
  assert.strictEqual(s.session_input_tokens, 200); // 1000 - 800
  assert.strictEqual(s.session_cache_read_input_tokens, 800);
});

test('codex auto-compact 合成事件不重复计（Issue !268：Σlast 放大根因）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-compact-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 官方 codex recompute_token_usage（auto-compact/rollback 后触发）：total 不变，
  // last 被替换为上下文估算合成值（cached=0）。Σlast = 105000 + 98000 + 53000 = 256000（虚增）
  writeRollout(work, 'rollout-compact.jsonl', [
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 5000, total_tokens: 105000 },
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 5000, total_tokens: 105000 }),
    // 合成事件：last = 估算值（95000+3000），total 未变 → Δ=0
    tokenEvent('2026-09-03T01:30:00.000Z',
      { input_tokens: 95000, cached_input_tokens: 0, output_tokens: 3000, total_tokens: 98000 },
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 5000, total_tokens: 105000 }),
    tokenEvent('2026-09-03T02:00:00.000Z',
      { input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 3000, total_tokens: 53000 },
      { input_tokens: 150000, cached_input_tokens: 120000, output_tokens: 8000, total_tokens: 158000 }),
  ]);

  const out = runCollectAi(work);
  const s = out.summary;
  assert.strictEqual(s.session_total_tokens, 158000, '合成事件 Δ=0，只有两次真实响应增量');
  assert.strictEqual(s.session_input_tokens, (100000 - 80000) + (50000 - 40000));
  assert.strictEqual(s.session_output_tokens, 5000 + 3000);
});

test('codex 限流重试原样重发 last 不重复计（Issue !268）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-ratelimit-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // UsageLimitReached → update_rate_limits：info 原样重发（last 与 total 均不变）
  const last = { input_tokens: 200000, cached_input_tokens: 180000, output_tokens: 8000, total_tokens: 208000 };
  const total = { input_tokens: 200000, cached_input_tokens: 180000, output_tokens: 8000, total_tokens: 208000 };
  writeRollout(work, 'rollout-rl.jsonl', [
    tokenEvent('2026-09-03T01:00:00.000Z', last, total),
    tokenEvent('2026-09-03T01:05:00.000Z', last, total), // 重发
    tokenEvent('2026-09-03T01:10:00.000Z', last, total), // 再重发
  ]);

  const out = runCollectAi(work);
  assert.strictEqual(out.summary.session_total_tokens, 208000, '重发事件 Δ=0');
  assert.strictEqual(out.summary.session_input_tokens, 20000); // 200000 - 180000
});

test('codex 超窗填满事件（total 重置 window、字段清零）不虚增（Issue !268）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-window-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // ContextWindowExceeded → set_total_tokens_full → fill_to_context_window：
  // total_token_usage 重置为 {total_tokens: window, 其余字段全 0}，last = window − prev
  writeRollout(work, 'rollout-window.jsonl', [
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 5000, total_tokens: 105000 },
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 5000, total_tokens: 105000 }),
    tokenEvent('2026-09-03T01:01:00.000Z',
      { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 200000 },
      { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 200000 }),
  ]);

  const out = runCollectAi(work);
  const s = out.summary;
  // total Δ=95000 被字段差值和（0）封顶 → 只计首事件 105000，不再计 window 虚增
  assert.strictEqual(s.session_total_tokens, 105000);
  assert.strictEqual(s.session_input_tokens, 20000);
});

test('codex 当日无事件的会话不计入 session_count', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-noday-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 事件全部在昨日 CST（文件归档在 09-03 目录但活动在 09-02）
  writeRollout(work, 'rollout-stale.jsonl', [
    tokenEvent('2026-09-02T02:00:00.000Z',
      { input_tokens: 100, total_tokens: 150 },
      { input_tokens: 100, total_tokens: 150 }),
  ]);

  const out = runCollectAi(work);
  assert.strictEqual(out.summary.session_count, 0);
  assert.strictEqual(out.summary.session_total_tokens || 0, 0);
  assert.ok(!out.summary.session_by_project.codex, 'codex 桶不应存在');
});

test('codex legacy schema（无 last_token_usage）退化为 total 差值', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-legacy-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 新会话：昨日累计到 1200，今日两事件累计到 3600 → 今日增量 2400
  writeRollout(work, 'rollout-legacy.jsonl', [
    legacyTokenEvent('2026-09-02T10:00:00.000Z',
      { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 200, total_tokens: 1200 }),
    legacyTokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 2000, cached_input_tokens: 1200, output_tokens: 500, total_tokens: 2500 }),
    legacyTokenEvent('2026-09-03T02:00:00.000Z',
      { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 600, total_tokens: 3600 }),
  ]);

  const out = runCollectAi(work);
  const s = out.summary;
  assert.strictEqual(s.session_total_tokens, 3600 - 1200, '差值口径：今日末 total − 昨日末 total');
  // 净 input = input差(2000) − cached差(1500)；cache_read = cached差（口径拆分同 last 路径）
  assert.strictEqual(s.session_input_tokens, (3000 - 1000) - (2000 - 500));
  assert.strictEqual(s.session_cache_read_input_tokens, 2000 - 500);
  assert.strictEqual(s.session_output_tokens, 600 - 200);
  assert.strictEqual(s.session_count, 1);
});

test('codex legacy 新会话（无昨日基线）差值从 0 起', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-legacy0-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 全部事件在今日，首条即该会话第一次调用：增量 = 末 total − 0
  writeRollout(work, 'rollout-legacy0.jsonl', [
    legacyTokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 200, total_tokens: 1200 }),
    legacyTokenEvent('2026-09-03T02:00:00.000Z',
      { input_tokens: 2000, cached_input_tokens: 1800, output_tokens: 400, total_tokens: 2400 }),
  ]);

  const out = runCollectAi(work);
  assert.strictEqual(out.summary.session_total_tokens, 2400);
  assert.strictEqual(out.summary.session_input_tokens, 2000 - 1800); // 净 input 拆分
  assert.strictEqual(out.summary.session_cache_read_input_tokens, 1800);
});

test('codex orca 零值样本（input/output/cached 全 0，仅 total 有值）不崩、不计 total', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-orca0-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // orca 内部分发样本 last=total、组件全 0：非模型真实用量，组件和封顶后计 0
  writeRollout(work, 'rollout-orca.jsonl', [
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 542 },
      { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 542 }),
  ]);

  const out = runCollectAi(work);
  const s = out.summary;
  assert.strictEqual(s.session_total_tokens, 0, '组件全 0 的 total-only 事件不计入');
  assert.strictEqual(s.session_input_tokens, 0);
  assert.strictEqual(s.session_cache_read_input_tokens, 0);
  assert.strictEqual(s.session_count, 1, '会话计数不受影响');
});

test('codex total 下跳（orca 内部分发样本夹在真实事件间）不推进基线（Issue !268）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-down-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 真实 codex total 单调递增；下跳只可能来自非模型事件（orca 分发样本组件全 0、
  // total=小值）。若下跳推进基线，下一真实事件 Δ 会虚增至全量累计
  writeRollout(work, 'rollout-down.jsonl', [
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 5000, total_tokens: 105000 },
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 5000, total_tokens: 105000 }),
    tokenEvent('2026-09-03T01:30:00.000Z',
      { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 542 },
      { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 542 }),
    tokenEvent('2026-09-03T02:00:00.000Z',
      { input_tokens: 50000, cached_input_tokens: 40000, output_tokens: 3000, total_tokens: 53000 },
      { input_tokens: 150000, cached_input_tokens: 120000, output_tokens: 8000, total_tokens: 158000 }),
  ]);

  const out = runCollectAi(work);
  const s = out.summary;
  assert.strictEqual(s.session_total_tokens, 158000, '下跳不推进基线：第二事件 Δ 基于首事件 105000');
  assert.strictEqual(s.session_input_tokens, 20000 + 10000);
});

test('codex resume 后首轮 auto-compact 合成事件（首事件即估算值）不计入（Issue !268）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-compact0-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // recompute_token_usage 的合成 last = 组件全 0 + total=上下文估算。
  // resume/fork 大历史后首轮触发 compact 时，它是文件首条 token_count 事件：
  // Σlast 口径会把 ~上下文窗口量级的估算值计入；组件和封顶后计 0
  writeRollout(work, 'rollout-compact0.jsonl', [
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 180000 },
      { input_tokens: 450000, cached_input_tokens: 300000, output_tokens: 22000, total_tokens: 472000 }),
    tokenEvent('2026-09-03T02:00:00.000Z',
      { input_tokens: 30000, cached_input_tokens: 20000, output_tokens: 1500, total_tokens: 31500 },
      { input_tokens: 480000, cached_input_tokens: 320000, output_tokens: 23500, total_tokens: 503500 }),
  ]);

  const out = runCollectAi(work);
  const s = out.summary;
  // 合成事件计 0；第二次响应 Δtotal = 503500 − 472000 = 31500
  assert.strictEqual(s.session_total_tokens, 31500, '只计第二次真实响应增量，估算事件计 0');
  assert.strictEqual(s.session_input_tokens, (30000 - 20000));
  assert.strictEqual(s.session_output_tokens, 1500);
});

test('codex 无 token_count 事件的会话跳过；混合 last/缺 last 只计 last', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-mixed-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 纯协作/中断会话：无 token_count → 不计
  writeRollout(work, 'rollout-empty.jsonl', [
    turnContext('gpt-5.6-sol'),
  ]);
  // 部分事件缺 last（零值回显）：只计有 last 的
  writeRollout(work, 'rollout-mixed.jsonl', [
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 500, cached_input_tokens: 300, output_tokens: 50, total_tokens: 550 },
      { input_tokens: 500, cached_input_tokens: 300, output_tokens: 50, total_tokens: 550 }),
    { timestamp: '2026-09-03T02:00:00.000Z', type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, total_tokens: 550 } } } },
  ]);

  const out = runCollectAi(work);
  assert.strictEqual(out.summary.session_count, 1);
  assert.strictEqual(out.summary.session_total_tokens, 550);
});

test('codex 回放簇剔除：Desktop 升级 fork 迁移的历史回放不计当日（gaozm 2026-09-04 实证）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-replay-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 文件 A：35 条回放事件挤在 3.5s 内（迁移时刻时间戳，total 单调递增到 350000），
  // 随后 60s 后的真实事件（fork 自身新工作，Δ=1100）必须保留
  const linesA = [turnContext('gpt-5.6-sol')];
  const base = Date.parse('2026-09-03T01:00:00.000Z');
  let running = 0;
  for (let i = 0; i < 35; i++) {
    running += 10000;
    linesA.push(tokenEvent(
      new Date(base + i * 100).toISOString(),
      { input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 1000, total_tokens: 10000 },
      { input_tokens: running * 0.9, cached_input_tokens: running * 0.8, output_tokens: running * 0.1, total_tokens: running },
    ));
  }
  // 尾巴 Δ：input +1000（含 cached +800）、output +100 → total +1100，组件和与 Δtotal 一致
  linesA.push(tokenEvent('2026-09-03T01:01:00.000Z',
    { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, total_tokens: 1100 },
    { input_tokens: 316000, cached_input_tokens: 280800, output_tokens: 35100, total_tokens: 351100 }));

  // 文件 B：整文件回放（40 条挤在 4s 内，无真实尾巴）→ 整跳过，不计会话
  const linesB = [turnContext('gpt-5.6-sol')];
  let runningB = 0;
  for (let i = 0; i < 40; i++) {
    runningB += 5000;
    linesB.push(tokenEvent(
      new Date(base + i * 100).toISOString(),
      { input_tokens: 4500, cached_input_tokens: 4000, output_tokens: 500, total_tokens: 5000 },
      { input_tokens: runningB * 0.9, cached_input_tokens: runningB * 0.8, output_tokens: runningB * 0.1, total_tokens: runningB },
    ));
  }

  // 文件 C：20 条 < 30 阈值的同间距事件（不判回放）+ 60s 后真实事件 → 全部计入
  const linesC = [turnContext('gpt-5.6-sol')];
  let runningC = 0;
  for (let i = 0; i < 20; i++) {
    runningC += 100;
    linesC.push(tokenEvent(
      new Date(base + 60000 + i * 100).toISOString(),
      { input_tokens: 90, cached_input_tokens: 80, output_tokens: 10, total_tokens: 100 },
      { input_tokens: runningC * 0.9, cached_input_tokens: runningC * 0.8, output_tokens: runningC * 0.1, total_tokens: runningC },
    ));
  }
  // 尾巴 Δ：input +1000（含 cached +500）、output +100 → total +1100
  linesC.push(tokenEvent('2026-09-03T01:03:00.000Z',
    { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100, total_tokens: 1100 },
    { input_tokens: 2800, cached_input_tokens: 2100, output_tokens: 300, total_tokens: 3100 }));

  writeRollout(work, 'rollout-replay-fork.jsonl', linesA);
  writeRollout(work, 'rollout-replay-only.jsonl', linesB);
  writeRollout(work, 'rollout-fast-real.jsonl', linesC);

  const out = runCollectAi(work);
  const s = out.summary;

  // A：回放簇 350000 全部剔除，只计尾巴 Δ=1100
  // B：整文件回放 → 0
  // C：20 条真实快速事件（<30 阈值不误杀）+ 尾巴 1100 = 3100
  assert.strictEqual(s.session_total_tokens, 1100 + 3100);
  assert.strictEqual(s.session_count, 2, '回放-only 文件不计会话');
  assert.strictEqual(s.session_cache_read_input_tokens, 800 + (20 * 80) + 500);
  assert.strictEqual(s.session_output_tokens, 100 + (20 * 10) + 100);
});

// ── Issue !276 验收 fixture 补全：三层 fork、>2^31 ──

test('codex 三层 fork（parent→child→grandchild）继承前缀不重复累加（Issue !276 验收5）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-fork3-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // parent：真实两请求，生命周期 total 到 1160
  writeRollout(work, 'rollout-p.jsonl', [
    turnContext('gpt-5.6-sol'),
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: 800, cached_input_tokens: 600, output_tokens: 200, total_tokens: 1000 },
      { input_tokens: 800, cached_input_tokens: 600, output_tokens: 200, total_tokens: 1000 }),
    tokenEvent('2026-09-03T01:10:00.000Z',
      { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20, total_tokens: 120 },
      { input_tokens: 900, cached_input_tokens: 650, output_tokens: 220, total_tokens: 1120 }),
    tokenEvent('2026-09-03T01:20:00.000Z',
      { input_tokens: 30, cached_input_tokens: 0, output_tokens: 10, total_tokens: 40 },
      { input_tokens: 930, cached_input_tokens: 650, output_tokens: 230, total_tokens: 1160 }),
  ]);

  // child（full-history fork）：首事件 total 已继承 parent 全部 1160，last 仅自己的真实增量
  writeRollout(work, 'rollout-c.jsonl', [
    turnContext('gpt-5.6-sol'),
    tokenEvent('2026-09-03T02:00:00.000Z',
      { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20, total_tokens: 120 },
      { input_tokens: 1030, cached_input_tokens: 700, output_tokens: 250, total_tokens: 1280 }),
    tokenEvent('2026-09-03T02:10:00.000Z',
      { input_tokens: 40, cached_input_tokens: 0, output_tokens: 10, total_tokens: 50 },
      { input_tokens: 1070, cached_input_tokens: 700, output_tokens: 260, total_tokens: 1330 }),
  ]);

  // grandchild（孙层，再继承 child）：首事件同样只按 last 计
  writeRollout(work, 'rollout-g.jsonl', [
    turnContext('gpt-5.6-sol'),
    tokenEvent('2026-09-03T03:00:00.000Z',
      { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3, total_tokens: 10 },
      { input_tokens: 1077, cached_input_tokens: 700, output_tokens: 263, total_tokens: 1340 }),
  ]);

  const s = runCollectAi(work).summary;
  // 朴素逐文件累计末值求和 = 1160+1330+1340 = 3830；去重后真实 total = 1160+120+50+10 = 1340
  assert.strictEqual(s.session_total_tokens, 1340, '三层继承前缀均不重复计入');
  // 净 input（与 Claude 口径一致扣 cached）：(800-600)+(100-50)+30 + child(100-50)+40 + grandchild 7 = 377
  assert.strictEqual(s.session_input_tokens, 377);
  assert.strictEqual(s.session_output_tokens, 263); // 200+20+10 | 20+10 | 3
  assert.strictEqual(s.session_cache_read_input_tokens, 700);
  assert.strictEqual(s.session_count, 3);
});

test('codex 大数（>2^31）精确累加不溢出（Issue !276 验收5）', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cai-cdx-big-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  const BIG = 5_000_000_000; // > 2^31 且 > 2^32
  writeRollout(work, 'rollout-big.jsonl', [
    turnContext('gpt-5.6-sol'),
    tokenEvent('2026-09-03T01:00:00.000Z',
      { input_tokens: BIG + 1000, cached_input_tokens: BIG, output_tokens: 2000, total_tokens: BIG + 3000 },
      { input_tokens: BIG + 1000, cached_input_tokens: BIG, output_tokens: 2000, total_tokens: BIG + 3000 }),
    tokenEvent('2026-09-03T02:00:00.000Z',
      { input_tokens: 500, cached_input_tokens: 0, output_tokens: 100, total_tokens: 600 },
      { input_tokens: BIG + 1500, cached_input_tokens: BIG, output_tokens: 2100, total_tokens: BIG + 3600 }),
  ]);

  const s = runCollectAi(work).summary;
  assert.strictEqual(s.session_total_tokens, BIG + 3600);
  assert.strictEqual(s.session_cache_read_input_tokens, BIG);
  assert.strictEqual(s.session_input_tokens, 1500); // 净 input（BIG+1500 扣 BIG）
  assert.strictEqual(s.session_output_tokens, 2100);
});
