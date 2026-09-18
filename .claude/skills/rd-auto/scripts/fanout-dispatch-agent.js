#!/usr/bin/env node
// fanout-dispatch-agent.js — Phase 3c: headless backend fanout worktree isolation wrapper
//
// 职责（按顺序）：
//   1. 接受 CLI 参数 <change-name> [--round N]
//   2. 加载 pipeline-state，校验 team mode + implement phase
//   3. 调用 fanoutDispatchPlan(state) 获取 agents[]
//   4. 调用 createWorktrees(changeName, agents) 为每个 agent 创建独立 worktree
//   5. 渲染 dispatch-fanout.md 模板为每个 agent 生成 finalPrompt
//   6. Promise.all(dispatchSubAgent(cwd=worktree)) 并行 dispatch
//   7. normalizeDispatchResult 每个结果
//   8. stdout 输出 JSON: {backend, action:"fanout_completed", results[], wrapper_invoked:true}
//
// 错误处理：
//   - git worktree add 失败 → 该 work_item 标记 error，不阻塞其他
//   - dispatchSubAgent 失败 → 记录 error + exit_status=BLOCKED
//   - 全部失败 → 仍输出结果数组
//
// 输出统一 JSON schema：
//   { backend, action: "fanout_completed", results: [{work_item_id, role, worktree_path, exit_status, summary, artifacts, tokens_used, log_file, error, prompt_warnings?}], wrapper_invoked: true }

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 动态 import 路径（避免顶层 import 导致循环依赖）
const LIB_DIR = join(__dirname, 'lib');
const SKILL_DIR = join(__dirname, '..');
const CLAUDE_DIR = join(SKILL_DIR, '..', '..');
const BACKENDS_DIR = join(CLAUDE_DIR, 'backends');
const TEMPLATES_DIR = join(SKILL_DIR, 'templates');

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

