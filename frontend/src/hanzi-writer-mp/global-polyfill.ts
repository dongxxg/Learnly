/**
 * 小程序逻辑层环境修正，必须在本目录任何 import hanzi-writer 的模块之前执行。
 */

export function ensureGlobal(): void {
  const g = globalThis as Record<string, unknown>
  // 1) 补逻辑层缺失的 global（hanzi-writer 模块加载期引用）
  if (typeof g.global === 'undefined') {
    g.global = globalThis
  }
  // 2) 摘除微信 canvas 2d 环境的全局 Path2D：其与 ctx.stroke(Path2D) 不兼容
  //    （官方要求 canvas.createPath2D()，且构造时仅告警不报错，导致笔画静默不可见）。
  //    置空后 hanzi-writer 走 pathStringToCanvas 指令式绘制降级路径。
  try {
    Object.defineProperty(g, 'Path2D', { value: undefined, configurable: true, writable: true })
  } catch {
    // 极端环境 defineProperty 失败时保持原样（指令式降级不生效属可接受降级）。
  }
}

// 模块顶层自执行：仅导出函数会被 tree-shake 成空模块（side-effect import 失效）。
ensureGlobal()
