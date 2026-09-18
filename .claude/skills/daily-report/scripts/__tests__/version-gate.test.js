'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseVersionFile,
  expectedSignature,
  evaluateVersionGate,
  SIGN_SALT,
} = require('../lib/version-gate');

// 版本文件 3 行契约：version / force / signature（bump-version.sh 写入）
function versionFile(version, force, sig) {
  return `${version}\n${force}\n${sig}\n`;
}

test('expectedSignature: 与真实版本文件签名一致（1.23.1 → f300a0ef）', () => {
  // 跨链路一致性锚点：session-start.sh 用 `echo -n "${V}${SALT}" | sha256sum | cut -c1-8`
  // 产出的仓库真实签名即 f300a0ef，本实现必须产出同值
  assert.strictEqual(expectedSignature('1.23.1'), 'f300a0ef');
  assert.strictEqual(SIGN_SALT, 'rd-harness-v2');
});

test('parseVersionFile: 3 行契约 + 容错', () => {
  assert.deepStrictEqual(parseVersionFile(versionFile('1.24.0', 'force', 'abcd1234')), {
    version: '1.24.0',
    forceFlag: 'force',
    signature: 'abcd1234',
  });
  assert.deepStrictEqual(parseVersionFile(''), { version: '', forceFlag: '', signature: '' });
  assert.deepStrictEqual(parseVersionFile(null), { version: '', forceFlag: '', signature: '' });
});

test('放行: 版本一致（force 标记不生效）', () => {
  const v = '1.24.0';
  const r = evaluateVersionGate({
    localContent: versionFile(v, '', expectedSignature(v)),
    remoteContent: versionFile(v, 'force', 'x'),
  });
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.code, 'OK');
});

test('拦截: 远端 force 且版本不同', () => {
  const r = evaluateVersionGate({
    localContent: versionFile('1.23.1', '', expectedSignature('1.23.1')),
    remoteContent: versionFile('1.24.0', 'force', 'x'),
  });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.code, 'FORCE_UPGRADE');
  assert.match(r.message, /远程 1\.24\.0 \/ 当前 1\.23\.1/);
  assert.match(r.message, /upgrade-harness/);
});

test('放行: 远端更新但非 force', () => {
  const r = evaluateVersionGate({
    localContent: versionFile('1.23.1', '', expectedSignature('1.23.1')),
    remoteContent: versionFile('1.24.0', '', 'x'),
  });
  assert.strictEqual(r.blocked, false);
});

test('放行: 远端不可达（fail-open）', () => {
  const r = evaluateVersionGate({
    localContent: versionFile('1.23.1', '', expectedSignature('1.23.1')),
    remoteContent: null,
  });
  assert.strictEqual(r.blocked, false);
});

test('放行: 远端内容异常（空/错误页）视为不可达', () => {
  for (const bad of ['', '\n\n', '<html>404</html>\n']) {
    const r = evaluateVersionGate({
      localContent: versionFile('1.23.1', '', expectedSignature('1.23.1')),
      remoteContent: bad,
    });
    assert.strictEqual(r.blocked, false);
  }
});

test('拦截: 本地签名被篡改', () => {
  const r = evaluateVersionGate({
    localContent: versionFile('1.23.1', '', 'deadbeef'),
    remoteContent: versionFile('1.23.1', '', 'x'),
  });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.code, 'TAMPERED');
});

test('拦截: 本地版本文件缺失', () => {
  const r = evaluateVersionGate({ localContent: '', remoteContent: versionFile('1.23.1', '', 'x') });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.code, 'TAMPERED');
});
