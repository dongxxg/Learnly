// lib/constants.js — shared constants and path resolution
// Used by all lib modules to avoid circular imports with orchestrator.js
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// ─── Polyfill: Array.findLast (Node.js < 18 compat) ───

if (!Array.prototype.findLast) {
  Array.prototype.findLast = function (predicate) {
    for (let i = this.length - 1; i >= 0; i--) {
      if (predicate.call(this, this[i], i, this)) return this[i];
    }
    return undefined;
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = join(__dirname, '..');                       // .claude/skills/rd-auto/scripts/
export const SKILL_DIR = join(SCRIPTS_DIR, '..');                       // .claude/skills/rd-auto/
export const CLAUDE_DIR = join(SKILL_DIR, '..', '..');                  // .claude/

// PROJECT_ROOT: --project-root flag > find .harness ancestor > process.cwd()
// Walks up from cwd to find .harness/ directory, making cwd drift safe.
const _explicitRoot = process.argv.find((a, i) => i > 1 && process.argv[i - 1] === '--project-root');
function _findProjectRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const harnessDir = join(dir, '.harness');
    // Validate: a real project root has .harness/ AND is NOT inside the framework dir
    // (prevents <framework>/.harness/ stale artifacts). Use HARNESS_ROOT when set.
    const frameworkDir = process.env.HARNESS_ROOT || '.claude';
    if (existsSync(harnessDir) && !dir.endsWith('/' + frameworkDir) && !dir.endsWith('\\' + frameworkDir)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;          // reached filesystem root
    dir = parent;
  }
  return startDir;                      // fallback: use original cwd
}
export const PROJECT_ROOT = _explicitRoot || _findProjectRoot(process.cwd());
export const RULES_PATH = join(CLAUDE_DIR, 'reference', 'harness-rules.yaml');

// Mode blocklist: flow types that should never use team mode
export const MODE_BLOCKLIST = ['hotfix', 'quick', 'config-change', 'docs'];

// Context pack constants
export const CONTEXT_SOURCES = [
  { key: 'acceptance_criteria', maxTokens: 5000, priority: 1 },
  { key: 'git_diff',            maxTokens: 1500, priority: 2 },
  { key: 'error_log',           maxTokens: 1000, priority: 3 },
  { key: 'spec_docs',           maxTokens: 1000, priority: 4 },
  { key: 'agent_history',       maxTokens: 1000, priority: 5 },
  { key: 'harness_rules',       maxTokens: 500,  priority: 6 },
];
export const TOTAL_TOKEN_BUDGET = 5000;

// Fanout constants
export const DEFAULT_FANOUT_CONCURRENCY = 2;

// Rework target roles — buildReworkResponse routes current_phase to one of these
// during rework (issue !247). They are ROLE names, never real DAG phases, so they
// can be used both to recognize "we are mid-rework" and to filter them out of
// phase-progress accounting (getCountedPhases).
export const REWORK_TARGET_ROLES = new Set(['architect', 'developer', 'tester']);

// Metrics throttle
export const METRICS_THROTTLE_MS = 30_000;

// ─── Shared utilities (avoids circular deps between lib modules) ───

export function errExit(msg) {
  console.error(`[orchestrator] Error: ${msg}`);
  process.exit(1);
}

export function output(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

export function debugLog(...args) {
  if (process.env.DEBUG_HARNESS) console.error('[harness]', ...args);
}

export function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        result[key] = args[++i];
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

export function getArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

// Role agent map
export const ROLE_AGENT_MAP = {
  architect: 'architect.md',
  developer: 'developer.md',
  tester: 'tester.md',
  reviewer: 'reviewer.md',
  debate: 'debate.md',
};
