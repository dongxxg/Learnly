// lib/plugin-emit.mjs — 生成各 agent 的 plugin.json。
// 版本号取自 .claude-plugin/plugin.json（事实源）；skills 路径仍指向 .claude/skills/（框架本体）。
import { frameworkVersion } from './common.mjs';

/**
 * @param {object} opts
 * @param {string} opts.backend  codebuddy | codex
 * @param {string} opts.name     插件展示名（如 "Uni-AURI (CodeBuddy)"）
 * @param {boolean} [opts.interfaceBlock] 是否包含 Codex 风格 interface 块
 */
export function pluginJson({ backend, name, interfaceBlock = false }) {
  const version = frameworkVersion();
  const cap = backend.charAt(0).toUpperCase() + backend.slice(1);
  const base = {
    name: 'rd-harness',
    version,
    description: `Uni-AURI — auto-dispatch AI roles through full lifecycle: explore, design, implement, test, review, archive. ${cap} backend fully supported.`,
    author: { name: 'wangzk' },
    homepage: 'http://192.168.5.160/public_group/rd_harness',
    repository: 'http://192.168.5.160/public_group/rd_harness',
    license: 'MIT',
    keywords: [...new Set(['multi-agent', 'orchestration', 'tdd', 'code-review', 'spec-driven', 'ci-cd', 'skills', 'codex', 'claude', backend])],
    skills: '.claude/skills/',
  };
  if (interfaceBlock) {
    base.interface = {
      displayName: 'Uni-AURI',
      shortDescription: 'Uni-AURI — auto-orchestration for AI-powered development',
      longDescription: 'Uni-AURI automatically dispatches AI roles (Architect, Developer, Tester, Reviewer) through a structured pipeline: explore requirements, design architecture, implement with TDD, run tests, code review, and archive specs. Supports both Claude Code and Codex CLI as AI backends.',
      developerName: 'wangzk',
      category: 'Coding',
      capabilities: ['Interactive', 'Read', 'Write', 'Bash'],
      websiteURL: 'http://192.168.5.160/public_group/rd_harness',
    };
  }
  return base;
}
