#!/usr/bin/env node
// concerns-gate.mjs — pre-commit P0/P1 concerns gate (change concerns-commit-gate).
//
// Verdict tiers (design D1, mirrors advance.countOpenP0FromConcerns semantics):
//   P0: only resolved (or close synonym, via isResolvedStatus) passes —
//       deferred/dismissed/open/missing all block.
//   P1: anything but open passes (resolved/deferred/dismissed/dirty words) —
//       open/missing block. Aligned with the pipeline's P1<=2 tolerance.
//   P2: never blocks — only OPEN P2 is surfaced as a non-blocking reminder.
//
// Author scoping (Issue !180): blocking P0/P1 and P2 reminders only count when
// the concern's responsible person (`author`, a git 用户名) matches the
// committing user (passed as --user/--email from the pre-commit hook). Another
// person's open P0/P1 must not block this commit. Missing-author concerns
// (legacy data) are skipped — collect-ai.js --user parity. When neither
// --user nor --email is passed (identity unavailable), the gate FAILS OPEN:
// nothing blocks and nothing is reminded.
//
// Active change discovery (design D2): unarchived change dir × shared-state
// concerns.json × liveness — pipeline in progress (state exists, no top-level
// completed_at) is always checked; natural changes only within WINDOW_DAYS.
//
// Exit codes (design D4): 0 pass (silent, incl. no active candidates; P2
// reminders print a non-blocking notice) / 1 block (actionable Chinese listing
// on stdout) / 2 checker unavailable or unparseable data (fail-open: caller
// warns and lets the commit through).
//
// Known superset vs advance.countOpenP0FromConcerns: the inline reader only
// recognizes {concerns}/{p0} shapes; this gate also blocks bare-array P0s.
// Status-level verdicts are identical (both defer to isResolvedStatus).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isResolvedStatus } from './lib/concerns.js';
import { PROJECT_ROOT, getArg } from './lib/constants.js';

const DAY_MS = 24 * 3600 * 1000;
// Keep in sync with daily-report collect-ai.js CONCERN_WINDOW_DAYS —
// tests/concerns-gate.test.mjs asserts the two constants stay equal.
export const WINDOW_DAYS = 7;

/** Flatten any of the three historical schemas into items carrying severity. */
export function collectConcernsWithSeverity(content) {
  const items = [];
  if (Array.isArray(content)) {
    items.push(...content);
  } else if (content && typeof content === 'object') {
    if (Array.isArray(content.concerns)) items.push(...content.concerns);
    if (Array.isArray(content.p0)) items.push(...content.p0.map((c) => ({ ...c, severity: c.severity || 'P0' })));
    if (Array.isArray(content.p1)) items.push(...content.p1.map((c) => ({ ...c, severity: c.severity || 'P1' })));
    if (Array.isArray(content.p2)) items.push(...content.p2.map((c) => ({ ...c, severity: c.severity || 'P2' })));
  }
  return items.filter(Boolean);
}

/** Tiered verdict (D1). Returns { p0Blocking, p1Blocking, p2Reminders } arrays. */
export function evaluateConcerns(content) {
  const p0Blocking = [];
  const p1Blocking = [];
  const p2Reminders = [];
  for (const item of collectConcernsWithSeverity(content)) {
    const sev = String(item.severity ?? '').toUpperCase();
    if (sev === 'P0') {
      // deferred/dismissed/open/missing all count as unresolved for P0.
      if (!isResolvedStatus(item.status)) p0Blocking.push(item);
    } else if (sev === 'P1') {
      // missing status defaults to open (normalizeConcerns semantics).
      const st = String(item.status ?? 'open').trim().toLowerCase();
      if (st === 'open') p1Blocking.push(item);
    } else if (sev === 'P2') {
      // P2 never blocks; only OPEN ones are surfaced as a reminder.
      const st = String(item.status ?? 'open').trim().toLowerCase();
      if (st === 'open') p2Reminders.push(item);
    }
  }
  return { p0Blocking, p1Blocking, p2Reminders };
}

/** Active change discovery (D2): [{ change, concernsPath }]. */
export function listActiveChanges(root) {
  const changesDir = join(root, '.harness', 'spec', 'changes');
  const sharedDir = join(root, '.harness', 'shared-state');
  if (!existsSync(changesDir) || !existsSync(sharedDir)) return [];
  const active = [];
  const now = Date.now();
  for (const name of readdirSync(changesDir)) {
    const concernsPath = join(sharedDir, name, 'concerns.json');
    if (!existsSync(concernsPath)) continue;
    const statePath = join(root, '.harness', 'tasks', name, 'pipeline-state.json');
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        if (state.completed_at) continue; // pipeline finished — archived-equivalent
      } catch {
        // Corrupt state file: treat as in-progress (fail-closed direction).
      }
      active.push({ change: name, concernsPath });
    } else {
      // Natural change (no pipeline): only within the concern window.
      try {
        if (now - statSync(concernsPath).mtimeMs <= WINDOW_DAYS * DAY_MS) {
          active.push({ change: name, concernsPath });
        }
      } catch {
        // stat failed: skip silently (treated as out-of-window).
      }
    }
  }
  return active;
}

