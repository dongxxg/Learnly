// lib/backend.js — 后端抽象层集成模块
import { detectBackend, createBackend } from '../../../../backends/backend-factory.js';

// 当前激活的后端实例
let currentBackend = null;

/**
 * 获取当前后端实例
 * @param {string} explicitType - 显式指定的后端类型（可选）
 * @returns {BackendInterface} 后端实例
 */
export function getBackend(explicitType = null) {
  if (currentBackend && !explicitType) {
    return currentBackend;
  }

  if (explicitType) {
    currentBackend = createBackend(explicitType);
  } else {
    currentBackend = detectBackend();
  }

  return currentBackend;
}

/**
 * 重置后端实例（用于测试或切换后端）
 */
export function resetBackend() {
  currentBackend = null;
}

/**
 * Convert the workflow's slash-command notation to the native Skill name used
 * by backends whose Skill tool does not accept a leading slash.
 */
export function normalizeSkillInvocation(skill, backendType) {
  if (typeof skill !== 'string' || backendType !== 'zcode') return skill;
  return skill.replace(/^\/+/, '');
}

/**
 * 获取后端信息（用于调试和日志）
 * @returns {object} 后端信息
 */
export function getBackendInfo() {
  const backend = getBackend();
  return {
    type: backend.type,
    name: backend.name,
    version: backend.version,
    sessionId: backend.getSessionId(),
    dataDir: backend.getDataDir(),
  };
}

// 默认导出
export default {
  getBackend,
  resetBackend,
  getBackendInfo,
  normalizeSkillInvocation,
};
