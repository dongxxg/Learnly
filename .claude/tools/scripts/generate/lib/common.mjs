// lib/common.mjs — shared helpers for the Uni-AURI multi-agent generator.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = dirname(__filename);

// 生成器位于 .claude/tools/scripts/generate/ → 仓库根 = 上溯 4 层
export const GENERATE_DIR = __dirname;
export const REPO_ROOT = resolve(GENERATE_DIR, '../../../../..');

/** 读取 JSON 文件（UTF-8） */
export function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** 确保目录存在 */
export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/** 写入文本文件（自动建目录） */
export function writeText(p, text) {
  ensureDir(dirname(p));
  writeFileSync(p, text, 'utf8');
}

/** 写入 JSON 文件（2 空格缩进，末尾换行） */
export function writeJson(p, obj) {
  writeText(p, JSON.stringify(obj, null, 2) + '\n');
}

/** 从 .claude-plugin/plugin.json 取版本号（事实源） */
export function frameworkVersion() {
  const p = join(REPO_ROOT, '.claude-plugin', 'plugin.json');
  if (existsSync(p)) return readJson(p).version;
  return '0.0.0';
}

// 永远排除的条目名（构建产物，不应进入派生目标）。
// copyDir/copyDirExcept 用 rmSync+walk 复制，不尊重 .gitignore，故在此显式排除。
const ALWAYS_EXCLUDE = ['__pycache__'];

/**
 * 递归复制目录（覆盖）。src 不存在则跳过。委托给 copyDirExcept，统一排除 __pycache__。
 */
export function copyDir(src, dst) {
  return copyDirExcept(src, dst, []);
}

/** 复制单个文件（自动建目录） */
export function copyFile(src, dst) {
  if (!existsSync(src)) return false;
  ensureDir(dirname(dst));
  writeFileSync(dst, readFileSync(src), 'utf8');
  return true;
}

/**
 * 递归复制目录，排除指定相对子路径（如 tools 的 tests/、generate/）。
 * 总是额外排除 __pycache__（构建产物）。
 * @param {string} src
 * @param {string} dst
 * @param {string[]} exclude 相对 src 的子路径（目录或文件），如 ["tests", "generate"]
 */
export function copyDirExcept(src, dst, exclude = []) {
  if (!existsSync(src)) return false;
  rmSync(dst, { recursive: true, force: true });
  const allExclude = [...new Set([...(exclude || []), ...ALWAYS_EXCLUDE])];
  const walk = (s, d) => {
    mkdirSync(d, { recursive: true });
    for (const name of readdirSync(s)) {
      if (allExclude.includes(name)) continue;
      const sp = join(s, name);
      const dp = join(d, name);
      if (statSync(sp).isDirectory()) walk(sp, dp);
      else writeFileSync(dp, readFileSync(sp));
    }
  };
  walk(src, dst);
  return true;
}

/**
 * 列出目录下一级子项（目录名），用于 skills/agents 复制后的校验。
 */
export function listDirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory());
}

/**
 * 把 env map 转成 shell 前缀串，例如：
 *   { HARNESS_BACKEND: "codebuddy", HARNESS_USAGE_DIR: "$HOME/.codebuddy/usage" }
 * → "HARNESS_BACKEND=codebuddy HARNESS_USAGE_DIR=\"$HOME/.codebuddy/usage\" "
 * $HOME 等变量在运行时由 shell 展开（写入配置的是字面量）。
 */
export function envPrefix(env) {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => {
      // 含 $ 或空格的值加双引号，避免被 shell 错误切分
      if (/[\s$]/.test(v) && !v.startsWith('"')) return `${k}="${v}"`;
      return `${k}=${v}`;
    })
    .join(' ') + ' ';
}

/** 读取 .claude/settings.json（源事实源） */
export function loadClaudeSettings() {
  return readJson(join(REPO_ROOT, '.claude', 'settings.json'));
}
