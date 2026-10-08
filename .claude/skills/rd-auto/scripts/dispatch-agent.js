#!/usr/bin/env node
// dispatch-agent.js — Phase 3a 主会话 dispatch 强制入口 wrapper
//
// 职责（按顺序）：
//   1. cmdDispatchPrompt(<change>) 拿 dp（含 dp.backend.type / role / phase / context_pack / validation）
//   2. 处理 dp.role === null 的 hint 分支（quick_change 主会话自处理）→ 输出 { action: "no_dispatch" }
//   3. 渲染 dispatch-with-skill.md / dispatch-without-skill.md 得 finalPrompt
//   4. 校验 dp.backend.type 属于已知 backend（未知 → 直接 wrapper_error，不落任何状态，见 Step 4）
//   5. cmdMarkDispatch(<change>, '--start') → read-modify-write pipeline-state.json 写 wrapper_invoked:true
//   6. 按 dp.backend.type 分流：
//      - codex/qoder：进程内加载对应 headless backend，调 dispatchSubAgent，输出完成结果
//      - claude/codebuddy/zcode：输出 { action:"invoke_agent_tool", agent_args, post_dispatch, ... }，主会话二次执行
//
// 输出统一 JSON schema（顶层 8 字段）：
//   { backend, action, result?, agent_args?, tokens_used?, log_file?, post_dispatch?, wrapper_invoked: true }
//
// 异常路径：dispatch-prompt 失败 / 模板渲染失败 → { action: "wrapper_error", error, wrapper_invoked: true }，退出码 1

import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PROJECT_ROOT, CLAUDE_DIR, SKILL_DIR, ROLE_AGENT_MAP,
  errExit, output, debugLog, getArg,
} from './lib/constants.js';
import { cmdDispatchPrompt, cmdMarkDispatch } from './lib/cli-commands.js';
import { stateLoad, stateSave, statePath } from './lib/state-store.js';
import { getRdSkill } from './lib/advance.js';
import { parseRules } from './lib/transitions.js';
import { RULES_PATH } from './lib/constants.js';
import { normalizeSkillInvocation } from './lib/backend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(SKILL_DIR, 'templates');

// Role → subagent_type 映射（claude Agent 工具的 subagent_type 接受 Title Case）
// 与 $HARNESS_ROOT/agents/ 文件名对齐：architect/developer/tester/reviewer/debate
function roleToSubagentType(role) {
  if (!role) return null;
  const map = {
    architect: 'Architect',
    developer: 'Developer',
    tester: 'Tester',
    reviewer: 'Reviewer',
    debate: 'Debate',
  };
  return map[role] || role.charAt(0).toUpperCase() + role.slice(1);
}

