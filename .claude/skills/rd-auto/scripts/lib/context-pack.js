// lib/context-pack.js — Context pack assembly, token estimation, agent includes, mode recommendation
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  PROJECT_ROOT, RULES_PATH, CONTEXT_SOURCES, TOTAL_TOKEN_BUDGET, MODE_BLOCKLIST, debugLog
} from './constants.js';
import { statePath } from './state-store.js';

// ─── File Helpers ───

function getFileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch (e) { debugLog('getFileSize failed —', e.message); return 0; }
}

function getMtime(filePath) {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch (e) { debugLog('getMtime failed —', e.message); return null; }
}

// ─── Token Estimation ───

export function estimateTokens(text) {
  if (!text) return 0;
  // CJK characters: 1 token per 2 chars
  // English/other: 1 token per 4 chars
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3000 && code <= 0x303F) || (code >= 0x3040 && code <= 0x30FF) ||
        (code >= 0xAC00 && code <= 0xD7AF)) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  return Math.ceil(cjkCount / 2) + Math.ceil(otherCount / 4);
}

export function truncateToTokens(text, maxTokens) {
  if (!text) return '';
  // Rough truncation: estimate chars from tokens and cut
  // Conservative: assume worst case (CJK) where 2 chars = 1 token
  const maxChars = maxTokens * 2;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

// ─── Mode Recommendation ───

/**
 * recommendMode(intent) — pure function
 * Input: intent object with complexity_score, affected_files[], modules[], flow_type
 * Output: { recommended: 'legacy'|'team', reasons: string[], blocked: boolean }
 */
export function recommendMode(intent) {
  if (!intent || typeof intent !== 'object') {
    return { recommended: 'legacy', reasons: [], blocked: false };
  }

  const reasons = [];
  const flowType = typeof intent.flow_type === 'string' ? intent.flow_type : '';
  const complexityScore = typeof intent.complexity_score === 'number' ? intent.complexity_score : 0;
  const affectedFiles = Array.isArray(intent.affected_files) ? intent.affected_files : [];
  const modules = Array.isArray(intent.modules) ? intent.modules
    : (typeof intent.modules === 'number' ? new Array(intent.modules).fill('module') : []);

  // BLOCKLIST check first — forces legacy regardless of other dimensions
  if (flowType && MODE_BLOCKLIST.includes(flowType)) {
    return { recommended: 'legacy', reasons: [`flow_type blocked: ${flowType}`], blocked: true };
  }

  // OR-based threshold checks
  if (complexityScore >= 70) {
    reasons.push('complexity_score >= 70');
  }
  if (affectedFiles.length >= 5) {
    reasons.push('affected_files >= 5');
  }
  if (modules.length >= 3) {
    reasons.push('modules >= 3');
  }

  if (reasons.length > 0) {
    return { recommended: 'team', reasons, blocked: false };
  }

  return { recommended: 'legacy', reasons: [], blocked: false };
}

// ─── Expand Agent Includes ───

// expandAgentIncludes — resolve @include directives in agent definition files
// Matches: // @include: refs/xxx.md or // @include: ../refs/xxx.md
// Recursively expands nested includes. Prevents circular includes via a visited set.
export function expandAgentIncludes(content, agentDir, _visited) {
  const visited = _visited || new Set();
  const includeRe = /\/\/\s*@include:\s*((?:refs|\.\.\/refs)\/[^\s]+\.md)/g;

  let expanded = content;
  const matches = [];
  let match;
  while ((match = includeRe.exec(content)) !== null) {
    matches.push({ full: match[0], path: match[1] });
  }

  for (const { full, path: includePath } of matches) {
    const fullPath = resolve(join(agentDir, includePath));
    if (!existsSync(fullPath)) {
      process.stderr.write(`[expandAgentIncludes] WARNING: include file not found: ${fullPath} (from ${includePath})\n`);
      continue;
    }
    if (visited.has(fullPath)) {
      process.stderr.write(`[expandAgentIncludes] WARNING: circular include detected: ${fullPath}\n`);
      continue;
    }
    visited.add(fullPath);
    let includedContent = readFileSync(fullPath, 'utf8');
    // Recursively expand includes in the referenced file
    includedContent = expandAgentIncludes(includedContent, dirname(fullPath), visited);
    expanded = expanded.replace(full, includedContent);
  }

  return expanded;
}

// ─── Minimal Context ───

function buildMinimalContext(intent) {
  const problemStatement = Array.isArray(intent.criteria) ? intent.criteria.join('\n') : (intent.criteria || '');
  const fileScope = [];

  if (intent.affected_files && Array.isArray(intent.affected_files)) {
    for (const f of intent.affected_files) {
      const fullPath = join(PROJECT_ROOT, f);
      fileScope.push({
        path: f,
        exists: existsSync(fullPath),
        size: existsSync(fullPath) ? getFileSize(fullPath) : 0,
        last_modified: existsSync(fullPath) ? getMtime(fullPath) : null
      });
    }
  }

  const hints = [];
  if (intent.raw_input) {
    if (intent.raw_input.includes('调用链') || intent.raw_input.includes('依赖')) {
      hints.push('建议使用 grep 追踪函数调用链');
    }
    if (intent.raw_input.includes('历史') || intent.raw_input.includes('考古')) {
      hints.push('建议使用 git log --follow 查看历史');
    }
  }

  return {
    problem_statement: problemStatement,
    file_scope: fileScope,
    investigation_hints: hints,
    context_mode: 'minimal'
  };
}

// ─── Read-Only Context ───

function buildReadOnlyContext(changeName, intent) {
  const pack = {};

  // 1. acceptance_criteria (retain)
  const criteria = Array.isArray(intent.criteria) ? intent.criteria.join('\n') : (intent.criteria || '');
  pack.acceptance_criteria = { content: criteria, truncated: false, token_count: 0 };

  // 2. git_diff (truncate to --stat only)
  let gitDiff = '';
  try {
    gitDiff = execSync('git diff --stat', { encoding: 'utf8', cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) { debugLog('assembleContextPack: git diff --stat failed —', e.message); gitDiff = ''; }
  pack.git_diff = { content: gitDiff, truncated: false, token_count: 0 };

  // 3. error_log (skip)
  pack.error_log = { content: '', truncated: false, token_count: 0 };

  // 4. spec_docs (truncate to decisions summary only)
  let specDocs = '';
  if (changeName) {
    const specDir = join(PROJECT_ROOT, '.harness', 'spec', 'changes', changeName);
    const designPath = join(specDir, 'design.md');
    if (existsSync(designPath)) {
      try {
        const designContent = readFileSync(designPath, 'utf8');
        const decisionsSection = designContent.match(/## Decisions\s*\n([\s\S]*?)(?=\n## )/);
        if (decisionsSection) {
          specDocs = decisionsSection[1];
        }
      } catch (e) { debugLog('assembleContextPack: design.md decisions parse failed —', e.message); }
    }
  }
  pack.spec_docs = { content: specDocs, truncated: false, token_count: 0 };

  // 5. agent_history (only last phase summary)
  let agentHistory = '';
  if (changeName) {
    const stateFile = statePath(changeName);
    if (existsSync(stateFile)) {
      try {
        const st = JSON.parse(readFileSync(stateFile, 'utf8'));
        const phases = Object.keys(st.pipeline || {}).filter(p =>
          st.pipeline[p].summary && st.pipeline[p].status === 'done'
        );
        if (phases.length > 0) {
          const lastPhase = phases[phases.length - 1];
          agentHistory = `[${lastPhase}] ${st.pipeline[lastPhase].summary}`;
        }
      } catch (e) { debugLog('assembleContextPack: agent_history parse failed —', e.message); }
    }
  }
  pack.agent_history = { content: agentHistory, truncated: false, token_count: 0 };

  // 6. harness_rules (retain)
  let harnessRules = '';
  try {
    const rulesText = readFileSync(RULES_PATH, 'utf8');
    const loIdx = rulesText.indexOf('local_orchestrator:');
    if (loIdx > 0) harnessRules += rulesText.slice(loIdx, Math.min(loIdx + 2000, rulesText.length)) + '\n';
  } catch (e) { debugLog('assembleContextPack: harness_rules read failed —', e.message); }
  pack.harness_rules = { content: harnessRules, truncated: false, token_count: 0 };

  // Apply read-only token budget (4500 tokens)
  const READ_ONLY_TOKEN_BUDGET = 4500;
  let totalTokens = 0;
  const readOnlySources = [
    { key: 'acceptance_criteria', maxTokens: 3000, priority: 1 },
    { key: 'git_diff', maxTokens: 200, priority: 2 },
    { key: 'spec_docs', maxTokens: 500, priority: 3 },
    { key: 'agent_history', maxTokens: 300, priority: 4 },
    { key: 'harness_rules', maxTokens: 500, priority: 5 },
  ];

  for (const source of readOnlySources) {
    const entry = pack[source.key];
    if (!entry) continue;

    const rawTokens = estimateTokens(entry.content);
    const remaining = READ_ONLY_TOKEN_BUDGET - totalTokens;
    const allowedTokens = Math.min(source.maxTokens, remaining);

    if (rawTokens <= allowedTokens) {
      entry.token_count = rawTokens;
      totalTokens += rawTokens;
    } else if (allowedTokens > 0) {
      entry.content = truncateToTokens(entry.content, allowedTokens);
      entry.token_count = estimateTokens(entry.content);
      entry.truncated = true;
      totalTokens += entry.token_count;
    } else {
      entry.content = '';
      entry.token_count = 0;
      if (rawTokens > 0) entry.truncated = true;
    }
  }

  pack.context_mode = 'read_only';
  return pack;
}

// ─── Full Context Pack Assembly ───

// Per-phase context source skip rules — skip expensive IO for sources irrelevant to this phase.
// Key: phase, Value: set of CONTEXT_SOURCES keys to skip (don't exec/read at all)
const PHASE_CONTEXT_SKIP = {
  explore:       new Set(['git_diff', 'error_log', 'agent_history']),
  propose:       new Set(['git_diff', 'error_log', 'agent_history']),
  'design-review': new Set(['git_diff', 'error_log']),
  implement:     new Set(['error_log']),
  test:          new Set(['error_log', 'harness_rules']),
  'code-review': new Set([]),  // needs everything
  debate:        new Set(['git_diff', 'error_log']),
  archive:       new Set(['git_diff', 'error_log', 'spec_docs', 'agent_history']),
};

// Per-phase harness_rules anchor selection — each phase gets the most relevant yaml section.
// Key: phase, Value: primary yaml anchor to slice from (2000 chars, then truncated to token budget).
const PHASE_RULES_ANCHORS = {
  explore:        'constraints:',
  propose:        'constraints:',
  'design-review': 'scoring:',
  implement:      'scoring:',
  // test: harness_rules is skipped entirely (see PHASE_CONTEXT_SKIP)
  'code-review':  'scoring:',
  debate:         'scoring:',
  archive:        'shared_state:',
};

/**
 * assembleContextPack(changeName, intent, contextMode, phase?) — build context for dispatch.
 * phase (optional): 'explore' | 'propose' | 'design-review' | 'implement' | 'test' |
 *                    'code-review' | 'debate' | 'archive'
 * When provided, irrelevant sources are skipped entirely (no exec/read),
 * allowing other sources to use the freed token budget.
 */
export function assembleContextPack(changeName, intent, contextMode = 'full', phase) {
  if (contextMode === 'minimal') {
    return buildMinimalContext(intent);
  }

  if (contextMode === 'read_only') {
    return buildReadOnlyContext(changeName, intent);
  }

  // full mode (default)
  const pack = {};
  const skip = (phase && PHASE_CONTEXT_SKIP[phase]) ? PHASE_CONTEXT_SKIP[phase] : new Set();

  // 1. acceptance_criteria — always needed
  const criteria = Array.isArray(intent.criteria) ? intent.criteria.join('\n') : (intent.criteria || '');
  pack.acceptance_criteria = { content: criteria, truncated: false, token_count: 0 };

  // 2. git_diff — skip for explore, propose, design-review, debate, archive
  if (!skip.has('git_diff')) {
    let gitDiff = '';
    try {
      gitDiff = execSync('git diff --stat && git diff', { encoding: 'utf8', cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { debugLog('assembleByPhase: git diff failed —', e.message); gitDiff = ''; }
    pack.git_diff = { content: gitDiff, truncated: false, token_count: 0 };
  } else {
    pack.git_diff = { content: '', truncated: false, token_count: 0 };
  }

  // 3. error_log — skip for all except code-review
  pack.error_log = { content: '', truncated: false, token_count: 0 };

  // 4. spec_docs — skip for archive, explore (not yet created)
  if (!skip.has('spec_docs')) {
    let specDocs = '';
    if (changeName) {
      const specDir = join(PROJECT_ROOT, '.harness', 'spec', 'changes', changeName);
      if (existsSync(specDir)) {
        try {
          // Extract key sections instead of full concatenation:
          // - design.md → Decisions section (most decision-relevant)
          // - tasks.md → progress summary (done/total + remaining task titles)
          // - Other files → skip (defer to agent on-demand Read)
          const designPath = join(specDir, 'design.md');
          if (existsSync(designPath)) {
            const designContent = readFileSync(designPath, 'utf8');
            const decisions = designContent.match(/## Decisions\s*\n([\s\S]*?)(?=\n## )/);
            if (decisions) specDocs += '## design.md Decisions\n' + decisions[1].trim() + '\n\n';
          }
          const tasksPath = join(specDir, 'tasks.md');
          if (existsSync(tasksPath)) {
            const tasksContent = readFileSync(tasksPath, 'utf8');
            const allTasks = [...tasksContent.matchAll(/^-\s*\[([ xX])\]\s*(.+)$/gm)];
            const done = allTasks.filter(m => m[1].toLowerCase() === 'x').length;
            const pending = allTasks.filter(m => m[1] === ' ').length;
            specDocs += `## tasks.md Progress: ${done}/${allTasks.length} done, ${pending} remaining\n`;
            if (pending > 0) {
              const pendingTasks = allTasks.filter(m => m[1] === ' ').map(m => m[2].trim()).slice(0, 10);
              specDocs += 'Remaining: ' + pendingTasks.join(' | ');
              if (pending > 10) specDocs += ` ... +${pending - 10} more`;
            }
          }
        } catch (e) { debugLog('assembleByPhase: spec_docs parse failed —', e.message); }
      }
    }
    pack.spec_docs = { content: specDocs, truncated: false, token_count: 0 };
  } else {
    pack.spec_docs = { content: '', truncated: false, token_count: 0 };
  }

  // 5. agent_history — skip for explore, propose, archive
  if (!skip.has('agent_history')) {
    let agentHistory = '';
    if (changeName) {
      const stateFile = statePath(changeName);
      if (existsSync(stateFile)) {
        try {
          const st = JSON.parse(readFileSync(stateFile, 'utf8'));
          for (const [ph, data] of Object.entries(st.pipeline || {})) {
            if (data.summary) agentHistory += `[${ph}] ${data.summary}\n`;
          }
        } catch (e) { debugLog('assembleByPhase: agent_history parse failed —', e.message); }
      }
    }
    pack.agent_history = { content: agentHistory, truncated: false, token_count: 0 };
  } else {
    pack.agent_history = { content: '', truncated: false, token_count: 0 };
  }

  // 6. harness_rules — skip for test (tester focuses on testing, not orchestration)
  if (!skip.has('harness_rules')) {
    let harnessRules = '';
    try {
      const rulesText = readFileSync(RULES_PATH, 'utf8');
      const anchor = (phase && PHASE_RULES_ANCHORS[phase]) ? PHASE_RULES_ANCHORS[phase] : 'scoring:';
      const anchorIdx = rulesText.indexOf(anchor);
      if (anchorIdx > 0) harnessRules += rulesText.slice(anchorIdx, Math.min(anchorIdx + 2000, rulesText.length)) + '\n';
    } catch (e) { debugLog('assembleByPhase: harness_rules read failed —', e.message); }
    pack.harness_rules = { content: harnessRules, truncated: false, token_count: 0 };
  } else {
    pack.harness_rules = { content: '', truncated: false, token_count: 0 };
  }

  // Now apply priority-based truncation
  let totalTokens = 0;
  for (const source of CONTEXT_SOURCES) {
    const entry = pack[source.key];
    const rawTokens = estimateTokens(entry.content);
    const remaining = TOTAL_TOKEN_BUDGET - totalTokens;
    const allowedTokens = Math.min(source.maxTokens, remaining);

    if (rawTokens <= allowedTokens) {
      entry.token_count = rawTokens;
      totalTokens += rawTokens;
    } else if (allowedTokens > 0) {
      entry.content = truncateToTokens(entry.content, allowedTokens);
      entry.token_count = estimateTokens(entry.content);
      entry.truncated = true;
      totalTokens += entry.token_count;
    } else {
      entry.content = '';
      entry.token_count = 0;
      if (rawTokens > 0) entry.truncated = true;
    }
  }

  pack.context_mode = 'full';
  return pack;
}
