// lib/advance.js — Pipeline advance logic (advanceImpl, teamAdvance, helpers)
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  PROJECT_ROOT, RULES_PATH, errExit, debugLog, METRICS_THROTTLE_MS, SCRIPTS_DIR,
  REWORK_TARGET_ROLES
} from './constants.js';
import { parseRules, loadRulesYaml, routeRework, buildReworkResponse, checkCircuitBreaker } from './transitions.js';
import {
  stateLoad, stateSave, statePath, getTasksDir,
  markSkippedPhase, unmarkSkippedPhase, updatePhaseProgressMetrics,
  stateListAll, atomicWriteJson
} from './state-store.js';
import { computeStats, formatDuration } from './stats.js';
import {
  determineComplexity, parseTasksMd, integrateWorktreeArtifacts, fanoutDispatchPlan, cleanupWorktrees, cleanupOrphanWorktrees
} from './fanout.js';
import { isResolvedStatus, deferOpenP1s } from './concerns.js';

// Re-export errExit for spec compliance (errExit is defined in constants.js for shared use)
// Also re-export for backward compatibility
export { errExit };
export { formatDuration };

// ─── Helpers ───

export function getRdSkill(rules, phase) {
  const map = rules.phaseSkillMap;
  if (!map || !map[phase]) return null;
  return map[phase].rd_skill || null;
}

export function getRole(rules, phase) {
  const map = rules.phaseSkillMap;
  if (!map || !map[phase]) return null;
  return map[phase].role || null;
}

// resolveQuickFlowRole — Issue !162 fallback router for quick flow.
//
// Background: harness-rules.yaml sets role=null for quick flow's
// dispatch/verify/complete phases (design intent: intent-based routing).
// transitions.js parseRules filters those entries out of phaseSkillMap,
// so getRole() returns null → dispatch-prompt errors with
// "No agent definition for role 'null'".
//
// This fallback maps state.intent.intent_category to a concrete role
// for quick flow + dispatch phase only. Returns null otherwise (non-quick
// flow, non-dispatch phase, unknown category, quick_change with ≤2 files
// where the main session self-handles).
//
// Exported for unit testing (test_quick_flow_role_routing.sh).
export function resolveQuickFlowRole(state, phase) {
  if (!state || state.flow_type !== 'quick') return null;
  if (phase !== 'dispatch') return null;
  const cat = state.intent?.intent_category;
  switch (cat) {
    case 'bug_fix':        return 'developer';
    case 'code_review':    return 'reviewer';
    case 'testing':        return 'tester';
    case 'explore_design': return 'architect';
    case 'quick_change': {
      const n = (state.intent?.affected_files || []).length;
      return n >= 3 ? 'developer' : null;  // <=2 files: main session self-handles
    }
    default: return null;  // unknown category: conservative — let PM intervene
  }
}

// ─── Scoring Thresholds (from YAML, single source of truth) ───

function extractLower(condition) {
  const m = condition.match(/(\d+)\s*<=/);
  return m ? parseInt(m[1], 10) : null;
}

