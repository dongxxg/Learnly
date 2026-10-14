/**
 * 拆解格纯逻辑（任务 18.3）：
 * - buildStrokeTiles：hanzi-data（含 strokeNames）→ 每格（已写 past/当前 current/未写 future）路径分组
 * - parsePath：hanzi-writer-data 的 SVG path（M/L/Q/C/Z 绝对指令）→ 可逐指令绘制的命令序列
 * spec：strokeNames 缺失/长度不符/含空值 → buildStrokeTiles 返回空数组，拆解区整体隐藏。
 */
import { describe, it, expect } from 'vitest'
import { buildStrokeTiles, parsePath, TILE_COLORS } from './stroke-tiles'
import type { HanziData } from '@/hanzi-data'

const fakeData = (strokes: string[], strokeNames?: string[]): HanziData => ({
  strokes,
  medians: strokes.map(() => []),
  strokeNames,
})

describe('buildStrokeTiles', () => {
  const data = fakeData(['d1', 'd2', 'd3'], ['横', '竖', '撇'])

  it('strokeNames 缺失 → 空数组（整区隐藏降级）', () => {
    expect(buildStrokeTiles(fakeData(['d1']))).toEqual([])
  })

  it('strokeNames 数量与笔画数不符 → 空数组', () => {
    expect(buildStrokeTiles(fakeData(['d1', 'd2'], ['横']))).toEqual([])
  })

  it('strokeNames 含空串/非字符串 → 空数组（不渲染半残数据）', () => {
    expect(buildStrokeTiles(fakeData(['d1'], ['']))).toEqual([])
    expect(buildStrokeTiles(fakeData(['d1'], [undefined as unknown as string]))).toEqual([])
  })

  it('空笔画数据 → 空数组', () => {
    expect(buildStrokeTiles(fakeData([], []))).toEqual([])
  })

  it('N 笔生成 N 格，第 k 格 = k-1 已写 + 1 当前 + 其余未写', () => {
    const tiles = buildStrokeTiles(data)
    expect(tiles.map((t) => t.num)).toEqual([1, 2, 3])
    expect(tiles.map((t) => t.name)).toEqual(['横', '竖', '撇'])

    expect(tiles[0].paths).toEqual([
      { d: 'd1', tone: 'current' },
      { d: 'd2', tone: 'future' },
      { d: 'd3', tone: 'future' },
    ])
    expect(tiles[1].paths).toEqual([
      { d: 'd1', tone: 'past' },
      { d: 'd2', tone: 'current' },
      { d: 'd3', tone: 'future' },
    ])
    expect(tiles[2].paths).toEqual([
      { d: 'd1', tone: 'past' },
      { d: 'd2', tone: 'past' },
      { d: 'd3', tone: 'current' },
    ])
  })

  it('单笔字只有一格且无 past/future', () => {
    const tiles = buildStrokeTiles(fakeData(['only'], ['点']))
    expect(tiles).toHaveLength(1)
    expect(tiles[0].paths).toEqual([{ d: 'only', tone: 'current' }])
  })

  it('三色调色板齐全（past 黑 / current 红 / future 浅灰）', () => {
    expect(TILE_COLORS.past).toMatch(/^#[0-9a-f]{6}$/i)
    expect(TILE_COLORS.current).toMatch(/^#[0-9a-f]{6}$/i)
    expect(TILE_COLORS.future).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('parsePath', () => {
  it('解析 M/L/Z 指令', () => {
    expect(parsePath('M 100 200 L 300 400 Z')).toEqual([
      { cmd: 'M', params: [100, 200] },
      { cmd: 'L', params: [300, 400] },
      { cmd: 'Z', params: [] },
    ])
  })

  it('解析 Q/C 曲线指令（hanzi-writer-data 主体）', () => {
    expect(parsePath('M 518 382 Q 572 385 623 389 C 700 395 800 400 900 401 Z')).toEqual([
      { cmd: 'M', params: [518, 382] },
      { cmd: 'Q', params: [572, 385, 623, 389] },
      { cmd: 'C', params: [700, 395, 800, 400, 900, 401] },
      { cmd: 'Z', params: [] },
    ])
  })

  it('负数坐标可用', () => {
    expect(parsePath('M -10 -20 L 30 40')).toEqual([
      { cmd: 'M', params: [-10, -20] },
      { cmd: 'L', params: [30, 40] },
    ])
  })

  it('不支持的指令抛错（数据异常早暴露，不允许静默画错）', () => {
    expect(() => parsePath('A 1 2 3 4 5 6 7')).toThrow(/A/)
  })

  it('参数个数不符抛错', () => {
    expect(() => parsePath('L 1 2 3')).toThrow(/参数异常/)
  })

  it('非数字参数抛错', () => {
    expect(() => parsePath('M a b')).toThrow(/参数异常/)
  })

  it('无参指令带参数抛错', () => {
    expect(() => parsePath('Z 5')).toThrow(/参数异常/)
  })

  it('空串返回空命令序列', () => {
    expect(parsePath('')).toEqual([])
  })
})