// 选取模板并渲染 finalPrompt（禁止让 sub-agent 自己 Read agent_path）
function renderFinalPrompt(dp, rdSkill) {
  // #315: design-review 有专用对抗性评审模板（占位符均在下方 replace 链覆盖）；
  // 其余阶段沿用 skill 有无二选一
  const tplName = dp.phase === 'design-review'
    ? 'dispatch-design-review.md'
    : (rdSkill ? 'dispatch-with-skill.md' : 'dispatch-without-skill.md');
  const tplPath = join(TEMPLATES_DIR, tplName);
  if (!existsSync(tplPath)) {
    throw new Error(`template not found: ${tplPath}`);
  }
  let tpl = readFileSync(tplPath, 'utf8');

  // 公共字段
  const acceptanceCriteria = (dp.acceptance_criteria || []).join('\n');
  const title = dp.title || dp.change_name || '';
  const previousSummary = dp.previous_summary || '（无前一阶段摘要）';
  const agentPath = dp.agent_path || '';
  const agentContent = dp.validation?.agent_file_content || '';

  // context_pack 各 section 的 content
  const ctx = dp.context_pack || {};
  const specDocs = ctx.spec_docs?.content || '';
  const harnessRules = ctx.harness_rules?.content || '';
  const gitDiff = ctx.git_diff?.content || '';
  const agentHistory = ctx.agent_history?.content || '';
  const rulesTruncated = ctx.harness_rules?.truncated ? '已截断' : '完整';

  // 渲染（与 dispatch-with-skill.md 占位符一一对应）
  tpl = tpl.replace(/{phase}/g, dp.phase || '');
  tpl = tpl.replace(/{next_role}/g, dp.role || '');
  tpl = tpl.replace(/{next_rd_skill}/g, rdSkill || '');
  tpl = tpl.replace(/{change-name}/g, dp.change_name || '');
  tpl = tpl.replace(/{title}/g, title);
  tpl = tpl.replace(/{agent_path}/g, agentPath);
  tpl = tpl.replace(/{validation\.agent_file_content}/g, agentContent);
  tpl = tpl.replace(/{previous_summary}/g, previousSummary);
  tpl = tpl.replace(/{acceptance_criteria}/g, acceptanceCriteria);
  tpl = tpl.replace(/{context_pack\.spec_docs\.content}/g, specDocs);
  tpl = tpl.replace(/{context_pack\.harness_rules\.content}/g, harnessRules);
  tpl = tpl.replace(/{context_pack\.harness_rules\.truncated \? '已截断' : '完整'}/g, rulesTruncated);
  tpl = tpl.replace(/{context_pack\.git_diff\.content}/g, gitDiff);
  tpl = tpl.replace(/{context_pack\.agent_history\.content}/g, agentHistory);

  // Rework 追加段（issue !232 Bug2 C4.1）：dp.is_rework 时末尾追加 dispatch-rework.md
  // dispatch-rework.md 强制 sub-agent 先读 concerns.json 再按清单定向修复
  if (dp.is_rework && dp.rework_context) {
    const reworkTplPath = join(TEMPLATES_DIR, 'dispatch-rework.md');
    if (!existsSync(reworkTplPath)) {
      throw new Error(`rework template not found: ${reworkTplPath}`);
    }
    let reworkTpl = readFileSync(reworkTplPath, 'utf8');

    const rc = dp.rework_context;
    // dispatch-rework.md 用 {pua_debugging_required ? '...' : '...'} 三元占位符（跨多行）
    const puaBlock = rc.pua_debugging_required
      ? '**pua-debugging 已触发**：调用 Skill(skill="pua-debugging") 激活失败恢复方法论。\n按"先闻味道、再揪头发、照镜子"的顺序，**禁止直接动手改代码**。\n你的失败已经不是偶然——之前的方案有结构性问题，必须先识别模式再修复。'
      : '<!-- pua-debugging 未触发，但仍然禁止沿用之前失败的方案 -->';

    reworkTpl = reworkTpl
      .replace(/{current_phase}/g, dp.phase || '')
      .replace(/{previous_phase}/g, rc.previous_phase || '')
      .replace(/{reason}/g, rc.reason || '')
      .replace(/{next_role}/g, dp.role || '')
      .replace(/{rework_count}/g, String(rc.rework_count || 0))
      .replace(/{change-name}/g, dp.change_name || '')
      // 多行三元占位符：匹配 {pua_debugging_required ? ... : ...} 整段（含换行），用 /s flag dotall
      .replace(/\{pua_debugging_required \?[^}]*\}/s, puaBlock);

    tpl = tpl + '\n\n---\n\n' + reworkTpl;
  }

  return tpl;
}

// read-modify-write pipeline-state.json：给当前 phase 的 dispatch_history 末尾条目追加 wrapper_invoked:true
function markWrapperInvoked(changeName) {
  const file = statePath(changeName);
  if (!existsSync(file)) {
    debugLog(`markWrapperInvoked: pipeline-state.json not found for ${changeName}`);
    return false;
  }
  // read-modify-write（与 cmdMarkDispatch 一致使用 stateLoad/stateSave 以保持 schema 一致）
  const state = stateLoad(changeName);
  const phase = state.current_phase;
  if (!phase || !state.pipeline[phase]) {
    debugLog(`markWrapperInvoked: no active phase for ${changeName}`);
    return false;
  }
  const ph = state.pipeline[phase];
  if (!ph.dispatch_history || ph.dispatch_history.length === 0) {
    debugLog(`markWrapperInvoked: dispatch_history empty for ${changeName}/${phase}`);
    return false;
  }
  // 末尾条目（cmdMarkDispatch --start 刚推入的）
  const last = ph.dispatch_history[ph.dispatch_history.length - 1];
  last.wrapper_invoked = true;
  stateSave(changeName, state);
  return true;
}

// 异常输出（统一 schema）
function emitWrapperError(backend, error) {
  output({
    backend: backend || null,
    action: 'wrapper_error',
    error: typeof error === 'string' ? error : (error?.message || String(error)),
    wrapper_invoked: true,
  });
  process.exit(1);
}