function extractGte(condition) {
  const m = condition.match(/>=\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export function getScoringThresholds(isHotfix) {
  if (isHotfix) return { debateTrigger: 70, pass: 70, condPass: 70 };
  try {
    const yaml = loadRulesYaml(RULES_PATH);
    const items = yaml?.scoring?.thresholds || [];
    let pass = 90, condPass = 80, debateTrigger = 75;
    for (const t of items) {
      if (t.action === 'pass') { const v = extractGte(t.condition); if (v !== null) pass = v; }
      if (t.action === 'conditional_pass') { const v = extractLower(t.condition); if (v !== null) condPass = v; }
      if (t.action === 'trigger_debate') { const v = extractLower(t.condition); if (v !== null) debateTrigger = v; }
    }
    return { debateTrigger, pass, condPass };
  } catch { return { debateTrigger: 75, pass: 90, condPass: 80 }; }
}

export function getDebateVerdictThresholds() {
  try {
    const yaml = loadRulesYaml(RULES_PATH);
    const items = yaml?.scoring?.debate_scoring?.verdict_thresholds || [];
    let pass = 80, condPass = 75;
    for (const t of items) {
      if (t.action === 'pass') { const v = extractGte(t.condition); if (v !== null) pass = v; }
      if (t.action === 'conditional_pass') { const v = extractLower(t.condition); if (v !== null) condPass = v; }
    }
    return { pass, condPass };
  } catch { return { pass: 80, condPass: 75 }; }
}

// Map a pipeline phase to its state.scores key.
// code-review's score is written under 'reviewer' (the reviewing role);
// every other phase keys by its own name. Extracted from the inline ternary
// previously duplicated at advanceImpl (state.scores write) and mark-dispatch
// (Fix B backfill) so both writers agree with resolveAdvanceScore's reader.
export function scoreRoleKey(phase) {
  return phase === 'code-review' ? 'reviewer' : phase;
}

// Resolve the score used by code-review / debate routing decisions.
// Issue !232 Bug1: `score ?? 0` read only the advance command's --score arg,
// so a main session that ran `mark-dispatch --score 84` then forgot to repeat
// --score on advance saw 0 < debateTrigger(75) → false rework → reviewer
// re-evaluated until rework_count=3 tripped the circuit breaker.
//
// Multi-layer fallback:
//   1. explicit advance --score arg (wins; preserves Acceptance 2)
//   2. state.scores[roleKey] — populated by mark-dispatch --score (Fix B)
//      or a prior advance --score on the same phase
//   3. current phase's last dispatch_history entry's score — defensive, in
//      case the Fix B backfill was skipped (legacy dispatch_history already
//      carries score since issue !168)
//   4. 0 — original "missing → 0" semantics (Acceptance 3)
//
// Returns { value, source } with source ∈
//   { 'explicit', 'state-scores', 'dispatch-history', 'zero' }.
// Callers SHOULD console.warn when source === 'dispatch-history' so the
// main session learns to pass --score explicitly next time.
export function resolveAdvanceScore(score, state, currentPhase) {
  // 1. Explicit advance --score wins. Note: score === 0 is a legitimate
  //    "fail" signal, so we guard on undefined/null, NOT truthiness.
  if (score !== undefined && score !== null) {
    return { value: score, source: 'explicit' };
  }

  const roleKey = scoreRoleKey(currentPhase);

  // 2. state.scores — must be a real number; null/undefined fall through.
  const fromState = state?.scores?.[roleKey];
  if (typeof fromState === 'number' && !Number.isNaN(fromState)) {
    return { value: fromState, source: 'state-scores' };
  }

  // 3. Defensive: last dispatch_history entry's score for the current phase.
  const phase = state?.pipeline?.[currentPhase];
  const hist = phase?.dispatch_history;
  if (Array.isArray(hist) && hist.length > 0) {
    const last = hist[hist.length - 1];
    const fromHist = last?.score;
    if (typeof fromHist === 'number' && !Number.isNaN(fromHist)) {
      return { value: fromHist, source: 'dispatch-history' };
    }
  }

  // 4. Original semantics: genuinely missing → 0 (route as fail / rework).
  return { value: 0, source: 'zero' };
}

export function getPreviousSummary(state, currentPhase) {
  const phaseOrder = ['intake', 'explore', 'propose', 'design-review', 'implement', 'test', 'code-review', 'debate', 'archive'];
  // issue !247: rework target role (developer/architect/tester) has no DAG
  // position — anchor the walk at the phase where the rework originated, so
  // dispatch-prompt shows the review context instead of '（无前一阶段）'.
  const anchor = (!phaseOrder.includes(currentPhase) && state.pending_rework?.previous_phase)
    ? state.pending_rework.previous_phase
    : currentPhase;
  const idx = phaseOrder.indexOf(anchor);
  if (idx <= 0) return '（无前一阶段）';
  for (let i = idx - 1; i >= 0; i--) {
    const prev = state.pipeline[phaseOrder[i]];
    if (!prev) continue;
    // issue !247 次要 bug: mark-dispatch --end 把 summary 写入 dispatch_history[].summary，
    // pipeline[phase].summary 仅在 advance 带 --summary 时刷新（否则恒为新阶段的 stale 值）。
    // 两个来源都查，取任一非空摘要。
    if (prev.summary) return prev.summary;
    const hist = prev.dispatch_history;
    if (Array.isArray(hist) && hist.length > 0) {
      const last = hist[hist.length - 1];
      if (last && last.summary) return last.summary;
    }
  }
  return '（无前一阶段摘要）';
}

// ─── Shared State Dir ───

function getSharedStateDir(changeName) {
  return join(PROJECT_ROOT, '.harness', 'shared-state', changeName);
}

// Count open P0 concerns from concerns.json — dual-schema compatible.
// Schema A (legacy/flat):  { concerns: [{ severity:'P0', status:'open'|'resolved', ... }] }
// Schema B (grouped/rules): { p0: [{ status:'open'|'resolved', ... }], p1: [...] }
// Returns 0 when concerns.json is missing, empty, or unparseable.
// Used by: (1) DONE_WITH_CONCERNS routing, (2) NEEDS_PM detection, (3) code-review P0 veto.
// Issue !259: 读侧容错——resolved 同义词（fixed/closed/done/已修复…，见 concerns.js
// RESOLVED_SYNONYMS）计为已关闭；未知 status 词（如 wontfix）按未决计。防止直改文件
// 绕过写入门禁产生的非规范词触发 P0 误否决。
function countOpenP0FromConcerns(changeName) {
  try {
    const p = join(getSharedStateDir(changeName), 'concerns.json');
    if (!existsSync(p)) return 0;
    const d = JSON.parse(readFileSync(p, 'utf8'));
    if (Array.isArray(d.concerns)) {            // flat schema {concerns:[{severity,status}]}
      return d.concerns.filter(c => c && c.severity === 'P0' && !isResolvedStatus(c.status)).length;
    }
    if (Array.isArray(d.p0)) {                  // grouped schema {p0:[{status}],p1:[...]}
      return d.p0.filter(c => c && !isResolvedStatus(c.status)).length;
    }
    return 0;
  } catch (e) { debugLog('countOpenP0: concerns.json parse failed —', e.message); return 0; }
}

// Reviewer P1-02: symmetric P1 counter — the conditional-pass gate falls back
// to the file when the caller omits p1_count (dispatch flow does not always
// pass it), so a change with 8 open P1s reworks instead of pass-and-defer-all.
function countOpenP1FromConcerns(changeName) {
  try {
    const p = join(getSharedStateDir(changeName), 'concerns.json');
    if (!existsSync(p)) return 0;
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const isOpen = (c) => c && String(c.status ?? 'open').trim().toLowerCase() === 'open';
    if (Array.isArray(d.concerns)) {
      return d.concerns.filter(c => c && c.severity === 'P1' && isOpen(c)).length;
    }
    if (Array.isArray(d.p1)) {
      return d.p1.filter(isOpen).length;
    }
    return 0;
  } catch (e) { debugLog('countOpenP1: concerns.json parse failed —', e.message); return 0; }
}

// Quick-flow auto-rework: collect the open P0/P1 concern ids so the dispatch
// prompt can hand the developer a targeted fix list. Tolerates legacy
// concern_id-keyed items (normalizeConcerns guarantees `id` on new writes).
function collectOpenConcernIds(changeName) {
  try {
    const p = join(getSharedStateDir(changeName), 'concerns.json');
    if (!existsSync(p)) return [];
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const lists = [];
    if (Array.isArray(d.concerns)) lists.push(...d.concerns.map(c => [c, null]));
    if (Array.isArray(d.p0)) lists.push(...d.p0.map(c => [c, 'P0']));
    if (Array.isArray(d.p1)) lists.push(...d.p1.map(c => [c, 'P1']));
    const ids = [];
    for (const [c, keySev] of lists) {
      if (!c) continue;
      const sev = String(c.severity ?? keySev ?? '').toUpperCase();
      const isOpen = String(c.status ?? 'open').trim().toLowerCase() === 'open';
      const unresolved = sev === 'P0' ? !isResolvedStatus(c.status) : isOpen;
      if ((sev === 'P0' || sev === 'P1') && unresolved) {
        ids.push(String(c.id ?? c.concern_id ?? ''));
      }
    }
    return ids.filter(Boolean);
  } catch (e) { debugLog('collectOpenConcernIds: parse failed —', e.message); return []; }
}

// concerns-commit-gate D6: pipeline tolerance paths (auto-promote / P1<=2
// conditional pass) write their decision back — tolerated open P1s become
// deferred so file state stops contradicting the pipeline verdict (and stops
// tripping the commit gate + daily-report stats). Atomic write, shape-preserving.
function deferOpenP1Concerns(changeName, deferredBy) {
  try {
    const p = join(getSharedStateDir(changeName), 'concerns.json');
    if (!existsSync(p)) return;
    const content = JSON.parse(readFileSync(p, 'utf8'));
    const n = deferOpenP1s(content, 'auto-promoted by pipeline', deferredBy, new Date().toISOString());
    if (n > 0) atomicWriteJson(p, content);
  } catch (e) { debugLog('deferOpenP1: write-back failed —', e.message); }
}

// ─── Inline Smoke Check ───

export function runSmokeCheck() {
  const compileCmds = {
    go:   { detect: 'go.mod',       cmd: 'go build ./... 2>&1 | tail -20' },
    tsjs: { detect: 'package.json',  cmd: 'npm run build 2>&1 | tail -20 || npx tsc --noEmit 2>&1 | tail -20' },
    py:   { detect: 'setup.py',     cmd: 'python3 -m py_compile $(find . -name "*.py" -not -path "./venv/*" | head -20) 2>&1 | tail -20' },
  };
  const lintCmds = {
    go:   'golangci-lint run --new-from-rev=HEAD~5 2>&1 | tail -20 || true',
    tsjs: 'npm run lint 2>&1 | tail -20 || npx eslint . 2>&1 | tail -20 || true',
    py:   'ruff check . 2>&1 | tail -20 || true',
  };

  let lang = null;
  if (existsSync(join(PROJECT_ROOT, 'go.mod')))         lang = 'go';
  else if (existsSync(join(PROJECT_ROOT, 'package.json'))) lang = 'tsjs';
  else if (existsSync(join(PROJECT_ROOT, 'setup.py')) ||
           existsSync(join(PROJECT_ROOT, 'pyproject.toml'))) lang = 'py';

  if (!lang) return { passed: true, summary: 'no build system detected, skip compile/lint' };

  const failures = [];
  if (compileCmds[lang]) {
    try {
      const result = execSync(compileCmds[lang].cmd, { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
      if (result.trim() && /error|fail|cannot|undefined|fatal/i.test(result)) {
        failures.push(`compile: ${result.trim().slice(0, 200)}`);
      }
    } catch (e) {
      failures.push(`compile failed: ${((e.stdout || '') + (e.stderr || '')).trim().slice(0, 200)}`);
    }
    if (lintCmds[lang]) {
      try {
        execSync(lintCmds[lang], { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        const out = ((e.stdout || '') + (e.stderr || '')).trim();
        if (out) failures.push(`lint: ${out.slice(0, 200)}`);
      }
    }
  }

  const hasCompileError = failures.some(f => f.startsWith('compile failed'));
  return {
    passed: !hasCompileError,
    summary: failures.length === 0 ? 'compile OK, lint OK' : failures.join('; '),
  };
}

// ─── Metrics Push ───

const METRICS_THROTTLE_FILE = join(tmpdir(), '.ai-dispatch-metrics-last-push');

export function tryPushMetrics(throttleMs = METRICS_THROTTLE_MS) {
  if (process.env.AI_DISPATCH_METRICS_DISABLED) return;

  try {
    const lastPush = parseInt(readFileSync(METRICS_THROTTLE_FILE, 'utf8').trim(), 10);
    if (!isNaN(lastPush) && (Date.now() - lastPush) < throttleMs) return;
  } catch (e) { debugLog('metrics throttle file read failed —', e.message); /* proceed */ }

  const pushMetricsPath = join(SCRIPTS_DIR, 'push-metrics.js');
  if (!existsSync(pushMetricsPath)) return;

  try { writeFileSync(METRICS_THROTTLE_FILE, String(Date.now()), 'utf8'); } catch (e) { debugLog('metrics throttle file write failed —', e.message); }

  try {
    const child = spawn(process.execPath, [pushMetricsPath], {
      detached: true, stdio: 'ignore',
      cwd: PROJECT_ROOT,
      env: { ...process.env },
    });
    child.unref();
  } catch (e) { debugLog('metrics push spawn failed —', e.message); }
}

// ─── Advanced Advance Implementation ───

export function advanceImpl(changeName, opts) {
  const rules = parseRules(RULES_PATH);
  const state = stateLoad(changeName);
  const { exit_status, score, p0_count, p1_count, summary, dimension, artifacts, rework_reason } = opts;
  const defaultDimension = state.docs_mode ? 'doc/ux_quality' : 'code/implementation';

  // Update current phase status
  const currentPhase = state.current_phase;
  if (currentPhase === 'pending' || currentPhase === 'completed') {
    // Starting fresh or already done
  } else if (state.pipeline[currentPhase]) {
    state.pipeline[currentPhase].status = exit_status === 'BLOCKED' ? 'blocked'
      : exit_status === 'DONE' ? 'done'
      : exit_status === 'DONE_WITH_CONCERNS' ? 'done_with_concerns'
      : exit_status === 'NEEDS_PM' ? 'needs_pm'
      : 'in_progress';
    if (exit_status) state.pipeline[currentPhase].exit_status = exit_status;
    if (summary) state.pipeline[currentPhase].summary = summary.slice(0, 500);
    if (score !== undefined && score !== null) {
      if (!state.scores) state.scores = {};
      state.scores[scoreRoleKey(currentPhase)] = score;
    }
    // Write artifacts and rework_reason to current phase
    if (artifacts && Array.isArray(artifacts) && artifacts.length > 0) {
      if (!state.pipeline[currentPhase].artifact_paths) state.pipeline[currentPhase].artifact_paths = [];
      state.pipeline[currentPhase].artifact_paths = state.pipeline[currentPhase].artifact_paths.concat(artifacts);
    }
    if (rework_reason) {
      if (!state.pipeline[currentPhase].rework_reasons) state.pipeline[currentPhase].rework_reasons = [];
      state.pipeline[currentPhase].rework_reasons.push(rework_reason);
    }
  }

  // T5: dispatch_efficiency — propose DONE updates first_artifact_at
  if (currentPhase === 'propose' && exit_status === 'DONE') {
    const now = new Date().toISOString();
    if (!state.dispatch_efficiency.first_artifact_at) {
      state.dispatch_efficiency.first_artifact_at = now;
    }
    state.dispatch_efficiency.pm_to_first_artifact_ms = new Date(now) - new Date(state.created_at);
  }

  // v3: quality_metrics incremental update
  if (!state.quality_metrics) {
    state.quality_metrics = {
      first_pass_rate: null, total_rework_loops: 0, automated_catches: 0,
      time_to_first_code_review_ms: null, total_wall_clock_ms: null,
      phases_completed: 0, phases_total: 0,
    };
  }
  if ((currentPhase === 'intake') &&
      (exit_status === 'BLOCKED' || exit_status === 'NEEDS_CONTEXT')) {
    state.quality_metrics.automated_catches++;
  }

  // Handle BLOCKED
  if (exit_status === 'BLOCKED') {
    state.blocked_count++;

    if (checkCircuitBreaker(state)) {
      stateSave(changeName, state);
      return {
        change_name: changeName,
        previous_phase: currentPhase,
        current_phase: currentPhase,
        next_action: 'escalate_to_pm',
        next_role: null, next_rd_skill: null, needs_pm: true,
        reason: `blocked_count (${state.blocked_count}) >= 3, circuit breaker triggered`,
        warnings: [],
      };
    }
    stateSave(changeName, state);
    return {
      change_name: changeName,
      previous_phase: currentPhase,
      current_phase: currentPhase,
      next_action: 'retry',
      next_role: null, next_rd_skill: null, needs_pm: false,
      reason: `BLOCKED, retrying (blocked_count: ${state.blocked_count}/3)`,
      warnings: [],
    };
  }

  // Handle NEEDS_CONTEXT (P0: Context Mode Upgrade Mechanism)
  if (exit_status === 'NEEDS_CONTEXT') {
    if (!state.context_upgrade_attempts) state.context_upgrade_attempts = 0;
    state.context_upgrade_attempts++;

    const currentMode = state.intent?.context_mode || 'full';

    const UPGRADE_PATH = {
      'minimal': 'read_only',
      'read_only': 'full',
      'full': 'full'
    };

    const nextMode = UPGRADE_PATH[currentMode];

    if (nextMode === currentMode || state.context_upgrade_attempts >= 2) {
      stateSave(changeName, state);
      return {
        change_name: changeName,
        previous_phase: currentPhase,
        current_phase: currentPhase,
        next_action: 'escalate_to_pm',
        next_role: null, next_rd_skill: null, needs_pm: true,
        reason: `NEEDS_CONTEXT escalation: ${currentMode} mode insufficient after ${state.context_upgrade_attempts} attempts`,
        warnings: [],
      };
    }

    if (!state.intent) state.intent = {};
    state.intent.context_mode = nextMode;
    state.intent.upgraded_at = new Date().toISOString();
    state.intent.upgraded_from = currentMode;

    stateSave(changeName, state);
    return {
      change_name: changeName,
      previous_phase: currentPhase,
      current_phase: currentPhase,
      next_action: 'dispatch',
      next_role: getRole(rules, currentPhase),
      next_rd_skill: getRdSkill(rules, currentPhase),
      needs_pm: false,
      reason: `Context mode upgraded: ${currentMode} → ${nextMode} (attempt ${state.context_upgrade_attempts}/2)`,
      warnings: [],
      context_mode: nextMode,
    };
  }

  // Handle NEEDS_PM — Worker explicitly declares a PM decision is required.
  // Stays on the current phase; does NOT increment blocked_count (distinct from BLOCKED).
  if (exit_status === 'NEEDS_PM') {
    if (state.pipeline[currentPhase]) {
      state.pipeline[currentPhase].status = 'needs_pm';
      state.pipeline[currentPhase].exit_status = 'NEEDS_PM';
      state.pipeline[currentPhase].completed_at = new Date().toISOString();
      if (summary) state.pipeline[currentPhase].summary = summary.slice(0, 500);
    }
    stateSave(changeName, state);
    return {
      change_name: changeName,
      previous_phase: currentPhase,
      current_phase: currentPhase,
      next_action: 'evaluate_concerns',
      next_role: null, next_rd_skill: null, needs_pm: true,
      reason: 'NEEDS_PM: Worker declared PM decision required',
      warnings: [],
    };
  }

  // Handle DONE_WITH_CONCERNS — for quick flow
  if (exit_status === 'DONE_WITH_CONCERNS' && state.flow_type === 'quick' && currentPhase === 'verify') {
    if (state.pipeline[currentPhase]) {
      state.pipeline[currentPhase].status = 'done_with_concerns';
      state.pipeline[currentPhase].exit_status = exit_status;
      state.pipeline[currentPhase].completed_at = new Date().toISOString();
      if (summary) state.pipeline[currentPhase].summary = summary.slice(0, 500);
      if (artifacts && Array.isArray(artifacts) && artifacts.length > 0) {
        if (!state.pipeline[currentPhase].artifact_paths) state.pipeline[currentPhase].artifact_paths = [];
        state.pipeline[currentPhase].artifact_paths = state.pipeline[currentPhase].artifact_paths.concat(artifacts);
      }
    }
    // PM directive (quality rule): quick flow must NOT silently swallow P0/P1.
    // Both severities auto-rework back to dispatch for targeted fix (dispatch
    // reads the concerns list, developer resolves, verify re-checks). Circuit
    // breaker escalates to PM at round 3. Only P2 (or no concerns) completes.
    const openP0 = countOpenP0FromConcerns(changeName);
    const openP1 = openP0 > 0 ? 0 : countOpenP1FromConcerns(changeName);
    if (openP0 > 0 || openP1 > 0) {
      const rounds = (state.rework_count.dispatch || 0) + 1;
      if (rounds >= 3) {
        stateSave(changeName, state);
        return {
          change_name: changeName,
          previous_phase: currentPhase,
          current_phase: currentPhase,
          next_action: 'evaluate_concerns',
          next_role: null, next_rd_skill: null, needs_pm: true,
          reason: `quick rework circuit breaker: round ${rounds} with ${openP0} open P0 / ${openP1} open P1, PM must evaluate`,
          warnings: [`dispatch rework count: ${rounds}/3`],
        };
      }
      state.rework_count.dispatch = rounds;
      state.pending_rework = {
        target_role: resolveQuickFlowRole(state, 'dispatch') || 'developer',
        previous_phase: 'verify',
        reason: `verify found ${openP0} open P0 / ${openP1} open P1 — targeted fix required`,
        rework_count: rounds,
        concern_ids: collectOpenConcernIds(changeName),
        pua_debugging_required: false,
      };
      // Reactivate dispatch (keep its history/artifacts) and reset verify so
      // the DAG re-enters it after the rework dispatch completes.
      const prevDispatch = state.pipeline.dispatch || {};
      state.pipeline.dispatch = {
        ...prevDispatch,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        rework_reasons: [...(prevDispatch.rework_reasons || []), `verify: ${openP0} P0 / ${openP1} P1 open`],
      };
      delete state.pipeline.verify.completed_at;
      delete state.pipeline.verify.exit_status;
      state.pipeline.verify.status = 'pending';
      state.current_phase = 'dispatch';
      stateSave(changeName, state);
      return {
        change_name: changeName,
        previous_phase: 'verify',
        current_phase: 'dispatch',
        next_action: 'rework',
        next_role: state.pending_rework.target_role, next_rd_skill: null, needs_pm: false,
        reason: `DONE_WITH_CONCERNS with ${openP0} open P0 / ${openP1} open P1 → auto-rework to dispatch (round ${rounds}/3)`,
        rework_count: state.rework_count,
        pua_debugging_required: false,
        warnings: [],
      };
    }
    state.current_phase = 'complete';
    stateSave(changeName, state);
    return {
      change_name: changeName,
      previous_phase: currentPhase,
      current_phase: 'complete',
      next_action: 'dispatch',
      next_role: null, next_rd_skill: null, needs_pm: false,
      reason: `verify DONE_WITH_CONCERNS -> complete (quick flow)`,
      warnings: [],
    };
  }

  // Handle DONE_WITH_CONCERNS — phase work completed.
  // Routing decision (design D1/D2 option A): the exit_status alone is NOT a stop signal.
  // Only an open P0 in concerns.json stops; P1/P2/observational concerns auto-promote to DONE.
  if (exit_status === 'DONE_WITH_CONCERNS') {
    if (state.pipeline[currentPhase]) {
      state.pipeline[currentPhase].completed_at = new Date().toISOString();
    }

    const openP0 = countOpenP0FromConcerns(changeName);

    if (openP0 > 0) {
      // True blocker: an open P0 concern exists — PM must evaluate.
      stateSave(changeName, state);
      return {
        change_name: changeName,
        previous_phase: currentPhase,
        current_phase: currentPhase,
        next_action: 'evaluate_concerns',
        next_role: null, next_rd_skill: null, needs_pm: true,
        reason: `DONE_WITH_CONCERNS with ${openP0} open P0 concern(s), PM must evaluate`,
        warnings: [],
      };
    }

    // No open P0: P1/P2/observational concerns auto-resolve and advance (D2 option A).
    // D6 write-back: the tolerated open P1s become deferred so file state matches
    // this routing decision (otherwise the commit gate blocks a blessed change).
    deferOpenP1Concerns(changeName, 'pipeline');
    const promotedSummary = (summary || '') + ' [auto-promoted: non-P0 concerns]';
    if (state.pipeline[currentPhase]) {
      state.pipeline[currentPhase].status = 'done';
      state.pipeline[currentPhase].exit_status = 'DONE';
      state.pipeline[currentPhase].summary = promotedSummary.slice(0, 500);
    }
    stateSave(changeName, state);
    return advance(changeName, {
      exit_status: 'DONE', score, p0_count, p1_count,
      summary: promotedSummary,
      dimension, artifacts, rework_reason,
    });
  }

  // DONE — find next phase via transitions
  let transKey;
  switch (state.flow_type) {
    case 'docs': transKey = 'docsTransitions'; break;
    case 'hotfix': transKey = 'hotfixTransitions'; break;
    case 'quick': transKey = 'quickTransitions'; break;
    case 'config-change': transKey = 'configChangeTransitions'; break;
    // Issue !283: test-only 此前无 case，落入 default development 链（intake→explore），
    // explore 不在其 pipeline map，mark-dispatch 报 No active phase 死路。
    case 'test-only': transKey = 'testOnlyTransitions'; break;
    default: transKey = 'transitions'; break;
  }
  const transitions = rules[transKey];
  let nextPhase = null;
  let nextAction = 'dispatch';
  let reason = '';

  // Special routing for code-review phase
  if (currentPhase === 'code-review' && exit_status === 'DONE') {
    // Issue !232 Bug1: multi-layer fallback so a main session that ran
    // `mark-dispatch --score 84` but forgot advance --score still routes on 84.
    const { value: s, source: scoreSource } = resolveAdvanceScore(score, state, currentPhase);
    if (scoreSource === 'dispatch-history') {
      console.warn(`[harness] advance: score 未传，已从 dispatch_history 兜底为 ${s}，建议 advance 显式带 --score`);
    }

    let p0 = p0_count ?? 0;
    if (p0 === 0) {
      // Supplement from concerns.json — dual-schema compatible (fixes §1.3 bug where
      // grouped {p0:[]} schema was previously missed by flat-only reading).
      p0 = countOpenP0FromConcerns(changeName);
    }
    const { debateTrigger, pass: passThreshold, condPass: condPassThreshold } = getScoringThresholds(state.hotfix_mode);

    if (p0 > 0) {
      const rework = routeRework(state, dimension || defaultDimension, RULES_PATH);
      stateSave(changeName, state);
      return buildReworkResponse(changeName, currentPhase, rework, `P0 veto (p0_count=${p0}), rework routed to ${rework.targets.join(', ')}`, state, rules);
    }

    if (s >= passThreshold) {
      nextPhase = 'archive';
      markSkippedPhase(state, 'debate');
      reason = `score ${s} >= ${passThreshold}, no P0 issues → ${nextPhase}`;
    } else if (s >= condPassThreshold) {
      const p1 = p1_count ?? 0;
      // P1 fallback mirrors the p0 pattern above: an omitted/zero arg defers
      // to the file so the P1<=2 contract cannot be satisfied by silence.
      let p1Effective = p1;
      if (p1 === 0) p1Effective = countOpenP1FromConcerns(changeName);
      if (p1Effective <= 2) {
        nextPhase = 'archive';
        markSkippedPhase(state, 'debate');
        // D6 write-back: the tolerated open P1s become deferred (see deferOpenP1Concerns).
        deferOpenP1Concerns(changeName, 'pipeline');
        reason = `score ${s} >= ${condPassThreshold}, P1 count ${p1Effective} <= 2 → ${nextPhase} (reviewer fixes P1)`;
      } else {
        const rework = routeRework(state, 'code/implementation', RULES_PATH);
        stateSave(changeName, state);
        return buildReworkResponse(changeName, currentPhase, rework, `score ${s} >= ${condPassThreshold} but P1 count ${p1} > 2, developer fixes P1`, state, rules);
      }
    } else if (s >= debateTrigger) {
      nextPhase = 'debate';
      unmarkSkippedPhase(state, 'debate');
      reason = `score ${s} in [${debateTrigger},${condPassThreshold}), triggers debate`;
    } else {
      const rework = routeRework(state, dimension || defaultDimension, RULES_PATH);
      stateSave(changeName, state);
      return buildReworkResponse(changeName, currentPhase, rework, `score ${s} < ${debateTrigger}, rework routed to ${rework.targets.join(', ')} (${dimension || defaultDimension})`, state, rules);
    }
  } else if (currentPhase === 'debate' && exit_status === 'DONE') {
    // Same score-fallback fix as code-review branch above (Issue !232 Bug1).
    const { value: s, source: scoreSource } = resolveAdvanceScore(score, state, currentPhase);
    if (scoreSource === 'dispatch-history') {
      console.warn(`[harness] advance: score 未传，已从 dispatch_history 兜底为 ${s}，建议 advance 显式带 --score`);
    }
    const dv = getDebateVerdictThresholds();
    if (s >= dv.pass) {
      nextPhase = 'archive';
      nextAction = 'dispatch';
      reason = `debate final score ${s} >= ${dv.pass}, pass → ${nextPhase}`;
    } else if (s >= dv.condPass) {
      nextPhase = 'archive';
      nextAction = 'dispatch';
      reason = `debate final score ${s} in [${dv.condPass},${dv.pass}), conditional pass → ${nextPhase} with conditions`;
    } else {
      const rework = routeRework(state, dimension || defaultDimension, RULES_PATH);
      stateSave(changeName, state);
      return buildReworkResponse(changeName, currentPhase, rework, `debate final score ${s} < ${dv.condPass}, block → rework ${rework.targets.join(', ')}`, state, rules);
    }
  } else if (REWORK_TARGET_ROLES.has(currentPhase) && exit_status === 'DONE') {
    // issue !247: rework target role phase (developer/architect/tester) completed
    // → return to code-review for re-scoring. Rework targets are role names (see
    // buildReworkResponse), never real DAG phases, so standard transition matching
    // would find no `from:` entry and escalate to PM ("no transition found"). This
    // branch closes the rework loop: fix lands → code-review re-review → fresh score.
    nextPhase = 'code-review';
    reason = `rework target ${currentPhase} DONE → code-review re-review`;
  } else {
    // Standard transition matching
    const match = transitions.find(t => t.from === currentPhase && (t.exit === 'DONE' || t.exit === exit_status || !t.exit));
    if (match) {
      nextPhase = match.to;
      reason = `${currentPhase} DONE → ${nextPhase}`;
    } else if (currentPhase === 'pending') {
      nextPhase = state.hotfix_mode ? 'implement' : 'intake';
      reason = `starting pipeline at ${nextPhase}`;
    }
  }

  // Check if propose done → verify rd artifacts
  if (currentPhase === 'propose' && (nextPhase === 'implement' || nextPhase === 'design-review')) {
    try {
      const rdOut = execSync(`rd status --change "${changeName}" --json`, { encoding: 'utf8', cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
      const rdStatus = JSON.parse(rdOut);
      if (!rdStatus.isComplete) {
        stateSave(changeName, state);
        return {
          change_name: changeName,
          previous_phase: currentPhase,
          current_phase: currentPhase,
          next_action: 'wait_for_artifacts',
          next_role: 'architect', next_rd_skill: '/rd:propose', needs_pm: false,
          reason: `propose DONE but rd status shows artifacts incomplete (${rdStatus.artifacts?.filter(a => a.status !== 'done')?.length || '?'} remaining), re-dispatch architect`,
          warnings: [],
        };
      }
    } catch (e) { debugLog('rd status not available —', e.message); }

    // Validate design.md Decisions section
    try {
      const designPaths = [
        join(PROJECT_ROOT, '.harness', 'spec', 'changes', changeName, 'design.md'),
        join(PROJECT_ROOT, 'openspec', 'changes', changeName, 'design.md'),
      ];
      const designPath = designPaths.find(p => existsSync(p));
      if (designPath) {
        const designContent = readFileSync(designPath, 'utf8');
        const decisionsSection = designContent.match(/## Decisions\s*\n([\s\S]*?)(?=\n## )/);
        if (decisionsSection) {
          const decisions = decisionsSection[1].split(/\n### D\d+/).filter(s => s.trim());
          const missingAlternatives = [];
          decisions.forEach((block, i) => {
            const hasAlt = /替代方案|Alternatives?|备选|否决理由|reason not adopted/i.test(block);
            if (!hasAlt) missingAlternatives.push(`D${i + 1}`);
          });
          if (missingAlternatives.length > 0) {
            stateSave(changeName, state);
            return {
              change_name: changeName,
              previous_phase: currentPhase,
              current_phase: currentPhase,
              next_action: 'dispatch',
              next_role: 'architect', next_rd_skill: '/rd:propose', needs_pm: false,
              reason: `design.md Decisions section incomplete: ${missingAlternatives.join(', ')} missing alternatives/rejection rationale. Every decision MUST have at least 1 rejected alternative with reason.`,
              warnings: [`decision-gate: ${missingAlternatives.join(', ')} lack alternatives`],
            };
          }
        }
      }
    } catch (e) { debugLog('design.md validation failed —', e.message); }
  }

  // Design-review complexity gate
  if (nextPhase === 'design-review') {
    const complexity = determineComplexity(changeName);
    if (state.flow_type === 'refactor') {
      reason += `, complexity=${complexity}, design-review required (refactor flow_type)`;
    } else if (complexity === 'S' || complexity === 'M') {
      nextPhase = 'implement';
      markSkippedPhase(state, 'design-review');
      reason += `, design-review skipped (complexity=${complexity}) → implement`;
    } else {
      reason += `, complexity=${complexity}, design-review required`;
    }
  }

  // Inline smoke check: implement DONE → test triggers compile+lint
  if (currentPhase === 'implement' && nextPhase === 'test' && exit_status === 'DONE') {
    const smokeResult = runSmokeCheck();
    console.error(`[smoke] inline check: ${smokeResult.passed ? 'PASS' : 'FAIL'} — ${smokeResult.summary}`);
    if (!smokeResult.passed) {
      state.rework_count.developer = (state.rework_count.developer || 0) + 1;
      const nextPhase = 'implement';
      if (state.pipeline[nextPhase]) {
        state.pipeline[nextPhase].status = 'in_progress';
        state.pipeline[nextPhase].last_resumed_at = new Date().toISOString();
      }
      state.current_phase = nextPhase;
      stateSave(changeName, state);
      return {
        change_name: changeName,
        previous_phase: currentPhase,
        current_phase: nextPhase,
        next_action: 'rework',
        next_role: getRole(rules, nextPhase),
        next_rd_skill: getRdSkill(rules, nextPhase),
        needs_pm: false,
        reason: `inline smoke BLOCKED (compile/lint failed), routing back to implement for fix`,
        warnings: [smokeResult.summary],
      };
    }
  }

  // Automated phases
  if (nextPhase === 'intake') {
    nextAction = 'automated';
  }

  // Auto-complete: terminal phase DONE → task completed
  if (nextPhase === 'complete') {
    if (state.pipeline[currentPhase]) {
      state.pipeline[currentPhase].status = 'done';
      state.pipeline[currentPhase].exit_status = exit_status;
      if (!state.pipeline[currentPhase].completed_at) {
        state.pipeline[currentPhase].completed_at = new Date().toISOString();
      }
    }
    state.completed_at = new Date().toISOString();
    stateSave(changeName, state);
    // archive→complete: move task dir to archive/
    if (currentPhase === 'archive') {
      try {
        const taskDir = join(getTasksDir(), changeName);
        const archiveRoot = join(getTasksDir(), 'archive');
        if (!existsSync(archiveRoot)) mkdirSync(archiveRoot, { recursive: true });
        const archiveTarget = join(archiveRoot, changeName);
        if (existsSync(taskDir) && !existsSync(archiveTarget)) {
          renameSync(taskDir, archiveTarget);
        }
      } catch (e) {
        console.error(`[archive] task dir cleanup failed: ${e.message}`);
      }
    }
    tryPushMetrics(500);
    return {
      change_name: changeName,
      previous_phase: currentPhase,
      current_phase: 'complete',
      next_action: 'completed',
      next_role: null, next_rd_skill: null, needs_pm: false,
      reason: `${currentPhase} DONE → task automatically completed`,
      warnings: [],
    };
  }

  if (!nextPhase) {
    stateSave(changeName, state);
    return {
      change_name: changeName,
      previous_phase: currentPhase,
      current_phase: currentPhase,
      next_action: 'unknown',
      next_role: null, next_rd_skill: null, needs_pm: true,
      reason: `no transition found for phase=${currentPhase} exit=${exit_status}`,
      warnings: [],
    };
  }

  // Determine if PM needed
  let needsPm = false;

  // Update state — record completed_at for current phase before advancing
  if (state.pipeline[currentPhase]) {
    state.pipeline[currentPhase].completed_at = new Date().toISOString();

    // v3: Calculate first_pass
    if (state.pipeline[currentPhase].dispatch_history) {
      const history = state.pipeline[currentPhase].dispatch_history;
      state.pipeline[currentPhase].first_pass = history.length <= 1 && exit_status === 'DONE';
    } else if (exit_status === 'DONE') {
      state.pipeline[currentPhase].first_pass = true;
    }
  }

  state.current_phase = nextPhase;
  if (state.pipeline[nextPhase]) {
    const now = new Date().toISOString();
    state.pipeline[nextPhase].status = 'in_progress';
    if (!state.pipeline[nextPhase].started_at) {
      state.pipeline[nextPhase].started_at = now;
    }
    state.pipeline[nextPhase].last_resumed_at = now;
    state.pipeline[nextPhase].rd_skill = getRdSkill(rules, nextPhase);
  }

  // T5: pre_guidance
  // Issue !162: quick flow dispatch phase has role=null in yaml (intent-based
  // routing design). Fall back to resolveQuickFlowRole which maps
  // intent_category to a concrete role for quick flow + dispatch.
  const nextRole = getRole(rules, nextPhase) || resolveQuickFlowRole(state, nextPhase);
  let preGuidance = null;

  const tasksDir = getTasksDir();
  if (nextRole && existsSync(tasksDir)) {
    const allTasks = stateListAll();
    const roleStats = computeStats(allTasks, rules.phaseSkillMap);
    const roleStat = roleStats.roles.find(s => s.role === nextRole);

    if (roleStat && roleStat.task_count >= 3) {
      if (roleStat.avg_first_pass_rate !== null && roleStat.avg_first_pass_rate < 0.5) {
        const reasons = (roleStat.common_rework_reasons || []).slice(0, 3);
        if (reasons.length > 0) {
          preGuidance = `最近 ${roleStat.task_count} 次执行中一次通过率仅 ${Math.round(roleStat.avg_first_pass_rate * 100)}%，常见问题：${reasons.join('；')}`;
        } else {
          preGuidance = `最近 ${roleStat.task_count} 次执行中一次通过率仅 ${Math.round(roleStat.avg_first_pass_rate * 100)}%，请格外注意代码质量和边界情况`;
        }
        if (preGuidance.length > 200) {
          preGuidance = preGuidance.substring(0, 197) + '...';
        }
      }
    }
  }

  if (preGuidance) {
    state.adaptive_overrides.pre_guidance_history.push({
      phase: nextPhase, role: nextRole, guidance: preGuidance,
      injected_at: new Date().toISOString(),
    });
  }

  updatePhaseProgressMetrics(state);
  stateSave(changeName, state);

  const contextMode = state.intent?.context_mode || 'full';

  return {
    change_name: changeName,
    previous_phase: currentPhase,
    current_phase: nextPhase,
    next_action: nextAction,
    next_role: nextRole,
    next_rd_skill: getRdSkill(rules, nextPhase),
    needs_pm: needsPm,
    reason,
    quality_gates: state.quality_gates,
    pre_guidance: preGuidance,
    warnings: [],
    context_mode: contextMode,
  };
}

// ─── Team Advance ───

export function teamAdvance(changeName, opts) {
  const state = stateLoad(changeName);
  const currentPhase = state.current_phase;

  // D4: Only fanout during implement phase; delegate everything else to advanceImpl
  if (currentPhase !== 'implement') {
    const result = advanceImpl(changeName, opts);
    // D5.7: Restore mode='team'
    try {
      const file = statePath(changeName);
      if (existsSync(file)) {
        const freshState = JSON.parse(readFileSync(file, 'utf8'));
        if (freshState.mode !== 'team') {
          freshState.mode = 'team';
          if (freshState.team === null) {
            freshState.team = { status: 'executing', work_items: [] };
          }
          atomicWriteJson(file, freshState);
        }
      }
    } catch (e) {
      process.stderr.write(`[teamAdvance] CRITICAL: failed to restore mode='team': ${e.message}\n`);
    }
    return result;
  }

  // implement phase fanout logic
  const { exit_status: exitStatus, summary, artifacts, work_item_id, worktree_path } = opts || {};

  // Orphan worktree 清理（advance 入口捡尸）
  // 安全范围：blocked/blocked_permanent/available(悬空)/reviewed(已 integrate)
  // 保留：in_progress/in_review/implemented
  if (state.team && state.team.work_items && state.team.work_items.length > 0) {
    const orphanResults = cleanupOrphanWorktrees(changeName, state.team.work_items);
    if (orphanResults.some(r => r.cleaned)) {
      stateSave(changeName, state);
    }
  }

  // D5: Lazy init — parse tasks.md on first implement entry
  if (!state.team.work_items || state.team.work_items.length === 0) {
    const changeDir = join(PROJECT_ROOT, '.harness', 'spec', 'changes', changeName);
    const parsed = parseTasksMd(changeDir);

    if (parsed.length === 0) {
      process.stderr.write('[teamAdvance] tasks.md has no parseable sections, falling back to single-agent implement\n');
      const result = advanceImpl(changeName, opts);
      try {
        const file = statePath(changeName);
        if (existsSync(file)) {
          const freshState = JSON.parse(readFileSync(file, 'utf8'));
          if (freshState.mode !== 'team') {
            freshState.mode = 'team';
            atomicWriteJson(file, freshState);
          }
        }
      } catch (e) {
        process.stderr.write(`[teamAdvance] CRITICAL: failed to restore mode='team' on fallback: ${e.message}\n`);
      }
      return result;
    }

    state.team.work_items = parsed.map(wi => ({
      ...wi,
      status: 'available', artifact_paths: [], assigned_agent: null,
      worktree_path: null, blocked_count: 0,
    }));
    state.team.status = 'executing';
    stateSave(changeName, state);
  }

  // Process agent result if provided
  if (exitStatus && work_item_id) {
    const wi = state.team.work_items.find(w => w.id === work_item_id);
    if (wi) {
      if (exitStatus === 'BLOCKED') {
        wi.status = 'blocked';
        wi.blocked_count = (wi.blocked_count || 0) + 1;

        if (wi.blocked_count >= 3) {
          wi.status = 'blocked_permanent';
          stateSave(changeName, state);
          return {
            change_name: changeName,
            previous_phase: currentPhase, current_phase: currentPhase,
            next_action: 'escalate_to_pm',
            next_role: null, next_rd_skill: null, needs_pm: true,
            reason: `work item ${work_item_id} blocked ${wi.blocked_count} times, circuit breaker triggered. PM can reset via: node orchestrator.js advance <change> --exit-status DONE --work-item-id ${work_item_id}`,
            warnings: [],
          };
        }
        wi.status = 'available';
        wi.worktree_path = null;
        wi.artifact_paths = [];
      } else if (exitStatus === 'DONE' || exitStatus === 'DONE_WITH_CONCERNS') {
        // Route by agent role: developer → implemented (triggers review), reviewer → reviewed
        if (opts && opts.role === 'reviewer') {
          // Review agent result
          const score = opts.score || 0;
          const p0Count = opts.p0_count || 0;
          if (p0Count > 0 || score < getScoringThresholds(false).debateTrigger) {
            // Review failed → rework
            wi.status = 'review_rework';
            wi.rework_context = opts.summary || `review: score=${score}, P0=${p0Count}`;
          } else {
            // Review passed
            wi.status = 'reviewed';
            wi.review_score = score;
          }
        } else {
          // Developer agent result → implemented, triggers incremental review
          wi.status = 'implemented';
          if (artifacts && Array.isArray(artifacts)) {
            wi.artifact_paths = artifacts;
          }
          if (worktree_path) {
            const absPath = resolve(worktree_path);
            if (absPath === worktree_path && existsSync(worktree_path)) {
              wi.worktree_path = worktree_path;
            } else {
              process.stderr.write(`[teamAdvance] WARNING: invalid worktree_path "${worktree_path}", skipping\n`);
            }
          }
        }
      }
    }
    stateSave(changeName, state);
  }

  // Check if all work items done: all status === 'reviewed'
  const allDone = state.team.work_items.every(wi => wi.status === 'reviewed');
  if (allDone) {
    integrateWorktreeArtifacts(changeName, state.team.work_items);
    cleanupWorktrees(changeName, state.team.work_items);

    const result = advanceImpl(changeName, { exit_status: 'DONE', summary: summary || 'all fanout work items completed' });

    try {
      const file = statePath(changeName);
      if (existsSync(file)) {
        const freshState = JSON.parse(readFileSync(file, 'utf8'));
        if (freshState.mode !== 'team') {
          freshState.mode = 'team';
          if (freshState.team === null) {
            freshState.team = { status: 'completed', work_items: state.team.work_items };
          }
          atomicWriteJson(file, freshState);
        }
      }
    } catch (e) {
      process.stderr.write(`[teamAdvance] CRITICAL: failed to restore mode='team' after allDone: ${e.message}\n`);
    }
    return result;
  }

  // Build next dispatch plan
  const plan = fanoutDispatchPlan(state);
  if (plan.agents.length === 0) {
    stateSave(changeName, state);
    return {
      change_name: changeName,
      previous_phase: currentPhase, current_phase: currentPhase,
      next_action: 'wait_for_pm',
      next_role: null, next_rd_skill: null, needs_pm: true,
      reason: 'no available work items to dispatch (all blocked or in-progress)',
      warnings: [],
    };
  }

  for (const agent of plan.agents) {
    const wi = state.team.work_items.find(w => w.id === agent.work_item_id);
    if (wi) {
      wi.status = agent.role === 'reviewer' ? 'in_review' : 'in_progress';
    }
  }
  stateSave(changeName, state);

  // Determine primary role/rd_skill from batch
  const hasReview = plan.agents.some(a => a.role === 'reviewer');
  const primaryRole = hasReview ? 'reviewer' : 'developer';
  const primarySkill = hasReview ? null : '/rd:apply';

  return {
    change_name: changeName,
    previous_phase: currentPhase, current_phase: currentPhase,
    next_action: 'fanout_dispatch',
    next_role: primaryRole, next_rd_skill: primarySkill, needs_pm: false,
    reason: `fanout dispatch: ${plan.agents.length} agents (${plan.agents.map(a => a.role).join(', ')}), ${plan.remaining_count} remaining`,
    agents: plan.agents, remaining_count: plan.remaining_count,
    warnings: [],
  };
}

// ─── Advance Wrapper ───

export function advance(changeName, opts) {
  // Check mode without full stateLoad overhead
  const file = statePath(changeName);
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw.mode === 'team') {
        return teamAdvance(changeName, opts);
      }
    } catch (e) { debugLog('team pipeline state parse failed, falling back to standard —', e.message); }
  }
  return advanceImpl(changeName, opts);
}
