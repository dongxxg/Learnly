import { describe, expect, it } from 'vitest'
import { hasIcon, iconSvg, svgDataUrl, REQUIRED_ICON_NAMES } from './icons'

// 图标集契约（ui-kit 规格「SVG 图标集」）：
//   模块入口 5 枚 + 常用功能图标；色值经参数注入（mp data URL 无法继承 currentColor）。

describe('图标注册表', () => {
  it('必需图标全部存在（5 模块入口 + 功能图标）', () => {
    for (const name of REQUIRED_ICON_NAMES) {
      expect(hasIcon(name), `缺少图标: ${name}`).toBe(true)
    }
  })

  it('未知图标 hasIcon=false、iconSvg 返回空串', () => {
    expect(hasIcon('nope')).toBe(false)
    expect(iconSvg('nope', '#123456')).toBe('')
  })

  it('iconSvg 注入色值且不含占位符/currentColor 残留', () => {
    const svg = iconSvg('speaker', '#4CAF7A')
    expect(svg).toContain('<svg')
    expect(svg).toContain('#4CAF7A')
    expect(svg).not.toContain('COLOR')
    expect(svg).not.toContain('currentColor')
  })

  it('svgDataUrl 输出编码后的 image data URL', () => {
    const url = svgDataUrl('speaker', '#4CAF7A')
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(url).toContain('%3Csvg') // '<svg' 已被 encodeURIComponent
  })
})
