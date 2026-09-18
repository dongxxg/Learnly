import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { configureZcodePlugin } from '../setup/configure-zcode-plugin.mjs';

const script = resolve('.claude/tools/scripts/setup/configure-zcode-plugin.mjs');
const root = mkdtempSync(join(tmpdir(), 'zcode-plugin-config-'));

function createPlugin(path, name = 'uni-auri') {
  mkdirSync(join(path, '.zcode-plugin'), { recursive: true });
  writeFileSync(join(path, '.zcode-plugin', 'plugin.json'), `${JSON.stringify({ name })}\n`);
}

try {
  const currentPlugin = join(root, 'current', '.zcode');
  const stalePlugin = join(root, 'stale', '.zcode');
  const otherPlugin = join(root, 'other-plugin');
  createPlugin(currentPlugin);
  createPlugin(stalePlugin);
  createPlugin(otherPlugin, 'other-plugin');

  const original = {
    ui: { locale: 'zh-CN' },
    plugins: {
      enabled: false,
      dirs: [stalePlugin, otherPlugin],
      enabledPlugins: { 'uni-auri@inline': false, 'other-plugin@inline': false },
      options: { keep: { value: true } },
    },
  };
  const configured = configureZcodePlugin(original, currentPlugin);
  assert.equal(configured.plugins.enabled, true);
  assert.equal(configured.plugins.enabledPlugins['uni-auri@inline'], true);
  assert.equal(configured.plugins.enabledPlugins['other-plugin@inline'], false);
  assert.deepEqual(configured.plugins.dirs, [resolve(currentPlugin), otherPlugin]);
  assert.deepEqual(configured.plugins.options, original.plugins.options);
  assert.deepEqual(configured.ui, original.ui);
  assert.deepEqual(configureZcodePlugin(configured, currentPlugin), configured, 'configuration must be idempotent');

  const configPath = join(root, 'config', 'config.json');
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`);
  const result = spawnSync(process.execPath, [script, '--plugin-root', currentPlugin, '--config', configPath, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.pluginId, 'uni-auri@inline');
  assert.equal(output.pluginRoot, resolve(currentPlugin));
  const persisted = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(persisted, configured);

  const invalidConfigPath = join(root, 'invalid.json');
  writeFileSync(invalidConfigPath, '{ invalid json');
  const invalid = spawnSync(process.execPath, [script, '--plugin-root', currentPlugin, '--config', invalidConfigPath], {
    encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.equal(readFileSync(invalidConfigPath, 'utf8'), '{ invalid json', 'invalid config must not be overwritten');
  assert.equal(existsSync(`${invalidConfigPath}.tmp`), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('test_zcode_plugin_config: all tests passed');
