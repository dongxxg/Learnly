import { describe, expect, it } from 'vitest'
import { scanTemplateAttrs, scanStyleContent } from '../../scripts/check-tokens.mjs'

// 令牌引用扫描规则（design-tokens 规格「令牌唯一权威」）：
//   .vue 文件中禁止硬编码 hex 色值 / 越阶字号 / 字面量阴影；
//   教学组件 3 文件整体白名单（田字格/四线三格渐变线位+线色是冻结的数学契约）。

const RULES = { HEX: 'hardcoded-hex', FONT: 'off-scale-font', SHADOW: 'literal-shadow' }

describe('scanStyleContent', () => {
  it('检出硬编码 hex 色值', () => {
    const v = scanStyleContent('.a { color: #333333; }')
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe(RULES.HEX)
    expect(v[0].line).toBe(1)
  })

  it('检出越阶字号（不在 8 级字阶内）', () => {
    const v = scanStyleContent('.a { font-size: 26rpx; }')
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe(RULES.FONT)
  })

  it('检出字面量阴影（rgba/hex 直接量）', () => {
    const v = scanStyleContent('.a { box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05); }')
    expect(v.map((x: { rule: string }) => x.rule)).toContain(RULES.SHADOW)
  })

  it('检出 box-shadow 之外的 rgba 数值字面量', () => {
    const v = scanStyleContent('.a { background: rgba(0, 0, 0, 0.3); }')
    expect(v.map((x: { rule: string }) => x.rule)).toEqual(['hardcoded-rgba'])
  })

  it('放行令牌引用、SCSS 变量 rgba 与合规字号', () => {
    const src = [
      '.a { color: $learnly-text; font-size: 28rpx; }',
      '.b { color: var(--learnly-text); box-shadow: $learnly-shadow-sm; }',
      '.c { font-size: var(--learnly-fs-lg); }',
      '.d { background: rgba($learnly-primary, 0.12); }',
    ].join('\n')
    expect(scanStyleContent(src)).toEqual([])
  })

  it('放行注释与字符串中的 # 号（非色值）', () => {
    const src = ['/* 锚点 #anchor 说明 */', '.a { content: "#"; }'].join('\n')
    expect(scanStyleContent(src)).toEqual([])
  })

  it('模板行内 style 检出 hex', () => {
    expect(scanTemplateAttrs('<view style="color: #fff" />')).toHaveLength(1)
    expect(scanTemplateAttrs('<view style="color: red" />')).toEqual([])
  })

  it('教学组件白名单文件返回空（几何契约冻结）', () => {
    const src = '.grid { background: linear-gradient(#eee 33.33%, #fff 0); font-size: 88rpx; }'
    expect(scanStyleContent(src, { isWhitelisted: true })).toEqual([])
  })

  it('多行源码报告正确行号', () => {
    const src = '.a {\n  color: #09a;\n  font-size: 30rpx;\n}'
    const v = scanStyleContent(src)
    const hex = v.find((x: { rule?: string }) => x.rule === RULES.HEX)
    expect(hex?.line).toBe(2)
  })
})
