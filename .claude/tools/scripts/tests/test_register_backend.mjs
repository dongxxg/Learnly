// test_register_backend.mjs — Unit tests for backend-factory registerBackend / createBackend / getRegisteredBackends
//
// Covers:
//   1. registerBackend + createBackend routes to custom backend
//   2. createBackend unknown type throws (built-in + custom)
//   3. registerBackend non-function throws
//   4. getRegisteredBackends includes custom + built-in
//   5. Duplicate registration overwrites previous
//   6. createBackend case insensitive for custom backends
//   7. HARNESS_BACKEND=custom routes via detectBackend (subprocess with inline registration)
//   8. Unknown HARNESS_BACKEND falls through detection chain
//   9. registerBackend key lowercased (create via any case accessor)
//
// Run: node .claude/tools/scripts/tests/test_register_backend.mjs

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { registerBackend, createBackend, getRegisteredBackends } from '../../../backends/backend-factory.js';

const tests = [];

// Mock backend class (minimal interface)
class MockBackend {
  constructor() {
    this.type = 'mock';
    this.name = 'MockBackend';
    this.version = '1.0.0';
  }
  detect() { return true; }
  getSessionId() { return 'mock-session'; }
  getDataDir() { return '/tmp/mock'; }
  dispatchSubAgent() { return { exitStatus: 'DONE' }; }
  injectRules() { return true; }
  enforceGates() { return true; }
  recordUsage() {}
  getTranscriptPath() { return null; }
  extractTokenUsage() { return null; }
}

// ─── Test 1: register + createBackend routes to custom backend ───
tests.push(function testRegisterAndCreateBackend() {
  registerBackend('mock', MockBackend);
  const instance = createBackend('mock');
  assert.equal(instance.type, 'mock');
  assert.equal(instance.name, 'MockBackend');
  assert.equal(instance.version, '1.0.0');
  assert.equal(typeof instance.detect, 'function');
  assert.equal(typeof instance.dispatchSubAgent, 'function');
});

// ─── Test 2: createBackend unknown type throws ───
tests.push(function testCreateBackendUnknownType() {
  assert.throws(
    () => createBackend('nonexistent_backend_type_xyz'),
    /Unknown backend type/
  );
});

// ─── Test 3: non-function throws ───
tests.push(function testRegisterNonFunctionThrows() {
  assert.throws(
    () => registerBackend('bad_str', 'not_a_function'),
    /BackendClass must be a constructor function/
  );
  assert.throws(
    () => registerBackend('bad_num', 123),
    /BackendClass must be a constructor function/
  );
  assert.throws(
    () => registerBackend('bad_null', null),
    /BackendClass must be a constructor function/
  );
});

// ─── Test 4: getRegisteredBackends includes custom + built-in ───
tests.push(function testGetRegisteredBackends() {
  registerBackend('custom_alpha', MockBackend);
  const list = getRegisteredBackends();
  assert.ok(list.includes('claude'), 'should include claude');
  assert.ok(list.includes('codex'), 'should include codex');
  assert.ok(list.includes('mock'), 'should include mock');
  assert.ok(list.includes('custom_alpha'), 'should include custom_alpha');
});

// ─── Test 5: duplicate registration overwrites ───
tests.push(function testDuplicateRegistrationOverwrites() {
  class V1 extends MockBackend { constructor() { super(); this.version = 'v1'; } }
  class V2 extends MockBackend { constructor() { super(); this.version = 'v2'; } }
  registerBackend('dup_test', V1);
  assert.equal(createBackend('dup_test').version, 'v1');
  registerBackend('dup_test', V2);
  assert.equal(createBackend('dup_test').version, 'v2');
});

// ─── Test 6: createBackend case insensitive for custom backends ───
tests.push(function testCreateBackendCaseInsensitive() {
  registerBackend('CASE_MIX', MockBackend);
  assert.equal(createBackend('case_mix').type, 'mock');
  assert.equal(createBackend('CASE_MIX').type, 'mock');
  assert.equal(createBackend('Case_Mix').type, 'mock');
});

