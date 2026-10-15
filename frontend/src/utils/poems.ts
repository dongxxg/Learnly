/** 古诗模块纯逻辑工具（与组件解耦，同 utils/english.ts 模式）。静态数据，无后端依赖。 */
import { POEMS_LOWER } from './poems-data-lower'
import { POEMS_MIDDLE } from './poems-data-middle'
import { POEMS_UPPER } from './poems-data-upper'
import { POEM_PINYIN } from './poems-pinyin-data'
import type { Poem, PoemStage, RawPoem } from './poems-types'

export type { Poem, PoemStage, RawPoem } from './poems-types'

/** 学段页签（顺序即列表页签顺序）。 */
export const POEM_STAGES: readonly { key: PoemStage; label: string }[] = [
  { key: 'lower', label: '1-2年级' },
  { key: 'middle', label: '3-4年级' },
  { key: 'upper', label: '5-6年级' },
]

/** 文本数据合并构建期拼音；对齐由 poems.test.ts 兜底校验。 */
function withPinyin(raws: readonly RawPoem[]): readonly Poem[] {
  return raws.map((raw) => ({ ...raw, linesPinyin: POEM_PINYIN[raw.id] ?? [] }))
}

/** 学段 → 诗集合映射（数据文件按学段拆分，此处聚合只读）。 */
const STAGE_POEMS: Readonly<Record<PoemStage, readonly Poem[]>> = {
  lower: withPinyin(POEMS_LOWER),
  middle: withPinyin(POEMS_MIDDLE),
  upper: withPinyin(POEMS_UPPER),
}

/** 全部古诗（低段 → 中段 → 高段）。 */
export const POEMS: readonly Poem[] = [
  ...STAGE_POEMS.lower,
  ...STAGE_POEMS.middle,
  ...STAGE_POEMS.upper,
]

/** 收录总数（hub 卡片副标题展示用）。 */
export const POEM_COUNT: number = POEMS.length

/** 学段对应诗集合。 */
export function poemsByStage(stage: PoemStage): readonly Poem[] {
  return STAGE_POEMS[stage]
}

/** 学段收录数量（列表页签计数）。 */
export function poemCountByStage(stage: PoemStage): number {
  return STAGE_POEMS[stage].length
}

/**
 * 按 id 取诗；非法/未知 id 返回 null，详情页据此提示并返回。
 * 90 首线性查找足够快，无需建索引（KISS）。
 */
export function getPoemById(id: string): Poem | null {
  if (!id) {
    return null
  }
  return POEMS.find((poem) => poem.id === id) ?? null
}

/** 列表卡副标题："唐·李白"。 */
export function poemAuthorLine(poem: Poem): string {
  return `${poem.dynasty}·${poem.author}`
}

/** 详情页单字格：汉字挂拼音，标点不占音节（音节不足时缺省空串，不崩溃）。 */
export function poemLineCells(
  line: string,
  linePinyin: string,
): readonly { char: string; pinyin: string }[] {
  const syllables = linePinyin.split(' ').filter(Boolean)
  const cells: { char: string; pinyin: string }[] = []
  let next = 0
  for (const char of line) {
    if (/[一-鿿]/.test(char)) {
      cells.push({ char, pinyin: syllables[next] ?? '' })
      next += 1
    } else {
      cells.push({ char, pinyin: '' })
    }
  }
  return cells
}
