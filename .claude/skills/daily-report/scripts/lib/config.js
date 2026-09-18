'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  GITLAB_URL: 'http://192.168.5.160',
  PROJECT_ID: 'public_group%2Fdaily_report',
  BRANCH: 'dev',
  KANBAN_DIR: 'knowledge',
};

// Config and token both live in project root .gitlab-config
function findProjectRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (fs.existsSync(path.join(dir, '.gitlab-config'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();
const CONFIG_FILE = path.join(PROJECT_ROOT, '.gitlab-config');

function parseConfigFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const result = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && value) result[key] = value;
  }
  return result;
}

function resolveCred() {
  if (process.env.GITLAB_TOKEN) return process.env.GITLAB_TOKEN;
  const cfg = path.join(PROJECT_ROOT, '.gitlab-config');
  if (fs.existsSync(cfg)) {
    const m = fs.readFileSync(cfg, 'utf-8').match(/^gitlab_token=(.+)$/m);
    if (m) return m[1].trim();
  }
  return '';
}

function loadConfig() {
  const fileConfig = parseConfigFile(CONFIG_FILE);

  const gitlabUrl =
    process.env.DAILY_REPORT_GITLAB_URL ||
    fileConfig.DAILY_REPORT_GITLAB_URL ||
    DEFAULTS.GITLAB_URL;

  const projectId =
    process.env.DAILY_REPORT_PROJECT_ID ||
    fileConfig.DAILY_REPORT_PROJECT_ID ||
    DEFAULTS.PROJECT_ID;

  const branch =
    process.env.DAILY_REPORT_BRANCH ||
    fileConfig.DAILY_REPORT_BRANCH ||
    DEFAULTS.BRANCH;

  const kanbanDir =
    process.env.DAILY_REPORT_KANBAN_DIR ||
    fileConfig.KANBAN_DIR ||
    DEFAULTS.KANBAN_DIR;

  const cred = resolveCred();

  return { gitlabUrl, projectId, branch, kanbanDir, cred };
}

module.exports = { loadConfig, CONFIG_FILE, DEFAULTS, resolveCred };
