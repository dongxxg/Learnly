#!/usr/bin/env node
// orchestrator.js — pipeline state machine engine for rd_harness auto-orchestrator
// Main entry point: imports from lib/* modules, CLI dispatch switch
// Usage: node orchestrator.js <command> [options]

import {
  cmdInit, cmdSetPhase, cmdMarkDispatch, cmdAdvance,
  cmdRunAutomated, cmdStatus, cmdDashboard, cmdStats, cmdComplete,
  cmdParseIntent, cmdDispatchPrompt, cmdRecordUsage,
  cmdQuickDispatch, cmdRecommendMode, cmdVerifyQuick, cmdUpgradeToFull,
  cmdReadSharedState, cmdWriteSharedState, cmdResolveConcern,
  cmdSyncInterfaces, cmdArchiveInterfaces, cmdParseTasksMd
} from './lib/cli-commands.js';

import { tryPushMetrics } from './lib/advance.js';
import { getBackendInfo } from './lib/backend.js';

// Re-export all key constants and functions for backward compatibility
// (external scripts may import from orchestrator.js)
export { PROJECT_ROOT, RULES_PATH, SCRIPTS_DIR, SKILL_DIR, CLAUDE_DIR,
         MODE_BLOCKLIST, CONTEXT_SOURCES, TOTAL_TOKEN_BUDGET,
         DEFAULT_FANOUT_CONCURRENCY, METRICS_THROTTLE_MS,
         errExit, output, parseArgs, getArg } from './lib/constants.js';
export * from './lib/yaml-parser.js';
export * from './lib/state-store.js';
export * from './lib/transitions.js';
export * from './lib/advance.js';
export * from './lib/stats.js';
export * from './lib/fanout.js';
export * from './lib/context-pack.js';
export * from './lib/backend.js';
export {
  cmdInit, cmdSetPhase, cmdMarkDispatch, cmdAdvance,
  cmdRunAutomated, cmdStatus, cmdDashboard, cmdStats, cmdComplete,
  cmdParseIntent, cmdDispatchPrompt, cmdRecordUsage,
  cmdQuickDispatch, cmdRecommendMode, cmdVerifyQuick, cmdUpgradeToFull,
  cmdReadSharedState, cmdWriteSharedState, cmdResolveConcern,
  cmdSyncInterfaces, cmdArchiveInterfaces, cmdParseTasksMd
} from './lib/cli-commands.js';

// ─── Main ───

const command = process.argv[2];
const args = process.argv.slice(3);
// First positional arg = change name (for advance/complete/set-phase).
const changeOf = (a) => a.find((x) => typeof x === 'string' && !x.startsWith('-'));

switch (command) {
  case 'init':                cmdInit(args); break;
  case 'set-phase':           cmdSetPhase(args); break;
  case 'mark-dispatch':       cmdMarkDispatch(args); if (args.includes('--end')) tryPushMetrics(60_000); break;
  case 'advance':             cmdAdvance(args); tryPushMetrics(); break;
  case 'status':              cmdStatus(args); break;
  case 'dashboard':           cmdDashboard(args); break;
  case 'stats':               cmdStats(args); break;
  case 'complete':            cmdComplete(args); tryPushMetrics(); break;
  case 'parse-intent':        cmdParseIntent(args); break;
  case 'dispatch-prompt':     cmdDispatchPrompt(args); break;
  case 'record-usage':        cmdRecordUsage(args); break;
  case 'run-automated':       cmdRunAutomated(args); break;
  case 'quick-dispatch':      cmdQuickDispatch(args); break;
  case 'recommend-mode':      cmdRecommendMode(args); break;
  case 'verify-quick':        cmdVerifyQuick(args); break;
  case 'upgrade-to-full':     cmdUpgradeToFull(args); break;
  case 'read-shared-state':   cmdReadSharedState(args); break;
  case 'write-shared-state':  cmdWriteSharedState(args); break;
  case 'resolve-concern':     cmdResolveConcern(args); break;
  case 'sync-interfaces':     cmdSyncInterfaces(args); break;
  case 'archive-interfaces':  cmdArchiveInterfaces(args); break;
  case 'parse-tasks-md':      cmdParseTasksMd(args); break;
  case 'backend-info':        console.log(JSON.stringify(getBackendInfo(), null, 2)); break;
  default:
    console.log('Usage: node orchestrator.js <command> [options]');
    console.log('Commands: init, set-phase, mark-dispatch, advance, run-automated, status, dashboard, stats, complete, parse-intent, quick-dispatch, verify-quick, upgrade-to-full, dispatch-prompt, record-usage, recommend-mode, parse-tasks-md, read-shared-state, write-shared-state, resolve-concern, sync-interfaces, archive-interfaces, backend-info');
    process.exit(1);
}
