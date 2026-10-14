/**
 * 字帖模型契约（img.png 字帖样式）：四线格坐标系 + 序号/箭头几何。
 * 渲染（SVG/canvas）只消费模型输出，几何规则全部在此测试拦截。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildCopybookGlyph,
  COPYBOOK,
  type LetterGlyphData,
} from './letter-copybook-model'

const dataDir = fileURLToPath(new URL('../hanzi-letter-data/', import.meta.url))

/** 竖笔（自上而下）：median (512,866)→(512,229)，数据坐标。 */
const VERTICAL: LetterGlyphData = {
  strokes: ['M 400 800 L 620 200 Z'],
  medians: [[[512, 866], [512, 229]]],
}

describe('buildCopybookGlyph 数据守卫', () => {
  it('空数据/无笔画返回 null（调用方隐藏字帖）', () => {
    expect(buildCopybookGlyph(null)).toBeNull()
    expect(buildCopybookGlyph({ strokes: [], medians: [] })).toBeNull()
  })

  it('median 缺失时保留字形、不给序号标注（不猜位置）', () => {
    const glyph = buildCopybookGlyph({ strokes: VERTICAL.strokes, medians: undefined })
    expect(glyph?.paths).toHaveLength(1)
    expect(glyph?.marks).toHaveLength(0)
  })
})

describe('buildCopybookGlyph 坐标变换', () => {
  it('y 翻转与顶部序号带：y_screen = PAD_TOP + (900 - y_data)', () => {
    const glyph = buildCopybookGlyph(VERTICAL)
    expect(glyph).not.toBeNull()
    const mark = glyph!.marks[0]
    // 起笔 (512,866) → 屏幕顶部；收笔 (512,229) → 屏幕底部。
    expect(mark.points[0]).toEqual({ x: 512, y: COPYBOOK.PAD_TOP + 34 })
    expect(mark.points[1]).toEqual({ x: 512, y: COPYBOOK.PAD_TOP + 671 })
  })

  it('offsetX 平移半格（大写/小写并排）', () => {
    const glyph = buildCopybookGlyph(VERTICAL, 1024)
    expect(glyph!.marks[0].points[0].x).toBe(1024 + 512)
  })
})

describe('buildCopybookGlyph 箭头几何', () => {
  it('箭头尖在 median 末端，沿行笔方向', () => {
    const mark = buildCopybookGlyph(VERTICAL)!.marks[0]
    // 自上而下：尖端在底部 (512, 771+? ) —— tip 即末端点。
    expect(mark.arrow).not.toBeNull()
    expect(mark.arrow!.tip).toEqual(mark.points[1])
    // 箭头两翼在尖端后方（y 小于 tip）。
    expect(mark.arrow!.left.y).toBeLessThan(mark.arrow!.tip.y)
    expect(mark.arrow!.right.y).toBeLessThan(mark.arrow!.tip.y)
    // 两翼分居行笔方向两侧。
    const wingOffset = [mark.arrow!.left.x - mark.arrow!.tip.x, mark.arrow!.right.x - mark.arrow!.tip.x]
    expect(wingOffset[0] * wingOffset[1]).toBeLessThan(0)
  })

  it('median 单点不出箭头（方向未知）', () => {
    const glyph = buildCopybookGlyph({ strokes: ['M 1 1 L 2 2 Z'], medians: [[[100, 500]]] })
    expect(glyph!.marks[0].arrow).toBeNull()
  })
})

describe('buildCopybookGlyph 序号标注', () => {
  it('序号在起笔反方向外侧（竖笔的序号在起笔点上方）', () => {
    const mark = buildCopybookGlyph(VERTICAL)!.marks[0]
    expect(mark.num).toBe(1)
    expect(mark.label.y).toBeLessThan(mark.points[0].y)
    expect(mark.label.x).toBe(mark.points[0].x)
  })

  it('同起笔的多笔序号横向错开（A 的 1/2 不重叠）', () => {
    // 模拟 A：两笔同起于 (512,866)，行笔方向一左一右。
    const aLike: LetterGlyphData = {
      strokes: ['M 1 1 L 2 2 Z', 'M 1 1 L 3 3 Z'],
      medians: [
        [[512, 866], [252, 229]],
        [[512, 866], [772, 229]],
      ],
    }
    const marks = buildCopybookGlyph(aLike)!.marks
    const dx = Math.abs(marks[0].label.x - marks[1].label.x)
    expect(dx).toBeGreaterThanOrEqual(60)
  })
})

describe('buildCopybookGlyph 真实字库回归', () => {
  const files = readdirSync(dataDir).filter((f) => /^lc-[0-9a-f]+\.json$/.test(f))

  it(`52 个字形全部可构建：marks 数 = 笔画数，标注落在字帖幅面内`, () => {
    expect(files.length).toBe(52)
    for (const file of files) {
      const data = JSON.parse(readFileSync(path.join(dataDir, file), 'utf8')) as LetterGlyphData
      const glyph = buildCopybookGlyph(data)
      expect(glyph, file).not.toBeNull()
      expect(glyph!.marks, file).toHaveLength(data.strokes.length)
      for (const mark of glyph!.marks) {
        for (const p of [...mark.points, mark.label, ...(mark.arrow ? [mark.arrow.tip] : [])]) {
          expect(p.y, `${file} #${mark.num}`).toBeGreaterThanOrEqual(0)
          expect(p.y, `${file} #${mark.num}`).toBeLessThanOrEqual(COPYBOOK.HEIGHT)
          expect(p.x, `${file} #${mark.num}`).toBeGreaterThanOrEqual(0)
          expect(p.x, `${file} #${mark.num}`).toBeLessThanOrEqual(COPYBOOK.FRAME)
        }
      }
    }
  })
})
