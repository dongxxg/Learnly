'use strict';

// taskboard-daily schema validator
//
// 复用 daily-report.schema.json（含 kanban-task / kanban-source cross-file $ref），
// 让 taskboard-daily 输出的 JSON 与 daily-report 完全兼容，下游自动发送日报服务无感切换。

const fs = require('node:fs');
const path = require('node:path');

let _validateDaily = null;
let _validateKanbanSource = null;

function getSchemasDir() {
  return path.resolve(__dirname, '..', '..', 'schemas');
}

// Issue !160: resolve ajv with multiple fallback paths so users without
// install_skill_deps can still validate daily reports.
//
// Resolution order (first hit wins):
//   1. NODE_PATH env (user explicit, highest priority)
//   2. <repo_root>/.claude/skills/daily-report-legacy/scripts/node_modules
//   3. <repo_root>/.claude/skills/daily-report/scripts/node_modules (self)
//
// If all fail, throw a clear error with remediation hints.
function resolveAjvModule(moduleId) {
  // Try plain require first (covers self node_modules + NODE_PATH naturally).
  try {
    return require(moduleId);
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    // fall through to fallback paths
    const lastErr = e;
    const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
    const harnessDir = process.env.HARNESS_ROOT || '.claude';
    const fallbackBases = [
      path.join(repoRoot, harnessDir, 'skills', 'daily-report-legacy', 'scripts', 'node_modules'),
      path.join(repoRoot, harnessDir, 'skills', 'daily-report', 'scripts', 'node_modules'),
    ];
    // Also include NODE_PATH entries explicitly (in case plain require didn't pick them up).
    const nodePath = process.env.NODE_PATH || '';
    const nodePathBases = nodePath
      .split(path.delimiter)
      .filter(Boolean)
      .map((p) => path.resolve(p));
    const candidates = [...nodePathBases, ...fallbackBases];
    for (const base of candidates) {
      try {
        const resolved = require.resolve(moduleId, { paths: [base] });
        return require(resolved);
      } catch (e2) {
        // try next candidate
      }
    }
    const hint =
      "ajv dependency not found. Please run one of:\n" +
      "  bash .claude/tools/scripts/setup/setup-harness.sh\n" +
      "  (cd .claude/skills/daily-report/scripts && npm install)\n" +
      "  export NODE_PATH=.claude/skills/daily-report-legacy/scripts/node_modules";
    const err = new Error(hint);
    err.cause = lastErr;
    throw err;
  }
}

function loadAjv() {
  if (_validateDaily && _validateKanbanSource) return { _validateDaily, _validateKanbanSource };
  const Ajv2020 = resolveAjvModule('ajv/dist/2020');
  const addFormats = resolveAjvModule('ajv-formats');
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);

  const schemasDir = getSchemasDir();
  const kanbanTask = JSON.parse(
    fs.readFileSync(path.join(schemasDir, 'kanban-task.schema.json'), 'utf-8')
  );
  const kanbanSource = JSON.parse(
    fs.readFileSync(path.join(schemasDir, 'kanban-source.schema.json'), 'utf-8')
  );
  const dailyReport = JSON.parse(
    fs.readFileSync(path.join(schemasDir, 'daily-report.schema.json'), 'utf-8')
  );

  ajv.addSchema(kanbanTask);
  ajv.addSchema(kanbanSource);
  _validateDaily = ajv.compile(dailyReport);
  _validateKanbanSource = ajv.getSchema('https://rd-harness/schemas/kanban-source.schema.json');
  if (typeof _validateKanbanSource !== 'function') {
    throw new Error('failed to resolve kanban-source.schema.json validator');
  }
  return { _validateDaily, _validateKanbanSource };
}

function formatErrors(errors) {
  return (errors || []).map((err) => {
    const loc = err.instancePath || '/';
    return `${loc}: ${err.message}${err.params ? ' (' + JSON.stringify(err.params) + ')' : ''}`;
  });
}

function shortLoadError(e) {
  const firstLine = (e && e.message ? e.message : String(e)).split('\n')[0].trim();
  return `Failed to load schemas: ${firstLine}`;
}

function validateDailyReport(data) {
  try {
    loadAjv();
  } catch (e) {
    return { valid: false, errors: [shortLoadError(e)] };
  }
  const ok = _validateDaily(data);
  if (ok) return { valid: true, errors: [] };
  return { valid: false, errors: formatErrors(_validateDaily.errors) };
}

function validateKanbanSource(data) {
  try {
    loadAjv();
  } catch (e) {
    return { valid: false, errors: [shortLoadError(e)] };
  }
  const ok = _validateKanbanSource(data);
  if (ok) return { valid: true, errors: [] };
  return { valid: false, errors: formatErrors(_validateKanbanSource.errors) };
}

module.exports = { validateDailyReport, validateKanbanSource, loadAjv };
