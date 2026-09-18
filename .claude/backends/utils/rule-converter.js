// utils/rule-converter.js — 规则格式转换器
import { readFileSync } from 'node:fs';
import { parseYaml } from '../../skills/rd-auto/scripts/lib/yaml-parser.js';

/**
 * 将 workflow 字段渲染为对 Codex 后端可读的简短文本行（数组）。
 *
 * workflow 结构（harness-rules.yaml）：
 *   workflow:
 *     pipeline: [{ step, action, executor, precondition, condition,
 *                  exit_required, quality_gate, quality_gates,
 *                  must_complete_before }, ...]
 *     tdd_check: { ... }            // 决策树，可选
 *     <其他子键>
 *
 * 渲染策略：
 *   - pipeline：每个 step 渲染为 `Step N: action (executor: X) [precondition: ...]`
 *     及附加字段（condition / exit_required / quality_gate(s) / must_complete_before）
 *     作为子项
 *   - 其他子键：用 yaml inline 形式简化输出（避免 [object Object]）
 */
function renderWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object') return [];
  const lines = [];

  const pipeline = workflow.pipeline;
  if (Array.isArray(pipeline)) {
    for (const step of pipeline) {
      if (!step || typeof step !== 'object') continue;
      const stepNo = step.step != null ? String(step.step) : '?';
      const action = step.action || '(no action)';
      const head = [`Step ${stepNo}: ${action}`];
      if (step.executor) head.push(`(executor: ${step.executor})`);
      if (step.precondition && step.precondition !== 'none') {
        head.push(`[precondition: ${step.precondition}]`);
      }
      lines.push(head.join(' '));

      // 附加字段，避免漏掉 condition/exit_required/quality_gate 等
      const extras = [
        'condition',
        'exit_required',
        'must_complete_before',
        'quality_gate',
        'quality_gates',
      ];
      for (const key of extras) {
        if (step[key] == null) continue;
        const val = step[key];
        const valStr = Array.isArray(val) ? val.join(', ')
          : (typeof val === 'object' ? JSON.stringify(val) : String(val));
        lines.push(`  - ${key}: ${valStr}`);
      }
    }
  }

  // 其他非 pipeline 子键：避免 [object Object]，简要渲染为 yaml 风格
  for (const [key, val] of Object.entries(workflow)) {
    if (key === 'pipeline') continue;
    if (val == null) continue;
    let valStr;
    if (typeof val === 'string') {
      valStr = val;
    } else if (typeof val === 'object') {
      // 复杂对象用 JSON 简化，避免落入 [object Object]
      try { valStr = JSON.stringify(val); } catch { valStr = String(val); }
    } else {
      valStr = String(val);
    }
    lines.push(`- ${key}: ${valStr}`);
  }

  return lines;
}

/**
 * 将 harness-rules.yaml 转换为 Codex prompt 格式
 */
export class RuleConverter {
  constructor(rulesPath) {
    this.rulesPath = rulesPath;
    this.rules = null;
    this.cache = null;
  }

  /**
   * 加载规则文件
   */
  loadRules() {
    if (this.rules) return this.rules;

    try {
      const content = readFileSync(this.rulesPath, 'utf8');
      this.rules = parseYaml(content);
      return this.rules;
    } catch (error) {
      console.error('Failed to load rules:', error.message);
      return null;
    }
  }

  /**
   * 转换为 Codex prompt 格式
   */
  toCodexPrompt() {
    if (this.cache) return this.cache;

    const rules = this.loadRules();
    if (!rules) return '';

    const parts = [];

    // 标题
    parts.push('# Uni-AURI 框架规则');
    parts.push('');
    parts.push('以下是必须遵守的框架规则，违反规则将导致任务失败：');
    parts.push('');

    // 角色调度表
    if (rules.roles) {
      parts.push('## 角色职责');
      parts.push('');
      for (const [role, config] of Object.entries(rules.roles)) {
        parts.push(`**${role}**:`);
        if (config.responsibilities) {
          parts.push(`- 职责: ${config.responsibilities.join(', ')}`);
        }
        if (config.forbidden) {
          parts.push(`- 禁止: ${config.forbidden.join(', ')}`);
        }
        parts.push('');
      }
    }

    // 退出状态
    if (rules.exit_states) {
      parts.push('## 任务完成标准');
      parts.push('');
      for (const [state, config] of Object.entries(rules.exit_states)) {
        parts.push(`**${state}**: ${config.meaning || ''}`);
        if (config.action) {
          parts.push(`- 行动: ${typeof config.action === 'string' ? config.action : JSON.stringify(config.action)}`);
        }
        parts.push('');
      }
    }

    // 质量门禁
    if (rules.quality_gates) {
      parts.push('## 质量门禁');
      parts.push('');
      for (const [gate, config] of Object.entries(rules.quality_gates)) {
        parts.push(`**${gate}**: ${config.description || ''}`);
        if (config.threshold) {
          parts.push(`- 阈值: ${config.threshold}`);
        }
        parts.push('');
      }
    }

    // 工作流约束
    if (rules.workflow) {
      const workflowLines = renderWorkflow(rules.workflow);
      if (workflowLines.length > 0) {
        parts.push('## 工作流程');
        parts.push('');
        for (const line of workflowLines) parts.push(line);
        parts.push('');
      }
    }

    this.cache = parts.join('\n');
    return this.cache;
  }

  /**
   * 获取角色定义
   */
  getRoleConfig(role) {
    const rules = this.loadRules();
    if (!rules || !rules.roles) return null;

    const roleName = role.toLowerCase();
    if (rules.roles[roleName]) {
      return rules.roles[roleName];
    }

    // 尝试匹配部分名称
    for (const [key, value] of Object.entries(rules.roles)) {
      if (key.includes(roleName) || roleName.includes(key)) {
        return value;
      }
    }

    return null;
  }

  /**
   * 获取退出状态定义
   */
  getExitStateConfig(state) {
    const rules = this.loadRules();
    if (!rules || !rules.exit_states) return null;

    return rules.exit_states[state] || null;
  }
}

export default RuleConverter;
