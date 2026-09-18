#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_NAME = 'uni-auri';
const INLINE_PLUGIN_ID = `${PLUGIN_NAME}@inline`;
const MANIFEST_LOCATIONS = [
  ['.zcode-plugin', 'plugin.json'],
  ['.claude-plugin', 'plugin.json'],
  ['.codex-plugin', 'plugin.json'],
];

function fail(message) {
  process.stderr.write(`configure-zcode-plugin: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plugin-root') options.pluginRoot = argv[++index];
    else if (arg === '--config') options.configPath = argv[++index];
    else if (arg === '--json') options.json = true;
    else fail(`unknown argument: ${arg}`);
  }
  if (!options.pluginRoot) fail('--plugin-root is required');
  return options;
}

function parseJsonObject(content, label) {
  let value;
  try {
    value = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function readPluginManifest(pluginRoot) {
  for (const parts of MANIFEST_LOCATIONS) {
    const manifestPath = join(pluginRoot, ...parts);
    if (!existsSync(manifestPath)) continue;
    return {
      manifest: parseJsonObject(readFileSync(manifestPath, 'utf8'), manifestPath),
      manifestPath,
    };
  }
  throw new Error(`no plugin manifest found under ${pluginRoot}`);
}

function pathKey(value) {
  const normalized = resolve(value).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isManagedUniAuriRoot(value) {
  try {
    return readPluginManifest(resolve(value)).manifest.name === PLUGIN_NAME;
  } catch {
    return false;
  }
}

export function configureZcodePlugin(config, pluginRoot) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('ZCode config must be a JSON object');
  }

  const currentPlugins = config.plugins ?? {};
  if (!currentPlugins || typeof currentPlugins !== 'object' || Array.isArray(currentPlugins)) {
    throw new Error('ZCode config field "plugins" must be an object');
  }

  const currentDirs = currentPlugins.dirs ?? [];
  if (!Array.isArray(currentDirs) || currentDirs.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('ZCode config field "plugins.dirs" must be an array of non-empty strings');
  }

  const currentEnabledPlugins = currentPlugins.enabledPlugins ?? {};
  if (!currentEnabledPlugins || typeof currentEnabledPlugins !== 'object' || Array.isArray(currentEnabledPlugins)) {
    throw new Error('ZCode config field "plugins.enabledPlugins" must be an object');
  }

  const absolutePluginRoot = resolve(pluginRoot);
  const rootKey = pathKey(absolutePluginRoot);
  const retainedDirs = currentDirs.filter((value) => {
    if (pathKey(value) === rootKey) return false;
    return !isManagedUniAuriRoot(value);
  });

  return {
    ...config,
    plugins: {
      ...currentPlugins,
      enabled: true,
      dirs: [absolutePluginRoot, ...retainedDirs],
      enabledPlugins: {
        ...currentEnabledPlugins,
        [INLINE_PLUGIN_ID]: true,
      },
    },
  };
}

function writeJsonAtomically(filePath, value) {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const temporary = join(parent, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const pluginRoot = resolve(options.pluginRoot);
  const { manifest, manifestPath } = readPluginManifest(pluginRoot);
  if (manifest.name !== PLUGIN_NAME) {
    throw new Error(`expected plugin name "${PLUGIN_NAME}" in ${manifestPath}, got "${manifest.name ?? ''}"`);
  }

  const configPath = resolve(
    options.configPath
      || process.env.ZCODE_CONFIG_FILE
      || join(homedir(), '.zcode', 'cli', 'config.json'),
  );
  const current = existsSync(configPath)
    ? parseJsonObject(readFileSync(configPath, 'utf8'), configPath)
    : {};
  const next = configureZcodePlugin(current, pluginRoot);
  writeJsonAtomically(configPath, next);

  const result = { configPath, pluginId: INLINE_PLUGIN_ID, pluginRoot };
  process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `ZCode plugin enabled: ${INLINE_PLUGIN_ID}\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