// 捕获中间函数（cmdDispatchPrompt / cmdMarkDispatch）的 stdout，
// 防止污染 wrapper 的最终单一 JSON 输出。
function runWithCapturedStdout(fn) {
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string') captured += chunk;
    return true;
  };
  let result;
  let err = null;
  try {
    result = fn();
  } catch (e) {
    err = e;
  } finally {
    process.stdout.write = origStdoutWrite;
  }
  if (err) throw err;
  return captured;
}

function persistQoderLog(changeName, role, round, rawResult) {
  const logsDir = join(PROJECT_ROOT, '.harness', 'shared-state', changeName, 'qoder-logs');
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, `${role}-${round}-${Date.now()}.json`);
  writeFileSync(logFile, `${JSON.stringify(rawResult, null, 2)}\n`, 'utf8');
  return logFile;
}

// ─── 主入口 ───

const args = process.argv.slice(2);

// 解析参数：<change-name> [--round N]
let changeName = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--round') {
    i++; // skip value（当前实现忽略 round，仅做参数校验）
    continue;
  }
  if (a.startsWith('--')) {
    continue;
  }
  if (!changeName) {
    changeName = a;
  }
}

if (!changeName) {
  errExit('Usage: node dispatch-agent.js <change-name> [--round N]');
}

// C001 修复：预校验 change 存在性（避免 cmdDispatchPrompt 内部 errExit 触发 process.exit
// 导致 wrapper_error 契约违反——runWithCapturedStdout 的 try/catch 捕不到 process.exit）
{
  const stateFile = statePath(changeName);
  if (!existsSync(stateFile)) {
    output({
      backend: null,
      action: 'wrapper_error',
      error: `change '${changeName}' not found (pipeline-state.json missing). Run init first or check name spelling.`,
      wrapper_invoked: true,
    });
    process.exit(1);
  }
}

// Step 1: 调 cmdDispatchPrompt 拿 dp（捕获 stdout）
let dp;
let detectedBackend = null;
{
  let captured;
  try {
    captured = runWithCapturedStdout(() => cmdDispatchPrompt([changeName]));
  } catch (e) {
    emitWrapperError(null, `dispatch-prompt failed: ${e.message}`);
  }
  try {
    dp = JSON.parse(captured);
  } catch (e) {
    emitWrapperError(null, `dispatch-prompt output unparseable: ${e.message}`);
  }
  detectedBackend = dp?.backend?.type || null;
}

// Step 2: dp.role === null → no_dispatch hint（quick_change 主会话自处理）
if (dp.role === null || dp.role === undefined) {
  output({
    backend: detectedBackend,
    action: 'no_dispatch',
    hint: dp.hint || 'no sub-agent role required',
    change_name: changeName,
    phase: dp.phase,
    wrapper_invoked: true,
  });
  process.exit(0);
}

// 计算 rd_skill（用 rules.phaseSkillMap，与 advance.js getRdSkill 一致）
let rdSkill = null;
try {
  const rules = parseRules(RULES_PATH);
  rdSkill = normalizeSkillInvocation(getRdSkill(rules, dp.phase), detectedBackend);
} catch (e) {
  debugLog(`parseRules/getRdSkill failed — ${e.message}`);
}

// Step 3: 渲染 finalPrompt
let finalPrompt;
try {
  finalPrompt = renderFinalPrompt(dp, rdSkill);
} catch (e) {
  emitWrapperError(detectedBackend, `template render failed: ${e.message}`);
}