/** Identity set from git user.name / user.email / email local-part. */
export function buildIdentitySet(user, email) {
  const ids = new Set();
  const add = (v) => {
    const s = String(v ?? '').trim();
    if (s) ids.add(s);
  };
  add(user);
  add(email);
  if (email && String(email).includes('@')) add(String(email).trim().split('@')[0]);
  return ids;
}

/**
 * True when a concern's responsible person (author, a git 用户名 per
 * references/shared-state.md) matches one of the current user's identities.
 * Missing author (legacy data) is un-attributable → returns false, so it never
 * blocks the commit (collect-ai.js --user parity, Issue !186).
 */
export function isConcernMine(author, identities) {
  const a = String(author ?? '').trim();
  if (!a) return false;
  return identities.has(a);
}

/**
 * Combine discovery + verdict, scoped to the committing user's own concerns.
 * Returns { blocking: [{change, item}], p2Reminders: [{change, item}], unparseable: [{change, error}] }.
 *
 * user/email come from the pre-commit git identity (`git config user.name/email`).
 * Blocking P0/P1 only counts when the concern's responsible person is the
 * committing user — another person's open P0/P1 must not block this commit.
 * P2 (open) is collected as a non-blocking reminder. When BOTH user and email
 * are empty (identity unavailable), the gate FAILS OPEN: nothing blocks and
 * nothing is reminded — blocking on every concern is too heavy a blast radius
 * (a pre-commit identity hiccup would freeze every commit).
 */
export function runGate(root, user = '', email = '') {
  const blocking = [];
  const p2Reminders = [];
  const unparseable = [];
  const identities = buildIdentitySet(user, email);
  const filter = identities.size > 0;
  const isMine = (item) => filter && isConcernMine(item.author, identities);
  for (const { change, concernsPath } of listActiveChanges(root)) {
    let content;
    try {
      content = JSON.parse(readFileSync(concernsPath, 'utf8'));
    } catch (e) {
      unparseable.push({ change, error: e.message });
      continue;
    }
    const { p0Blocking, p1Blocking, p2Reminders: p2 } = evaluateConcerns(content);
    for (const item of p0Blocking) if (isMine(item)) blocking.push({ change, item, severity: 'P0' });
    for (const item of p1Blocking) if (isMine(item)) blocking.push({ change, item, severity: 'P1' });
    for (const item of p2) if (isMine(item)) p2Reminders.push({ change, item });
  }
  return { blocking, p2Reminders, unparseable };
}

function main() {
  const user = getArg(process.argv, '--user');
  const email = getArg(process.argv, '--email');
  let result;
  try {
    result = runGate(PROJECT_ROOT, user, email);
  } catch (e) {
    console.log(`[concerns-gate] 检查器异常（fail-open 放行）: ${e.message}`);
    process.exit(2);
  }
  // Blocking outranks unparseable (Reviewer P1-01): one corrupt concerns.json
  // must not open the gate while another active change still has open P0/P1.
  if (result.blocking.length === 0) {
    if (result.unparseable.length > 0) {
      for (const { change, error } of result.unparseable) {
        console.log(`[concerns-gate] concerns.json 不可解析（change: ${change}, fail-open 放行）: ${error}`);
      }
      process.exit(2);
    }
    // P2 reminder: non-blocking, only the committing user's own open P2.
    if (result.p2Reminders.length > 0) {
      console.log('[concerns-gate] 存在未处理的 P2 问题（不阻塞提交，建议评估是否有必要修复）:');
      for (const { change, item } of result.p2Reminders) {
        console.log(`  - P2 ${String(item.id ?? '?')} ${String(item.file ?? '?')}:${String(item.line ?? '?')} ${String(item.description ?? '')} (change: ${change})`);
      }
      console.log('如需处置：node .claude/skills/rd-auto/scripts/orchestrator.js resolve-concern <change> --concern-id <id>');
    }
    process.exit(0); // pass (silent, or with P2 reminder on stdout)
  }
  const byChange = new Map();
  for (const b of result.blocking) {
    if (!byChange.has(b.change)) byChange.set(b.change, []);
    byChange.get(b.change).push(b);
  }
  console.log('[concerns-gate] 检测到未清零 P0/P1 问题，提交被阻止：');
  for (const [change, list] of byChange) {
    console.log(`  change: ${change}`);
    for (const { severity, item } of list) {
      console.log(`  - ${severity} ${String(item.id ?? '?')} ${String(item.file ?? '?')}:${String(item.line ?? '?')} ${String(item.description ?? '')}`);
    }
  }
  console.log('修复路径（禁止直接编辑 concerns.json 造假状态，须走 resolve-concern 留审计痕）:');
  for (const [change, list] of byChange) {
    for (const { item } of list) {
      console.log(`  node .claude/skills/rd-auto/scripts/orchestrator.js resolve-concern ${change} --concern-id ${String(item.id ?? '?')}`);
    }
  }
  console.log('判定标准: P0 须 resolved；P1 须非 open（resolved/deferred/dismissed 均可）。全部处置后重新提交。');
  process.exit(1);
}

// CLI guard: importing this module (tests) must not trigger the gate.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
