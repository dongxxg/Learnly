/**
 * 笔顺数据完整性契约（任务 18.1）：gen-hanzi-data.mjs 导出的每字 JSON
 * 必须携带与 strokes 一一对应的 strokeNames（笔顺名称），供详情页拆解格标注。
 * 缺失或长度不符 = 构建期缺陷，测试红灯拦截。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface HanziJson {
  strokes: string[]
  medians: number[][][]
  strokeNames?: string[]
}

const dataDir = fileURLToPath(new URL('.', import.meta.url))
const seedsPath = fileURLToPath(new URL('../../../backend/seeds/characters.json', import.meta.url))

/** 规范笔顺名称闭集（与 gen-hanzi-data.mjs 的 STANDARD_NAMES 同源约束）。 */
const STANDARD_NAMES = new Set([
  '横', '竖', '撇', '点', '捺', '提',
  '横折', '横撇', '横钩', '横折钩', '横折提', '横折弯', '横折弯钩',
  '横撇弯钩', '横折折撇', '横折折', '横折折折', '横折折折钩',
  '竖提', '竖折', '竖钩', '竖弯', '竖弯钩', '竖折撇', '竖折折', '竖折折钩',
  '撇折', '撇点', '斜钩', '卧钩', '弯钩',
])

function loadAll(): Map<string, HanziJson> {
  const byChar = new Map<string, HanziJson>()
  for (const f of readdirSync(dataDir)) {
    if (!/^u[0-9a-f]+\.json$/.test(f)) continue
    const char = String.fromCodePoint(parseInt(f.slice(1, -5), 16))
    byChar.set(char, JSON.parse(readFileSync(path.join(dataDir, f), 'utf-8')) as HanziJson)
  }
  return byChar
}

const all = loadAll()

describe('hanzi-data 数据完整性', () => {
  it('导出字数与 seed 字库一致（防生成脚本静默漏字）', () => {
    const seeds = JSON.parse(readFileSync(seedsPath, 'utf-8')) as { char: string }[]
    expect(all.size).toBe(seeds.length)
    for (const { char } of seeds) {
      expect(all.has(char), `seed 缺字：${char}`).toBe(true)
    }
  })

  it('每字 JSON 均携带与 strokes 等长且非空的 strokeNames', () => {
    expect(all.size).toBeGreaterThan(0)
    const broken: string[] = []
    for (const [char, data] of all) {
      const names = data.strokeNames
      if (
        !Array.isArray(names) ||
        names.length !== data.strokes.length ||
        !names.every((n) => typeof n === 'string' && n.length > 0)
      ) {
        broken.push(char)
      }
    }
    expect(broken).toEqual([])
  })

  it('全部名称落在规范笔顺名称闭集内', () => {
    const illegal: string[] = []
    for (const [char, data] of all) {
      for (const n of data.strokeNames ?? []) {
        if (!STANDARD_NAMES.has(n)) illegal.push(`${char}:${n}`)
      }
    }
    expect(illegal).toEqual([])
  })

  it('无歧义单笔字的名称正确（一=横，十=横+竖）', () => {
    expect(all.get('一')?.strokeNames).toEqual(['横'])
    expect(all.get('十')?.strokeNames).toEqual(['横', '竖'])
  })

  it('易错字名称符合规范（构建期几何仲裁/覆盖表结论）', () => {
    // 这=文(点横撇捺)+辶(点横折折撇捺)，cnchar 次序误标已按 median 几何修正。
    expect(all.get('这')?.strokeNames).toEqual(['点', '横', '撇', '捺', '点', '横折折撇', '捺'])
    // cnchar 缩减命名 → 规范命名：竖弯→竖折、横斜钩→横折弯钩、心底钩→卧钩。
    // 出的笔序与 hanzi-writer 几何一致（首笔=左上竖折，区别于山的"中竖先写"）。
    expect(all.get('出')?.strokeNames).toEqual(['竖折', '竖', '竖', '竖折', '竖'])
    expect(all.get('山')?.strokeNames).toEqual(['竖', '竖折', '竖'])
    expect(all.get('飞')?.strokeNames).toEqual(['横折弯钩', '撇', '点'])
    expect(all.get('母')?.strokeNames).toEqual(['竖折', '横折钩', '点', '横', '点'])
    expect(all.get('想')?.strokeNames?.slice(9)).toEqual(['点', '卧钩', '点', '点'])
    // 管道备选取首（水的第 2 笔是横撇）+ 点2 变体归一。
    expect(all.get('水')?.strokeNames).toEqual(['竖钩', '横撇', '撇', '捺'])
  })
})
