// lib/state-store.js — Pipeline state management (init/load/save/list/migrate)
import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { PROJECT_ROOT, errExit, debugLog, REWORK_TARGET_ROLES } from './constants.js';
import { recalcTokens } from './stats.js';

// ─── Atomic JSON Write ───

export function atomicWriteJson(filePath, data) {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, filePath);
}

// ─── Path Helpers ───

export function getTasksDir() {
  return join(PROJECT_ROOT, '.harness', 'tasks');
}

export function statePath(changeName) {
  return join(getTasksDir(), changeName, 'pipeline-state.json');
}

// ─── Pipeline Phase Definitions ───

export function getPipelinePhases(flowType) {
  const pipelines = {
    // development: doc-sync + merge-prep merged into archive (12→9 phases)
    development:  ['intake', 'explore', 'propose', 'design-review', 'implement', 'test', 'code-review', 'debate', 'archive'],
    docs:         ['intake', 'explore', 'propose', 'code-review', 'debate', 'archive'],
    hotfix:       ['implement', 'code-review', 'archive'],
    refactor:     ['intake', 'explore', 'propose', 'design-review', 'implement', 'test', 'code-review', 'debate', 'archive'],
    'test-only':  ['intake', 'implement', 'code-review', 'archive'],
    'config-change': ['intake', 'implement', 'code-review', 'archive'],
    quick:        ['intake', 'dispatch', 'verify', 'complete'],
  };
  return pipelines[flowType] || pipelines.development;
}

export function getCountedPhases(state) {
  const pipeline = state.pipeline || {};
  const skipped = new Set((state.adaptive_overrides && state.adaptive_overrides.skipped_phases) || []);
  // issue !247: rework 期间 buildReworkResponse 会给 pipeline 加一个 target 角色的虚拟阶段
  // （developer/architect/tester，非 DAG 阶段），不参与 phases_total 进度统计。
  return Object.keys(pipeline).filter((phase) =>
    !skipped.has(phase) && !REWORK_TARGET_ROLES.has(phase));
}

export function updatePhaseProgressMetrics(state) {
  if (!state.quality_metrics) {
    state.quality_metrics = {
      first_pass_rate: null,
      total_rework_loops: 0,
      automated_catches: 0,
      time_to_first_code_review_ms: null,
      total_wall_clock_ms: null,
      phases_completed: 0,
      phases_total: 0,
    };
  }

  const countedPhases = getCountedPhases(state);
  state.quality_metrics.phases_total = countedPhases.length;
  state.quality_metrics.phases_completed = countedPhases.filter((phase) => state.pipeline[phase].status !== 'pending').length;
}

export function markSkippedPhase(state, phase) {
  if (!state.pipeline || !state.pipeline[phase]) return;
  if (!state.adaptive_overrides) {
    state.adaptive_overrides = { skipped_phases: [], forced_phases: [], pre_guidance_history: [] };
  }
  if (!Array.isArray(state.adaptive_overrides.skipped_phases)) {
    state.adaptive_overrides.skipped_phases = [];
  }
  if (!state.adaptive_overrides.skipped_phases.includes(phase)) {
    state.adaptive_overrides.skipped_phases.push(phase);
  }
}

export function unmarkSkippedPhase(state, phase) {
  const skipped = state.adaptive_overrides && state.adaptive_overrides.skipped_phases;
  if (!Array.isArray(skipped)) return;
  state.adaptive_overrides.skipped_phases = skipped.filter((p) => p !== phase);
}

// ─── State Init ───

