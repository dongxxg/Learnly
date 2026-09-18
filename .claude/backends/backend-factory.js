// backend-factory.js — 后端工厂类，负责检测和创建后端实例
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { ClaudeBackend } from './claude-backend.js';
import { CodexBackend } from './codex-backend.js';
import { CodebuddyBackend } from './codebuddy-backend.js';
import { QoderBackend } from './qoder-backend.js';
import { ZcodeBackend } from './zcode-backend.js';
import { DshBackend } from './dsh-backend.js';

// 自定义后端注册表
const CUSTOM_BACKENDS = new Map();

/**
 * 检测当前环境并返回对应后端
 * @returns {BackendInterface} 后端实例
 */
export function detectBackend() {
  // 1. 环境变量显式指定
  const explicitBackend = process.env.HARNESS_BACKEND?.toLowerCase();
  if (explicitBackend === 'codex') {
    return new CodexBackend();
  }
  if (explicitBackend === 'claude') {
    return new ClaudeBackend();
  }
  if (explicitBackend === 'codebuddy') {
    return new CodebuddyBackend();
  }
  if (explicitBackend === 'qoder') {
    return new QoderBackend();
  }
  if (explicitBackend === 'zcode') {
    return new ZcodeBackend();
  }
  if (explicitBackend === 'dsh') {
    return new DshBackend();
  }
  if (explicitBackend && CUSTOM_BACKENDS.has(explicitBackend)) {
    const BackendClass = CUSTOM_BACKENDS.get(explicitBackend);
    return new BackendClass();
  }

  // 2. Qoder 原生项目/会话信号最具体，优先于可能从父进程继承的其它 session 变量。
  if (process.env.QODER_SESSION_ID || process.env.QODER_PROJECT_DIR) {
    return new QoderBackend();
  }

  // 2.5. DeepSeek Harness 环境信号（DSH_SESSION_ID 由 DSH 注入，仅 DSH 会话内出现）
  if (process.env.DSH_SESSION_ID) {
    return new DshBackend();
  }

  // 3. 检测 CodeBuddy 环境（优先于 claude，codebuddy 是独立后端）
  if (process.env.CODEBUDDY_SESSION_ID) {
    return new CodebuddyBackend();
  }

  // 4. 检测 Claude Code 环境
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    return new ClaudeBackend();
  }

  // 5. 检测 Codex CLI 环境信号（不得被其它已安装 CLI 抢占）
  if (process.env.CODEX_SESSION_ID) {
    return new CodexBackend();
  }

  // 6. setup 写入的项目 backend 标记优先于 PATH 中安装了哪些 CLI。
  // 映射全部内建 backend，避免“项目明确配置 Codex/Claude，但机器装了 Qoder”时抢占。
  try {
    const backendDir = execSync('git config --get harness.backend-dir', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (backendDir === '.qoder') return new QoderBackend();
    if (backendDir === '.zcode') return new ZcodeBackend();
    if (backendDir === '.codex') return new CodexBackend();
    if (backendDir === '.codebuddy') return new CodebuddyBackend();
    if (backendDir === '.claude') return new ClaudeBackend();
    if (backendDir === '.dsh') return new DshBackend();
  } catch {
    // 非 Git 项目或未设置 backend-dir
  }

  // 7. 只有单个派生目录时，可无环境变量识别当前项目。
  const cwd = process.cwd();
  if (
    existsSync(`${cwd}/.qoder`) &&
    !existsSync(`${cwd}/.claude`) &&
    !existsSync(`${cwd}/.codex`) &&
    !existsSync(`${cwd}/.codebuddy`)
  ) {
    return new QoderBackend();
  }
  if (
    existsSync(`${cwd}/.zcode`) &&
    !existsSync(`${cwd}/.claude`) &&
    !existsSync(`${cwd}/.codex`) &&
    !existsSync(`${cwd}/.codebuddy`) &&
    !existsSync(`${cwd}/.qoder`)
  ) {
    return new ZcodeBackend();
  }
  if (
    existsSync(`${cwd}/.dsh`) &&
    !existsSync(`${cwd}/.claude`) &&
    !existsSync(`${cwd}/.codex`) &&
    !existsSync(`${cwd}/.codebuddy`) &&
    !existsSync(`${cwd}/.qoder`) &&
    !existsSync(`${cwd}/.zcode`)
  ) {
    return new DshBackend();
  }

  // 8. CLI 探测只作为最后兜底；保持原有 Codex 优先级
  try {
    execSync('codex --version', { stdio: 'pipe' });
    return new CodexBackend();
  } catch {
    // codex 命令不可用
  }

  try {
    execSync('qoderclicn --version', { stdio: 'pipe' });
    return new QoderBackend();
  } catch {
    // qoderclicn 命令不可用
  }

  // 9. 默认使用 Claude Code
  return new ClaudeBackend();
}

/**
 * 根据类型创建后端
 * @param {string} type - 后端类型 ('claude' | 'codex' | 'codebuddy' | 'qoder' | 'zcode' | 'dsh')
 * @returns {BackendInterface} 后端实例
 */
export function createBackend(type) {
  switch (type.toLowerCase()) {
    case 'claude':
      return new ClaudeBackend();
    case 'codex':
      return new CodexBackend();
    case 'codebuddy':
      return new CodebuddyBackend();
    case 'qoder':
      return new QoderBackend();
    case 'zcode':
      return new ZcodeBackend();
    case 'dsh':
      return new DshBackend();
    default:
      if (CUSTOM_BACKENDS.has(type.toLowerCase())) {
        const BackendClass = CUSTOM_BACKENDS.get(type.toLowerCase());
        return new BackendClass();
      }
      throw new Error(`Unknown backend type: ${type}. Known: claude, codex, codebuddy, qoder, zcode, dsh`);
  }
}

/**
 * 注册自定义后端
 * @param {string} type - 后端类型标识
 * @param {Function} BackendClass - 后端类构造函数
 */
export function registerBackend(type, BackendClass) {
  if (typeof BackendClass !== 'function') {
    throw new Error('BackendClass must be a constructor function');
  }
  CUSTOM_BACKENDS.set(type.toLowerCase(), BackendClass);
}

/**
 * 获取所有已注册的后端类型
 * @returns {string[]} 后端类型列表
 */
export function getRegisteredBackends() {
  return ['claude', 'codex', 'codebuddy', 'qoder', 'zcode', 'dsh', ...Array.from(CUSTOM_BACKENDS.keys())];
}

export default {
  detectBackend,
  createBackend,
  registerBackend,
  getRegisteredBackends,
};
