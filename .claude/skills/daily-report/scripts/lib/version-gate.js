'use strict';

// Uni-AURI 版本门禁 —— 纯判定逻辑（无 IO），供 check-harness-version.js CLI 调用。
// 判定规则与 hooks/shared/session-start.sh 保持一致（单一语义，两处同步改）：
//   - 本地版本文件缺失或签名不匹配 → 拦截（TAMPERED）
//   - 远端版本文件第 2 行为 force 且与本地版本不同 → 拦截（FORCE_UPGRADE）
//   - 版本一致 / 远端非 force / 远端不可达（remoteContent 为 null）→ 放行
// 版本文件 3 行契约：version / force / signature（bump-version.sh 写入，
// 首行 `head -1` 契约见 collect-ai.js readHarnessVersion）。

const crypto = require('node:crypto');

const SIGN_SALT = 'rd-harness-v2';

function parseVersionFile(content) {
  const lines = String(content || '').split('\n');
  return {
    version: (lines[0] || '').trim(),
    forceFlag: (lines[1] || '').trim(),
    signature: (lines[2] || '').trim(),
  };
}

function expectedSignature(version) {
  return crypto
    .createHash('sha256')
    .update(`${version}${SIGN_SALT}`)
    .digest('hex')
    .slice(0, 8);
}

// remoteContent: string | null —— null 表示远端不可达，fail-open 放行
function evaluateVersionGate({ localContent, remoteContent }) {
  const local = parseVersionFile(localContent);
  if (!local.version || local.signature !== expectedSignature(local.version)) {
    return {
      blocked: true,
      code: 'TAMPERED',
      message:
        'Uni-AURI 必须升级: 版本文件缺失或被篡改 — 运行 /upgrade-harness 升级框架后才能提交日报',
    };
  }

  if (remoteContent == null) return { blocked: false, code: 'OK' };
  const remote = parseVersionFile(remoteContent);
  // 远端内容异常（空文件/HTML 错误页）视为不可达，fail-open
  if (!remote.version) return { blocked: false, code: 'OK' };

  if (remote.forceFlag === 'force' && remote.version !== local.version) {
    return {
      blocked: true,
      code: 'FORCE_UPGRADE',
      message: `Uni-AURI 必须升级: 远程 ${remote.version} / 当前 ${local.version} — 运行 /upgrade-harness 升级框架后才能提交日报`,
    };
  }
  return { blocked: false, code: 'OK' };
}

module.exports = { parseVersionFile, expectedSignature, evaluateVersionGate, SIGN_SALT };