async function main() {
  const args = process.argv.slice(2);

  // Parse CLI args
  let changeName = null;
  let round = 1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--round') {
      const val = args[i + 1];
      if (val && /^\d+$/.test(val)) {
        round = parseInt(val, 10);
        i++;
      }
      continue;
    }
    if (a.startsWith('--')) continue;
    if (!changeName) changeName = a;
  }

  if (!changeName) {
    console.error('Usage: node fanout-dispatch-agent.js <change-name> [--round N]');
    process.exit(1);
  }

  // ─── Load modules ───
  const { pathToFileURL } = await import('node:url');

  const constantsMod = await import(pathToFileURL(join(LIB_DIR, 'constants.js')).href);
  const { PROJECT_ROOT, RULES_PATH, ROLE_AGENT_MAP } = constantsMod;

  const stateStoreMod = await import(pathToFileURL(join(LIB_DIR, 'state-store.js')).href);
  const { stateLoad, statePath } = stateStoreMod;

  // C003/C002: import context-pack for assembleContextPack + expandAgentIncludes
  const contextPackMod = await import(pathToFileURL(join(LIB_DIR, 'context-pack.js')).href);
  const { assembleContextPack, expandAgentIncludes } = contextPackMod;

  const fanoutMod = await import(pathToFileURL(join(LIB_DIR, 'fanout.js')).href);
  const { fanoutDispatchPlan, createWorktrees } = fanoutMod;

  // Detect backend (before any output — avoid hardcoding backend type)
  const factoryMod = await import(pathToFileURL(join(BACKENDS_DIR, 'backend-factory.js')).href);
  const { detectBackend } = factoryMod;
  const backend = detectBackend();
  const backendType = backend.type;

  // Validate pipeline-state exists
  const stateFile = statePath(changeName);
  if (!existsSync(stateFile)) {
    output({ backend: backendType, action: 'wrapper_error', error: `change '${changeName}' not found (pipeline-state.json missing)`, wrapper_invoked: true });
    process.exit(1);
  }

  // Load state
  let state;
  try {
    state = stateLoad(changeName);
  } catch (e) {
    output({ backend: backendType, action: 'wrapper_error', error: `failed to load pipeline-state: ${e.message}`, wrapper_invoked: true });
    process.exit(1);
  }

  // Validate team mode
  if (state.mode !== 'team') {
    output({ backend: backendType, action: 'wrapper_error', error: `change '${changeName}' is not in team mode (mode=${state.mode})`, wrapper_invoked: true });
    process.exit(1);
  }

  // Validate implement phase
  if (state.current_phase !== 'implement') {
    output({ backend: backendType, action: 'wrapper_error', error: `fanout dispatch only supports implement phase (current=${state.current_phase})`, wrapper_invoked: true });
    process.exit(1);
  }

  // Parse tasks.md for lazy init (fanoutDispatchPlan needs work_items)
  if (!state.team.work_items || state.team.work_items.length === 0) {
    const changeDir = join(PROJECT_ROOT, '.harness', 'spec', 'changes', changeName);
    const parsed = fanoutMod.parseTasksMd(changeDir);
    if (parsed.length === 0) {
      output({ backend: backendType, action: 'wrapper_error', error: 'tasks.md has no parseable sections, fanout requires at least 1 work item', wrapper_invoked: true });
      process.exit(1);
    }
    state.team.work_items = parsed.map(wi => ({
      ...wi,
      status: 'available', artifact_paths: [], assigned_agent: null,
      worktree_path: null, blocked_count: 0,
    }));
    state.team.status = 'executing';
  }

  // Build dispatch plan
  const plan = fanoutDispatchPlan(state);
  if (plan.agents.length === 0) {
    output({ backend: backendType, action: 'fanout_completed', results: [], wrapper_invoked: true, reason: 'no agents to dispatch' });
    process.exit(0);
  }

  // Create worktrees
  const agentsWithWt = createWorktrees(changeName, plan.agents);

  // Build dispatch-fanout.md template (once, shared base)
  const tplPath = join(TEMPLATES_DIR, 'dispatch-fanout.md');
  let fanoutTemplate = '';
  if (existsSync(tplPath)) {
    fanoutTemplate = readFileSync(tplPath, 'utf8');
  }

  // Build siblings summary (id+title+status only, no artifact_paths)
  const siblingsSummary = (state.team.work_items || [])
    .map(wi => `- ${wi.id}: ${wi.title || ''} [status: ${wi.status}]`)
    .join('\n');

  // Get context data via assembleContextPack (once per change, shared by all agents)
  const intent = {
    criteria: state.acceptance_criteria || [],
    context_mode: state.intent?.context_mode || 'full',
  };
  const contextPack = assembleContextPack(changeName, intent, intent.context_mode, 'implement');
  const specDocs = contextPack.spec_docs?.content || '';
  const harnessRules = contextPack.harness_rules?.content || '';
  const gitDiff = contextPack.git_diff?.content || '';

  // C003: getAgentContent — reads agent file for given role, throws on missing.
  // fanout path has no legitimate minimal-prompt scenario; throw is caught by
  // renderFanoutPrompt's try/catch → result entry gets exit_status: 'BLOCKED'.
  function getAgentContent(role) {
    const agentFile = ROLE_AGENT_MAP[role];
    if (!agentFile) throw new Error(`unknown role '${role}': no agent file mapping`);
    const agentPath = join(CLAUDE_DIR, 'agents', agentFile);
    if (!existsSync(agentPath)) throw new Error(`agent file not found: ${agentPath}`);
    const raw = readFileSync(agentPath, 'utf8');
    return expandAgentIncludes(raw, join(CLAUDE_DIR, 'agents'));
  }

  // Role label helper: developer → 'Developer', reviewer → 'Reviewer'
  function roleToLabel(role) {
    if (!role) return 'Developer';
    const map = { developer: 'Developer', reviewer: 'Reviewer', architect: 'Architect', tester: 'Tester', debate: 'Debate' };
    return map[role] || (role.charAt(0).toUpperCase() + role.slice(1));
  }

  // Render finalPrompt for each agent
  function renderFanoutPrompt(agent) {
    let tpl = fanoutTemplate;
    // Split template at "---" — only content above the last "---" goes into prompt
    const parts = tpl.split('\n---\n');
    const promptSection = parts.length >= 2 ? parts.slice(0, -1).join('\n---\n') : tpl;

    // C002: agent_path — absolute path to agent file (used in <agent_definition> and <rules>)
    const agentPath = join(CLAUDE_DIR, 'agents', ROLE_AGENT_MAP[agent.role] || `${agent.role}.md`);

    const replacements = {
      '{change-name}': changeName,
      '{title}': state.intent?.task_type || 'team implement',
      '{agent_path}': agentPath,
      '{validation.agent_file_content}': getAgentContent(agent.role),
      '{previous_summary}': 'implement phase — team fanout',
      '{acceptance_criteria}': agent.description || '',
      '{agent.work_item_id}': agent.work_item_id,
      '{agent.description}': agent.description || '',
      '{agent.worktree_path}': agent.worktree_path || 'N/A',
      '{siblings_summary}': siblingsSummary,
      '{context_pack.spec_docs.content}': specDocs,
      '{context_pack.harness_rules.content}': harnessRules,
      '{context_pack.git_diff.content}': gitDiff,
      '{role_label}': roleToLabel(agent.role),
      '{action_description}': agent.role === 'reviewer'
        ? '评审一个 work item 的实现'
        : '实现一个 work item',
      '{role_specific_instructions}': agent.role === 'reviewer'
        ? '评审该 work_item 的实现质量。**禁止修改**实现文件——只读评审 + 输出 JSON 结果。'
        : '可自由修改 scope 内文件。**禁止修改**：其他 `##` 分组下的任何文件。',
    };

    let rendered = promptSection;
    for (const [key, value] of Object.entries(replacements)) {
      // Replace all bracket patterns (some may have spaces)
      // use arrow fn to avoid $ sequences in value being interpreted as regex match references
      const escaped = key.replace(/[{}]/g, (c) => '\\' + c);
      rendered = rendered.replace(new RegExp(escaped, 'g'), () => value);
    }
    return rendered;
  }

  // ─── Native Agent-tool backends: render prompts, output for main session ───
  // ZCode has no documented headless CLI and uses its built-in Agent tool.
  if (backendType === 'claude' || backendType === 'codebuddy' || backendType === 'zcode') {
    const agents = agentsWithWt.map((agent) => {
      if (agent.error) {
        return {
          work_item_id: agent.work_item_id,
          role: agent.role,
          worktree_path: agent.worktree_path || null,
          error: agent.error,
          prompt: null,
        };
      }
      let finalPrompt;
      try {
        finalPrompt = renderFanoutPrompt(agent);
      } catch (e) {
        return {
          work_item_id: agent.work_item_id,
          role: agent.role,
          worktree_path: agent.worktree_path || null,
          error: `template render failed: ${e.message}`,
          prompt: null,
          exit_status: 'BLOCKED',
        };
      }
      return {
        work_item_id: agent.work_item_id,
        role: agent.role,
        worktree_path: agent.worktree_path || null,
        error: null,
        prompt: finalPrompt,
        subagent_type: roleToSubagentType(agent.role),
      };
    });

    output({
      backend: backendType,
      action: 'invoke_fanout_agents',
      agents,
      wrapper_invoked: true,
    });
    process.exit(0);
  }

  // ─── Headless backend: parallel dispatch via CLI ───
  const backendConfig = backendType === 'qoder'
    ? { file: 'qoder-backend.js', exportName: 'QoderBackend', logsDir: 'qoder-logs' }
    : backendType === 'codex'
      ? { file: 'codex-backend.js', exportName: 'CodexBackend', logsDir: 'codex-logs' }
      : null;
  if (!backendConfig) {
    output({ backend: backendType, action: 'wrapper_error', error: `unknown headless backend: ${backendType}`, wrapper_invoked: true });
    process.exit(1);
  }

  let BackendClass, normalizeDispatchResult;
  try {
    const backendMod = await import(pathToFileURL(join(BACKENDS_DIR, backendConfig.file)).href);
    BackendClass = backendMod[backendConfig.exportName];
    if (typeof BackendClass !== 'function') {
      throw new Error(`${backendConfig.exportName} is not exported by ${backendConfig.file}`);
    }
  } catch (e) {
    output({ backend: backendType, action: 'wrapper_error', error: `failed to load ${backendType} backend: ${e.message}`, wrapper_invoked: true });
    process.exit(1);
  }

  try {
    const normMod = await import(pathToFileURL(join(LIB_DIR, 'normalize-result.js')).href);
    normalizeDispatchResult = normMod.normalizeDispatchResult;
  } catch (e) {
    output({ backend: backendType, action: 'wrapper_error', error: `failed to load normalize-result: ${e.message}`, wrapper_invoked: true });
    process.exit(1);
  }

  const headlessBackend = new BackendClass({ rulesPath: RULES_PATH });

  // Parallel dispatch
  const dispatchPromises = agentsWithWt.map(async (agent) => {
    const resultEntry = {
      work_item_id: agent.work_item_id,
      role: agent.role,
      worktree_path: agent.worktree_path || null,
      exit_status: null,
      summary: null,
      artifacts: null,
      tokens_used: null,
      log_file: null,
      error: null,
      prompt_warnings: null,
    };

    // Handle worktree creation failure
    if (agent.error) {
      resultEntry.exit_status = 'BLOCKED';
      resultEntry.error = agent.error;
      return resultEntry;
    }

    // Render prompt
    let finalPrompt;
    try {
      finalPrompt = renderFanoutPrompt(agent);
    } catch (e) {
      resultEntry.exit_status = 'BLOCKED';
      resultEntry.error = `template render failed: ${e.message}`;
      return resultEntry;
    }

    // Dispatch
    try {
      const rawResult = await headlessBackend.dispatchSubAgent(agent.role, finalPrompt, {
        skipBuildPrompt: true,
        phase: 'implement',
        changeName,
        round,
        cwd: agent.worktree_path,
        contextMode: 'full',
      });

      const normalized = normalizeDispatchResult(backendType, rawResult);
      resultEntry.exit_status = normalized.exit_status || 'DONE_WITH_CONCERNS';
      resultEntry.summary = normalized.summary || '';
      resultEntry.artifacts = normalized.artifacts || [];
      resultEntry.tokens_used = rawResult?.tokens_used ?? null;

      // C003: surface prompt_warnings from rawResult directly (not via normalizeDispatchResult,
      // which doesn't transparently pass this field). This is the secondary defense for
      // detecting incomplete prompt assembly.
      if (rawResult?.prompt_warnings) {
        resultEntry.prompt_warnings = rawResult.prompt_warnings;
      }

      // Codex backend 自行落盘；Qoder wrapper 保存标准化前的原始结果。
      const logsDir = join(PROJECT_ROOT, '.harness', 'shared-state', changeName, backendConfig.logsDir);
      if (backendType === 'qoder') {
        mkdirSync(logsDir, { recursive: true });
        const workItemId = String(agent.work_item_id || 'work-item').replace(/[^A-Za-z0-9._-]/g, '_');
        const logFile = join(logsDir, `${agent.role}-${round}-${Date.now()}-${workItemId}.json`);
        writeFileSync(logFile, `${JSON.stringify(rawResult, null, 2)}\n`, 'utf8');
        resultEntry.log_file = logFile;
      } else if (existsSync(logsDir)) {
        try {
          const files = readdirSync(logsDir)
            .filter(f => f.startsWith(`${agent.role}-${round}-`))
            .sort();
          if (files.length > 0) {
            resultEntry.log_file = join(logsDir, files[files.length - 1]);
          }
        } catch {}
      }
    } catch (e) {
      resultEntry.exit_status = 'BLOCKED';
      resultEntry.error = e.message || String(e);
    }

    return resultEntry;
  });

  const results = await Promise.all(dispatchPromises);

  // Output unified JSON
  output({
    backend: backendType,
    action: 'fanout_completed',
    results,
    wrapper_invoked: true,
  });
}

function output(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

main().catch(err => {
  output({ backend: backendType, action: 'wrapper_error', error: err.message, wrapper_invoked: true });
  process.exit(1);
});