export function stateInit(changeName, title, criteria, flowType, hotfix, opts) {
  const dir = join(getTasksDir(), changeName);
  const file = join(dir, 'pipeline-state.json');

  if (existsSync(file)) {
    errExit(`Change '${changeName}' already exists at ${file}. Use advance or set-phase instead.`);
  }
  mkdirSync(dir, { recursive: true });

  const resolvedFlowType = hotfix ? 'hotfix' : (flowType || 'development');
  const phases = getPipelinePhases(resolvedFlowType);

  // Parse --mode argument (passed via cmdInit parsed args)
  const modeStr = (opts && opts.mode) || 'legacy';
  const validModes = ['legacy', 'team'];
  const mode = validModes.includes(modeStr) ? modeStr : 'legacy';

  const pipeline = {};
  for (const p of phases) {
    pipeline[p] = {
      status: 'pending',
      rd_skill: null,
      first_pass: null,
      rework_reasons: [],
      artifact_paths: [],
    };
  }

  const now = new Date().toISOString();
  let caller = '';
  try { caller = execSync('git config user.name', { encoding: 'utf-8' }).trim(); } catch (e) { debugLog('git config user.name failed —', e.message); }
  const state = {
    schema_version: 6,
    change_name: changeName,
    title,
    caller,
    created_at: now,
    updated_at: now,
    acceptance_criteria: criteria,
    current_phase: 'pending',
    pipeline,
    quality_gates: {
      'QG-ARCH-001': 'pending',
      'QG-DEV-001': 'pending',
      'QG-REV-001': 'pending',
      'QG-REV-002': 'pending',
    },
    scores: { architect: null, reviewer: null, tester: null },
    rework_count: { architect: 0, developer: 0, tester: 0, reviewer: 0 },
    blocked_count: 0,
    hotfix_mode: !!hotfix,
    flow_type: resolvedFlowType,
    docs_mode: resolvedFlowType === 'docs',
    intent: null,
    dispatch_efficiency: {
      pm_input_at: now,
      first_artifact_at: null,
      total_dispatch_count: 0,
      pm_to_first_artifact_ms: null,
      pm_to_archive_ms: null,
    },
    adaptive_overrides: {
      skipped_phases: [],
      forced_phases: [],
      pre_guidance_history: [],
    },
    token_summary: {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_tokens: 0,
      by_phase: {},
      by_role: {},
      by_model: {},
      last_calculated_at: null,
    },
    quality_metrics: {
      first_pass_rate: null,
      total_rework_loops: 0,
      automated_catches: 0,
      time_to_first_code_review_ms: null,
      total_wall_clock_ms: null,
      phases_completed: 0,
      phases_total: phases.length,
    },
    context_upgrade_attempts: 0,
    mode,
    team: mode === 'team' ? { status: 'forming', members: ['architect', 'developer', 'tester', 'reviewer'].map(r => ({ role: r, status: 'pending' })) } : null,
    // pending_rework: rework 意图跨 phase 传递（advance 写入 → dispatch-agent.js 消费后清除）
    // 顶层字段：不属于特定 phase（buildReworkResponse 跨 phase 传递）。issue !232 Bug2 C5
    pending_rework: null,
    // checkpoint: 最近一次 advance 的恢复点（phase + next_action），自动写入。
    // 跨 session resume 时无需重跑 advance 推断，读此字段即知下一步。单对象，新覆盖旧。
    checkpoint: null,
  };

  atomicWriteJson(file, state);
  return state;
}

// ─── State Load ───

export function stateLoad(changeName) {
  const file = statePath(changeName);
  if (!existsSync(file)) {
    errExit(`Change '${changeName}' not found. Run init first.`);
  }
  let state = JSON.parse(readFileSync(file, 'utf8'));
  if (!state.schema_version || state.schema_version < 6) {
    state = migrateState(state);
    atomicWriteJson(file, state);
  }
  // Supplement mode field if missing (post-migration safety net)
  if (!state.mode || state.checkpoint === undefined) {
    if (!state.mode) {
      state.mode = 'legacy';
      state.team = state.team || null;
    }
    if (state.checkpoint === undefined) state.checkpoint = null;
    atomicWriteJson(file, state);
  }
  return state;
}

