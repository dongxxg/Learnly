import { describe, expect, it } from 'vitest'
import { mascotSvg } from './mascot-svg'

// 吉祥物契约（PM 定稿 2026-10-15：方向 A 简约双子叶芽，几何扁平无脸）：
//   duo 双色（萌芽绿+深绿）/ mono 单色；使用场景限 hero/庆祝/空态（见 ui-kit 规格）。

describe('mascotSvg', () => {
  it('duo 模式输出完整 SVG 且包含双叶双径', () => {
    const svg = mascotSvg({ variant: 'duo' })
    expect(svg).toContain('<svg')
    expect(svg).toContain('#4CAF7A')
    expect(svg).toContain('#3E9163')
  })

  it('mono 模式只含指定单色', () => {
    const svg = mascotSvg({ variant: 'mono', color: '#3E9163' })
    expect(svg).toContain('#3E9163')
    expect(svg).not.toContain('#4CAF7A')
  })

  it('不含 currentColor 残留（data URL 无法继承）', () => {
    expect(mascotSvg({ variant: 'duo' })).not.toContain('currentColor')
  })
})