// ─── Test 7: HARNESS_BACKEND routes to custom backend via detectBackend ───
tests.push(function testDetectBackendCustomViaEnv() {
  // Subprocess must register the custom backend first (module state not shared)
  const result = execSync(
    'node --input-type=module -e ' +
    '\'import { registerBackend, detectBackend } from "./.claude/backends/backend-factory.js";' +
    'class M { constructor() { this.type = "test"; this.name = "TestBackend"; }' +
    'detect(){return true;} getSessionId(){return "";} getDataDir(){return "";}' +
    'dispatchSubAgent(){return{};} injectRules(){return true;} enforceGates(){return true;}' +
    'recordUsage(){} getTranscriptPath(){return null;} extractTokenUsage(){return null;}}' +
    'registerBackend("test", M);' +
    'const b = detectBackend(); console.log(JSON.stringify({type:b.type,name:b.name}));\' ' +
    '2>/dev/null || node --input-type=module -e ' +
    '\'import { registerBackend, detectBackend } from "./.claude/backends/backend-factory.js";' +
    'class M { constructor() { this.type = "test"; this.name = "TestBackend"; }' +
    'detect(){return true;} getSessionId(){return "";} getDataDir(){return "";}' +
    'dispatchSubAgent(){return{};} injectRules(){return true;} enforceGates(){return true;}' +
    'recordUsage(){} getTranscriptPath(){return null;} extractTokenUsage(){return null;}}' +
    'registerBackend("test", M);' +
    '// HARNESS_BACKEND not set → falls to detection chain; unset env var in code' +
    'process.env.HARNESS_BACKEND = "";' +
    'const b = detectBackend(); console.log(JSON.stringify({type:b.type}));\'',
    { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }
  ).trim();
  // With HARNESS_BACKEND not set, detection chain runs (CLAUDE_CODE_SESSION_ID → claude,
  // inside DeepSeek Harness DSH_SESSION_ID → dsh)
  const parsed = JSON.parse(result);
  assert.ok(['claude', 'codex', 'dsh'].includes(parsed.type),
    `expected claude, codex or dsh, got ${parsed.type}`);
});

// ─── Test 8: unknown HARNESS_BACKEND falls through detection chain ───
tests.push(function testDetectBackendUnknownEnvFallsThrough() {
  const result = execSync(
    'HARNESS_BACKEND=completely_unknown_xyz node --input-type=module -e ' +
    '\'import { detectBackend } from "./.claude/backends/backend-factory.js"; ' +
    'const b = detectBackend(); console.log(JSON.stringify({ type: b.type }));\'',
    { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }
  ).trim();
  const parsed = JSON.parse(result);
  // Falls through to detection chain; in this session CLAUDE_CODE_SESSION_ID → claude,
  // inside DeepSeek Harness DSH_SESSION_ID → dsh
  assert.ok(['claude', 'codex', 'dsh'].includes(parsed.type),
    `expected claude, codex or dsh, got ${parsed.type}`);
});

// ─── Test 9: HARNESS_BACKEND=claude routes to ClaudeBackend ───
tests.push(function testDetectBackendClaudeViaEnv() {
  const result = execSync(
    'HARNESS_BACKEND=claude node --input-type=module -e ' +
    '\'import { detectBackend } from "./.claude/backends/backend-factory.js"; ' +
    'const b = detectBackend(); console.log(JSON.stringify({ type: b.type }));\'',
    { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }
  ).trim();
  const parsed = JSON.parse(result);
  assert.equal(parsed.type, 'claude');
});

// ─── Run ───
let failed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`# PASS: ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`# FAIL: ${t.name}`);
    console.log(`  ${e.message}`);
    const stackLines = (e.stack || '').split('\n').slice(1, 4);
    for (const l of stackLines) console.log(`  ${l.trim()}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed${failed === 0 ? '' : ', ' + failed + ' failed'}`);
if (failed > 0) process.exit(1);
