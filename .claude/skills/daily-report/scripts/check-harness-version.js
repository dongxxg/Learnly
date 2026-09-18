#!/usr/bin/env node
'use strict';

// Uni-AURI 版本门禁 CLI —— daily-report 提交日报前置检查（SKILL.md §4 Step 0）。
// exit 0 = 放行（静默）；exit 1 = 拦截（stderr 单行提示，无豁免）。
// - 版本真源与 session-start.sh / taskboard 服务端相同：rd_harness main 的
//   .harness/.harness-version（HARNESS_VERSION_URL 可覆盖，测试指向 feature 分支）
// - 网络不可达 fail-open（GitLab 故障不能停全员日报）
// - rd_harness 源仓库豁免：开发者本地领先 main 是开发期常态

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { request } = require('./lib/http');
const { evaluateVersionGate } = require('./lib/version-gate');

const REMOTE_VERSION_URL =
  process.env.HARNESS_VERSION_URL ||
  'http://192.168.5.160/public_group/rd_harness/-/raw/main/.harness/.harness-version';
const FETCH_TIMEOUT_MS = 5000;

function isSourceRepo(projectRoot) {
  try {
    const out = execSync('git remote -v', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return out.includes('public_group/rd_harness');
  } catch (_) {
    return false;
  }
}

function readLocalVersionFile(projectRoot) {
  try {
    return fs.readFileSync(path.join(projectRoot, '.harness', '.harness-version'), 'utf-8');
  } catch (_) {
    return '';
  }
}

function fetchRemoteVersionFile() {
  return request(REMOTE_VERSION_URL, { method: 'GET', timeoutMs: FETCH_TIMEOUT_MS })
    .then((res) => (res.status >= 400 ? null : res.body))
    .catch(() => null);
}

async function main() {
  const projectRoot = process.cwd();
  if (isSourceRepo(projectRoot)) return;
  const localContent = readLocalVersionFile(projectRoot);
  const remoteContent = await fetchRemoteVersionFile();
  const result = evaluateVersionGate({ localContent, remoteContent });
  if (result.blocked) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
  }
}

main();
