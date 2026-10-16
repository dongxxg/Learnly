// SVG 图标注册表 —— 24×24 线性风格（stroke=2、圆角端点），色值经参数注入。
// mp-weixin 端经 svgDataUrl 转 data URL 走 <image>；H5 端内联 <svg>（见 LIcon.vue）。
// 注意：SVG 内禁用 currentColor（data URL 无法继承），必须由 iconSvg(name, color) 显式注入。

const ICON_BODIES: Record<string, string> = {
  /* —— 模块入口 —— */
  chinese: '<path d="M4 5c2.7-1.3 5.3-1.3 8 0 2.7-1.3 5.3-1.3 8 0v14c-2.7-1.3-5.3-1.3-8 0-2.7-1.3-5.3-1.3-8 0z"/><path d="M12 5v14"/>',
  english: '<path d="M4 20 10 4l6 16"/><path d="M6.2 14h7.6"/><path d="M17.5 15.5a2.5 2.5 0 1 1 2.5-2.5v5"/><path d="M17.5 18a2.5 2.5 0 0 0 2.5-2.5"/>',
  math: '<path d="M4 6h7"/><path d="M7.5 2.5v7"/><path d="M13 6h7"/><path d="M4 17h7"/><path d="M13.5 13.5l6 6"/><path d="M19.5 13.5l-6 6"/>',
  'ai-teacher': '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4.5"/><circle cx="12" cy="3.5" r="1"/><path d="M8.5 12.5v2"/><path d="M15.5 12.5v2"/>',
  parent: '<path d="M12 20.5S5 16 5 10.5A4 4 0 0 1 12 8a4 4 0 0 1 7 2.5c0 5.5-7 10-7 10z"/>',
  /* —— 功能图标 —— */
  speaker: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5H4z"/><path d="M16.5 9a4.5 4.5 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/>',
  play: '<path d="M8 5.5 19 12 8 18.5z"/>',
  replay: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 3.5V8h-4.5"/>',
  'chevron-right': '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
  'chevron-left': '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  star: '<path d="m12 3 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 18.8l-6.2 3.2L7 15.2l-5-4.9 6.9-1z"/>',
}

/** 任务必需图标（ui-kit 规格守护：缺一即测试失败） */
export const REQUIRED_ICON_NAMES = [
  'chinese',
  'english',
  'math',
  'ai-teacher',
  'parent',
  'speaker',
  'play',
  'replay',
  'chevron-right',
  'chevron-left',
  'check',
  'star',
] as const

export function hasIcon(name: string): boolean {
  return name in ICON_BODIES
}

/** 组装完整 SVG 字符串；未知图标返回空串 */
export function iconSvg(name: string, color: string): string {
  const body = ICON_BODIES[name]
  if (!body) return ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}

/** mp-weixin <image> 用 data URL */
export function svgDataUrl(name: string, color: string): string {
  const svg = iconSvg(name, color)
  if (!svg) return ''
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