// Step 4: backend 分流判定（#322）
//
// WHY 判定必须先于任何落盘副作用：`mark-dispatch --start` 会往 dispatch_history 推入一条
// completed_at:null 的开放条目，紧随其后的 markWrapperInvoked 又把它标成
// wrapper_invoked:true。若这两步先于分流执行，未知 backend 走到末尾 emitWrapperError 时
// 就会同时留下两个坏状态：
//   1) 悬挂条目——completion 永远不会写，主会话必须手工 mark-dispatch --end 收尾；
//   2) 门禁假通过——_assertWrapperInvoked（lib/cli-commands.js）只在末尾条目显式
//      wrapper_invoked===false 时才拦截，此处已被写成 true，于是 advance 放行；
//      状态里记录了"dispatch 已发生"，而子代理根本没被派发。危害高于死锁。
// 所以：先确认 backend 已知且可处理，再落 --start。
const backendType = dp.backend?.type || 'claude';
// dsh（DeepSeek Harness）已从 dispatch 白名单移除（PM 决策，见 #322）：dsh 不作为 dispatch
// 目标，走到下方 unknown backend 分支报 wrapper_error。注意其**实现**保留完好
// （.claude/backends/dsh-backend.js + backend-factory.js 仍注册 dsh、stats.js 白名单仍含 dsh），
// 只是 wrapper 不再把 dp.backend.type==='dsh' 路由到任何分支——便于将来恢复 dispatch 能力时
// 只需把 'dsh' 加回本数组，无需重建 backend。
// 另注：stats.js 的 by_backend 白名单与「是否支持 dispatch」无关，它管报表归类，
// 防止历史 dsh 记录被误并进 'unknown' 桶并刷假告警，故保持不动。
const NATIVE_AGENT_TOOL_BACKENDS = ['claude', 'codebuddy', 'zcode'];
const HEADLESS_CLI_BACKENDS = ['codex', 'qoder'];
const isNativeAgentToolBackend = NATIVE_AGENT_TOOL_BACKENDS.includes(backendType);
const isHeadlessCliBackend = HEADLESS_CLI_BACKENDS.includes(backendType);
if (!isNativeAgentToolBackend && !isHeadlessCliBackend) {
  // 此处零状态副作用：dispatch_history 不新增条目，wrapper_invoked 不写入
  emitWrapperError(backendType, `unknown backend type: ${backendType}`);
}

const subagentType = roleToSubagentType(dp.role);
const description = `${changeName}/${dp.phase}/${dp.role}`;

// Step 5: cmdMarkDispatch --start + read-modify-write wrapper_invoked（捕获 stdout）
try {
  runWithCapturedStdout(() => cmdMarkDispatch([changeName, '--start']));
} catch (e) {
  emitWrapperError(detectedBackend, `mark-dispatch --start failed: ${e.message}`);
}
try {
  markWrapperInvoked(changeName);
} catch (e) {
  debugLog(`markWrapperInvoked failed — ${e.message}`);
  // 不阻塞：dispatch_history 字段写入失败仅记录
}

// 清除 pending_rework（issue !232 Bug2 C4.2，PM 决策 Q3=a：mark-start 后清）
// 此时 dispatch_history 已通过 cmdMarkDispatch --start 记录本次 dispatch（含 rework 标识），
// pending_rework 的"传递 rework 意图"使命完成。下次 dispatch 若仍是 rework，advance 会重新写入。
try {
  const state = stateLoad(changeName);
  if (state.pending_rework) {
    state.pending_rework = null;
    stateSave(changeName, state);
  }
} catch (e) {
  debugLog(`clear pending_rework failed — ${e.message}`);
  // 不阻塞 dispatch：pending_rework 残留最坏情况是下次 dispatch 仍走 rework 路径，
  // 但 advance 会在下次 rework 时覆盖写入，不会无限循环
}

