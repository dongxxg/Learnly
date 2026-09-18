// lib/transitions.js — Rules parsing, rework routing, circuit breaker
import { existsSync, readFileSync } from 'node:fs';
import { RULES_PATH, errExit } from './constants.js';
import { stateSave } from './state-store.js';
import { getRdSkill } from './advance.js';
import { parseYaml } from './yaml-parser.js';

// ─── YAML Loading (cached) ───

let _rulesYamlCache = null;

export function loadRulesYaml(rulesPath = RULES_PATH) {
  if (_rulesYamlCache) return _rulesYamlCache;
  if (!existsSync(rulesPath)) {
    errExit(`harness-rules.yaml not found at ${rulesPath}`);
  }
  const text = readFileSync(rulesPath, 'utf8');
  _rulesYamlCache = parseYaml(text);
  return _rulesYamlCache;
}

// ─── Parse Transition Blocks ───

export function parseTransitionBlocks(transitions) {
  if (!Array.isArray(transitions)) return [];
  return transitions.map(t => {
    const entry = { from: t.from, to: t.to };
    if (t.exit !== undefined) entry.exit = String(t.exit);
    if (t.score_range) entry.score_range = t.score_range;
    if (t.p0_count !== undefined) entry.p0_count = String(t.p0_count);
    if (t.p1_count !== undefined) entry.p1_count = String(t.p1_count);
    return entry;
  });
}

// ─── Parse Rework Routing ───

export function parseReworkRouting(rulesPath = RULES_PATH) {
  const yaml = loadRulesYaml(rulesPath);
  const table = yaml?.scoring?.rework_routing?.table;
  if (!Array.isArray(table)) return [];
  return table.map(e => ({ dimension: e.dimension, target: e.target }));
}

// ─── Parse Rules ───

export function parseRules(rulesPath = RULES_PATH) {
  const yaml = loadRulesYaml(rulesPath);
  const orch = yaml.local_orchestrator;
  if (!orch) {
    errExit('local_orchestrator section not found in harness-rules.yaml. Add it first.');
  }

  // Build phase_skill_map: filter out entries without a role
  const phaseSkillMap = {};
  const psm = orch.phase_skill_map || {};
  for (const [phase, cfg] of Object.entries(psm)) {
    if (cfg && cfg.role && cfg.role !== 'null') {
      phaseSkillMap[phase] = {
        role: cfg.role,
        rd_skill: cfg.rd_skill === 'null' || cfg.rd_skill === null ? null : cfg.rd_skill
      };
    }
  }

  const transitions = parseTransitionBlocks(orch.transitions);
  const hotfixTransitions = parseTransitionBlocks(orch.hotfix_transitions);
  const docsTransitions = parseTransitionBlocks(orch.docs_transitions);
  const quickTransitions = parseTransitionBlocks(orch.quick_transitions);
  const configChangeTransitions = parseTransitionBlocks(orch.config_change_transitions);
  // Issue !283: test-only 独立路由表（对齐 state-store pipeline map，勿复用 development 链）
  const testOnlyTransitions = parseTransitionBlocks(orch.test_only_transitions);

  return { phaseSkillMap, transitions, hotfixTransitions, docsTransitions, quickTransitions, configChangeTransitions, testOnlyTransitions };
}

// ─── Build Rework Response ───

export function buildReworkResponse(changeName, currentPhase, rework, reason, state, rules) {
  if (rework.unknown_dimension) {
    stateSave(changeName, state);
    return {
      change_name: changeName,
      previous_phase: currentPhase,
      current_phase: currentPhase,
      next_action: 'escalate_to_pm',
      next_role: null,
      next_rd_skill: null,
      needs_pm: true,
      reason: `${reason} — unknown rework dimension, PM must decide target role`,
      rework_count: rework.rework_count,
      pua_debugging_required: false,
      warnings: ['rework dimension not found in routing table'],
    };
  }

  const target = rework.targets[0];

  // 持久化 rework 意图，供 dispatch-agent.js 识别（issue !232 Bug2 C2）
  // PM 决策 Q2=a: next_rd_skill=null（rework 走 without-skill + dispatch-rework.md）
  state.pending_rework = {
    target_role: target,
    previous_phase: currentPhase,
    reason,
    rework_count: rework.rework_count[target] || 0,
    pua_debugging_required: !!rework.pua_debugging_required,
  };

  // issue !247 根因：此前只写 pending_rework，从不推进 state.current_phase，
  // 导致返工 dispatch 被 mark-dispatch 记录到原 review 阶段（debate/code-review）下，
  // advance 每次重读原 stage 的旧分（如 debate 39）→ 永远 routeRework → 死循环。
  // 现在把 current_phase 真正推进到 target（rework 专用虚拟 phase），
  // 并为它初始化 pipeline 条目（mark-dispatch 的 dispatch_history 落点），
  // 返工完成后由 advance 的 rework-target 分支回到 code-review 复审。
  state.current_phase = target;
  if (!state.pipeline[target]) {
    state.pipeline[target] = {
      status: 'in_progress',
      started_at: new Date().toISOString(),
      rework_reasons: [],
      artifact_paths: [],
      dispatch_history: [],
    };
  }
  stateSave(changeName, state);

  return {
    change_name: changeName,
    previous_phase: currentPhase,
    current_phase: target,
    next_action: 'rework',
    next_role: target,
    next_rd_skill: null,
    needs_pm: false,
    reason,
    rework_count: rework.rework_count,
    pua_debugging_required: rework.pua_debugging_required,
    warnings: rework.pua_debugging_required ? [`${target} rework count: ${state.rework_count[target]}/2 before pua-debugging`] : [],
  };
}

// ─── Route Rework ───

export function routeRework(state, dimension, rulesPath = RULES_PATH) {
  const table = parseReworkRouting(rulesPath);
  const entry = table.find(e => {
    const dims = Array.isArray(e.dimension) ? e.dimension : [e.dimension];
    return dims.includes(dimension);
  });

  if (!entry) {
    return {
      targets: [],
      rework_count: { ...state.rework_count },
      pua_debugging_required: false,
      unknown_dimension: true,
    };
  }

  const target = entry.target;
  const targets = Array.isArray(target) ? target : [target];

  // Increment rework counts
  for (const t of targets) {
    if (state.rework_count[t] !== undefined) {
      state.rework_count[t]++;
    }
  }

  return {
    targets,
    rework_count: { ...state.rework_count },
    pua_debugging_required: targets.some(t => (state.rework_count[t] || 0) >= 2),
  };
}

// ─── Circuit Breaker ───

export function checkCircuitBreaker(state) {
  return state.blocked_count >= 3;
}