// Migrate old-format pipeline state to include new phases
export function migrateState(state) {
  const canonicalPhases = {
    hotfix:      ['implement', 'code-review', 'archive'],
    docs:        ['intake', 'explore', 'propose', 'code-review', 'debate', 'archive'],
    development: ['intake', 'explore', 'propose', 'design-review', 'implement', 'test', 'code-review', 'debate', 'archive'],
  };
  const flowType = state.hotfix_mode ? 'hotfix' : state.docs_mode ? 'docs' : 'development';
  const targetPhases = canonicalPhases[flowType];
  if (!targetPhases) return state;

  for (const phase of targetPhases) {
    if (!state.pipeline[phase]) {
      state.pipeline[phase] = { status: 'pending', rd_skill: null };
    }
  }

  // v2 baseline
  if (!state.schema_version || state.schema_version < 2) {
    state.schema_version = 2;
  }

  // v3 migration
  if (state.schema_version < 3) {
    for (const ph of Object.values(state.pipeline)) {
      if (ph.first_pass === undefined) ph.first_pass = null;
      if (!ph.rework_reasons) ph.rework_reasons = [];
      if (!ph.artifact_paths) ph.artifact_paths = [];
      if (ph.dispatch_history) {
        for (const round of ph.dispatch_history) {
          if (!round.token_usage) round.token_usage = null;
          if (!round.exit_status) round.exit_status = null;
        }
      }
    }
    if (!state.token_summary) {
      state.token_summary = {
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_tokens: 0,
        by_phase: {},
        by_role: {},
        by_model: {},
        last_calculated_at: null,
      };
    }
    if (!state.quality_metrics) {
      state.quality_metrics = {
        first_pass_rate: null,
        total_rework_loops: 0,
        automated_catches: 0,
        time_to_first_code_review_ms: null,
        total_wall_clock_ms: null,
        phases_completed: 0,
        phases_total: 0,
      };
    }
    state.schema_version = 3;
  }

  // v4 migration: flow_type unification and new fields
  if (state.schema_version < 4) {
    state.intent = null;
    state.dispatch_efficiency = {
      pm_input_at: state.created_at || null,
      first_artifact_at: null,
      total_dispatch_count: 0,
      pm_to_first_artifact_ms: null,
      pm_to_archive_ms: null,
    };
    state.adaptive_overrides = {
      skipped_phases: [],
      forced_phases: [],
      pre_guidance_history: [],
    };
    // Derive flow_type from legacy flags
    if (state.hotfix_mode === true && !state.flow_type) {
      state.flow_type = 'hotfix';
    } else if (state.docs_mode === true && !state.flow_type) {
      state.flow_type = 'docs';
    } else if (!state.flow_type) {
      state.flow_type = 'development';
    }
    state.schema_version = 4;
  }

  // v5 migration: rename 'review' phase to 'code-review'
  if (state.schema_version < 5) {
    if (state.pipeline && state.pipeline.review) {
      state.pipeline['code-review'] = state.pipeline.review;
      delete state.pipeline.review;
    }
    if (state.token_summary && state.token_summary.by_phase && state.token_summary.by_phase.review) {
      state.token_summary.by_phase['code-review'] = state.token_summary.by_phase.review;
      delete state.token_summary.by_phase.review;
    }
    if (state.quality_metrics) {
      if (state.quality_metrics.time_to_first_review_ms !== undefined) {
        state.quality_metrics.time_to_first_code_review_ms = state.quality_metrics.time_to_first_review_ms;
        delete state.quality_metrics.time_to_first_review_ms;
      }
    }
    // Initialize context_upgrade_attempts for existing states
    if (state.context_upgrade_attempts === undefined) {
      state.context_upgrade_attempts = 0;
    }
    state.schema_version = 5;
  }

  // v6 migration: doc-sync and merge-prep merged into archive
  if (state.schema_version < 6) {
    const mergedPhases = ['doc-sync', 'merge-prep'];
    for (const mp of mergedPhases) {
      if (state.pipeline[mp]) {
        if (state.pipeline[mp].status === 'done' || state.pipeline[mp].status === 'done_with_concerns') {
          if (!state.pipeline.archive) {
            state.pipeline.archive = { status: 'pending', rd_skill: null, first_pass: null, rework_reasons: [], artifact_paths: [] };
          }
          if (state.pipeline[mp].dispatch_history) {
            if (!state.pipeline.archive.dispatch_history) state.pipeline.archive.dispatch_history = [];
            state.pipeline.archive.dispatch_history.push(...state.pipeline[mp].dispatch_history);
          }
        }
        delete state.pipeline[mp];
      }
    }
    if (state.current_phase === 'doc-sync' || state.current_phase === 'merge-prep') {
      state.current_phase = 'archive';
      if (state.pipeline.archive) {
        state.pipeline.archive.status = 'in_progress';
      }
    }
    const flowType = state.flow_type || (state.hotfix_mode ? 'hotfix' : state.docs_mode ? 'docs' : 'development');
    const targetPhases = {
      hotfix:      ['implement', 'code-review', 'archive'],
      docs:        ['intake', 'explore', 'propose', 'code-review', 'debate', 'archive'],
      development: ['intake', 'explore', 'propose', 'design-review', 'implement', 'test', 'code-review', 'debate', 'archive'],
      refactor:    ['intake', 'explore', 'propose', 'design-review', 'implement', 'test', 'code-review', 'debate', 'archive'],
      'test-only': ['intake', 'implement', 'code-review', 'archive'],
      'config-change': ['intake', 'implement', 'code-review', 'archive'],
    };
    const phases = targetPhases[flowType] || targetPhases.development;
    for (const phase of phases) {
      if (!state.pipeline[phase]) {
        state.pipeline[phase] = { status: 'pending', rd_skill: null, first_pass: null, rework_reasons: [], artifact_paths: [] };
      }
    }
    if (!state.adaptive_overrides) {
      state.adaptive_overrides = { skipped_phases: [], forced_phases: [], pre_guidance_history: [] };
    }
    for (const mp of mergedPhases) {
      if (!state.adaptive_overrides.skipped_phases.includes(mp)) {
        state.adaptive_overrides.skipped_phases.push(mp);
      }
    }
    if (state.current_phase === 'archive' && state.pipeline.archive && state.pipeline.archive.status === 'done') {
      state.current_phase = 'completed';
      state.completed_at = state.completed_at || new Date().toISOString();
    }
    state.schema_version = 6;
  }

  // Supplement mode field for any state that lacks it (v5 migration or incomplete v6)
  if (!state.mode) {
    state.mode = 'legacy';
  }
  if (!state.team) {
    state.team = null;
  }
  // pending_rework default for pre-C5 states (issue !232 Bug2)
  if (state.pending_rework === undefined) {
    state.pending_rework = null;
  }
  // checkpoint default for pre-checkpoint states（增量字段，同 pending_rework 先例）
  if (state.checkpoint === undefined) {
    state.checkpoint = null;
  }

  return state;
}