// Step 6: 按 backend.type 分流（Step 4 已排除未知值，末尾 else 仅为防御）
if (isHeadlessCliBackend) {
  // Headless CLI 路径：动态加载 backend，直接 dispatch。
  try {
    const backendConfig = backendType === 'qoder'
      ? { file: 'qoder-backend.js', exportName: 'QoderBackend', logsDir: 'qoder-logs' }
      : { file: 'codex-backend.js', exportName: 'CodexBackend', logsDir: 'codex-logs' };
    const backendPath = join(CLAUDE_DIR, 'backends', backendConfig.file);
    const backendModule = await import(pathToFileURL(backendPath).href);
    const BackendClass = backendModule[backendConfig.exportName];
    if (typeof BackendClass !== 'function') {
      throw new Error(`${backendConfig.exportName} is not exported by ${backendConfig.file}`);
    }
    const backend = new BackendClass({});
    // 计算 round（dispatch_history 末尾已是本次 --start 推入的，length 即当前 round）
    const state = stateLoad(changeName);
    const ph = state.pipeline[state.current_phase] || {};
    const round = (ph.dispatch_history || []).length || 1;

    const rawResult = await backend.dispatchSubAgent(dp.role, finalPrompt, {
      skipBuildPrompt: true,
      phase: dp.phase,
      changeName: dp.change_name || changeName,
      round,
      contextMode: dp.context_pack?.context_mode || 'full',
    });

    // 标准化结果（snake_case）
    const normalizePath = join(SKILL_DIR, 'scripts', 'lib', 'normalize-result.js');
    const { normalizeDispatchResult } = await import(pathToFileURL(normalizePath).href);
    const normalized = normalizeDispatchResult(backendType, rawResult);

    // tokens_used：headless CLI usage 提取
    const tokensUsed = rawResult?.tokens_used ?? null;

    // !262: codex usageDetail（input/cached/output/reasoning）透传 mark-dispatch 结构化落盘；
    // 无明细时回落 --tokens 单值（total-only，向后兼容）。tokenArgs 顺序：结构化在前，total 兜底在后。
    const usage = rawResult?.usage;
    const tokenArgs = [];
    if (usage && typeof usage === 'object') {
      if (typeof usage.input_tokens === 'number') tokenArgs.push('--input-tokens', String(usage.input_tokens));
      if (typeof usage.output_tokens === 'number') tokenArgs.push('--output-tokens', String(usage.output_tokens));
      if (typeof usage.cached_input_tokens === 'number') tokenArgs.push('--cache-read-tokens', String(usage.cached_input_tokens));
      if (typeof usage.reasoning_output_tokens === 'number') tokenArgs.push('--reasoning-tokens', String(usage.reasoning_output_tokens));
    }
    if (tokensUsed != null) tokenArgs.push('--tokens', String(tokensUsed));

    // log_file：Codex backend 自行落盘；Qoder wrapper 保存标准化前的原始结果。
    let logFile = undefined;
    if (dp.change_name || changeName) {
      const cn = dp.change_name || changeName;
      const logsDir = join(PROJECT_ROOT, '.harness', 'shared-state', cn, backendConfig.logsDir);
      if (backendType === 'qoder') {
        logFile = persistQoderLog(cn, dp.role, round, rawResult);
      } else if (existsSync(logsDir)) {
        const files = readdirSync(logsDir)
          .filter(f => f.startsWith(`${dp.role}-${round}-`))
          .sort();
        if (files.length > 0) logFile = join(logsDir, files[files.length - 1]);
      }
    }

    // mark-dispatch --end（headless 路径 wrapper 内部完成，主会话无需再调）
    // #314: design-review 的 verdict（APPROVED|REWORK_NEEDED）随结果透传落盘；
    // 仅认合法枚举——mark-dispatch 对非法枚举 errExit（process.exit 不可被
    // try/catch 捕获，会杀死 wrapper），垃圾值直接丢弃、由 advance 按仅 P0 判定
    const validVerdict = (normalized.verdict === 'APPROVED' || normalized.verdict === 'REWORK_NEEDED')
      ? normalized.verdict : null;
    try {
      runWithCapturedStdout(() => cmdMarkDispatch([changeName, '--end',
                        '--exit-status', normalized.exit_status || 'DONE',
                        '--summary', (normalized.summary || '').slice(0, 200),
                        '--backend', backendType,
                        ...(validVerdict ? ['--verdict', validVerdict] : []),
                        ...tokenArgs]));
    } catch (e) {
      debugLog(`mark-dispatch --end failed — ${e.message}`);
    }

    output({
      backend: backendType,
      action: 'completed',
      result: normalized,
      tokens_used: tokensUsed,
      ...(logFile ? { log_file: logFile } : {}),
      wrapper_invoked: true,
    });
    process.exit(0);
  } catch (e) {
    emitWrapperError(backendType, `${backendType} dispatch failed: ${e.message}`);
  }
} else if (isNativeAgentToolBackend) {
  // 原生 Agent 工具路径：ZCode 没有文档化的 headless CLI，因此与 Claude/CodeBuddy
  // 一样由主会话调用内置 Agent 工具，同时保留 backend 标识。
  // dsh 曾归入此分支，现已从白名单移除（见 Step 4 WHY 注释）。
  output({
    backend: backendType,
    action: 'invoke_agent_tool',
    agent_args: {
      subagent_type: subagentType,
      prompt: finalPrompt,
      description,
    },
    post_dispatch: {
      // #314: design-review 阶段追加 --verdict 占位，提示主会话回传评审结论
      mark_dispatch_end_cmd: `node orchestrator.js mark-dispatch ${changeName} --end --exit-status <STATUS> --summary <SUMMARY> --backend ${backendType}`
        + (dp.phase === 'design-review' ? ' --verdict <APPROVED|REWORK_NEEDED>' : ''),
    },
    wrapper_invoked: true,
  });
  process.exit(0);
} else {
  emitWrapperError(backendType, `unknown backend type: ${backendType}`);
}
