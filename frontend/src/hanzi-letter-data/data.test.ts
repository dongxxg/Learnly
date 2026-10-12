import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getHanziData } from '../hanzi-data'
import { getLetterData, hasLetterData, LETTER_GLYPHS } from './index'

/**
 * 字母笔顺数据契约（specs/english-alphabet：四线三格笔顺展示与书写）。
 * 数据由 scripts/gen-letter-data.mjs 生成，坐标空间与 hanzi-writer-data 同构：
 * x ∈ [0, 1024]，y ∈ [-124, 900]（y 轴向上，hanzi-writer Positioner CHARACTER_BOUNDS）。
 */
const DATA_DIR = fileURLToPath(new URL('.', import.meta.url))
const BOUNDS = { minX: 0, maxX: 1024, minY: -124, maxY: 900 }
const NUM = '-?\\d+(\\.\\d+)?'
const PATH_RE = new RegExp(`^M ${NUM} ${NUM}( L ${NUM} ${NUM})* Z$`)

function expectedFiles(): string[] {
  return LETTER_GLYPHS.map((ch) => `lc-${ch.codePointAt(0)!.toString(16)}.json`)
}

describe('hanzi-letter-data / 生成产物契约', () => {
  it('52 字形数据文件齐全（A–Z 大小写，lc-<码点>.json）', () => {
    const files = readdirSync(DATA_DIR).filter((f) => f.startsWith('lc-') && f.endsWith('.json'))
    expect(files.sort()).toEqual(expectedFiles().sort())
  })

  it('每个字形 strokes/medians 数量一致、path 仅含 M/L/Z 且可解析、medians 在数据边界内', () => {
    for (const file of expectedFiles()) {
      const data = JSON.parse(readFileSync(DATA_DIR + file, 'utf-8')) as {
        strokes: string[]
        medians: number[][][]
      }
      expect(data.strokes.length, file).toBeGreaterThanOrEqual(1)
      expect(data.strokes.length, file).toBe(data.medians.length)
      for (const path of data.strokes) {
        expect(path, file).toMatch(PATH_RE)
      }
      for (const median of data.medians) {
        expect(median.length, file).toBeGreaterThanOrEqual(2)
        for (const [x, y] of median) {
          expect(x, file).toBeGreaterThanOrEqual(BOUNDS.minX)
          expect(x, file).toBeLessThanOrEqual(BOUNDS.maxX)
          expect(y, file).toBeGreaterThanOrEqual(BOUNDS.minY)
          expect(y, file).toBeLessThanOrEqual(BOUNDS.maxY)
        }
      }
    }
  })
})

describe('hanzi-letter-data / getLetterData', () => {
  it('52 字形全量可取', () => {
    for (const ch of LETTER_GLYPHS) {
      const data = getLetterData(ch)
      expect(data, ch).not.toBeNull()
      expect(data!.strokes.length, ch).toBe(data!.medians.length)
    }
  })

  it('未知字形返回 null（降级入口，页面据此隐藏书写区）', () => {
    expect(getLetterData('汉')).toBeNull()
    expect(getLetterData('1')).toBeNull()
    expect(getLetterData('')).toBeNull()
    expect(hasLetterData('汉')).toBe(false)
  })

  it('lc- 前缀与 hanzi-data 互不交叉污染', () => {
    expect(getLetterData('一')).toBeNull()
    expect(hasLetterData('一')).toBe(false)
    expect(getHanziData('A')).toBeNull()
    expect(getHanziData('a')).toBeNull()
  })
})