// ─── State Save ───

export function stateSave(changeName, state) {
  state.updated_at = new Date().toISOString();
  recalcTokens(state);
  atomicWriteJson(statePath(changeName), state);
}

// ─── Checkpoint（advance 后自动写入的跨 session 恢复点）───

// writeCheckpoint: 将 advance 结果落盘为恢复点。单对象，新覆盖旧。
// 失败静默（debug log）——checkpoint 是增强信息，绝不能阻断 advance 主流程。
export function writeCheckpoint(changeName, advanceResult) {
  if (!advanceResult) return;
  try {
    const state = stateLoad(changeName);
    state.checkpoint = {
      phase: advanceResult.current_phase || null,
      next_action: advanceResult.next_action || null,
      next_role: advanceResult.next_role || null,
      next_rd_skill: advanceResult.next_rd_skill || null,
      reason: (advanceResult.reason || '').slice(0, 300) || null,
      saved_at: new Date().toISOString(),
    };
    stateSave(changeName, state);
  } catch (e) { debugLog('writeCheckpoint failed —', e.message); }
}

// ─── State List ───

export function stateListActive() {
  const dir = getTasksDir();
  if (!existsSync(dir)) return [];
  const results = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const file = join(dir, name.name, 'pipeline-state.json');
    if (!existsSync(file)) continue;
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      if (state.current_phase !== 'completed') {
        results.push(state);
      }
    } catch (e) { debugLog('stateListActive: corrupt pipeline-state.json —', e.message); }
  }
  return results;
}

export function stateListAll() {
  const dir = getTasksDir();
  if (!existsSync(dir)) return [];
  const results = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const file = join(dir, name.name, 'pipeline-state.json');
    if (!existsSync(file)) continue;
    try {
      results.push(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) { debugLog('stateListAll: corrupt pipeline-state.json —', e.message); }
  }
  return results;
}
