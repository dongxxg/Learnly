/**
 * 英文字母笔顺数据入口。src/hanzi-letter-data/lc-*.json 由
 * scripts/gen-letter-data.mjs 构建期生成（52 字形，A–Z 大小写），
 * 与 hanzi-data 的 HanziData 同构，可零改动喂给 hanzi-writer 引擎。
 */
import type { HanziData } from '@/hanzi-data'

export type { HanziData }

const modules = import.meta.glob<HanziData>('./lc-*.json', { eager: true })

const dataByChar = new Map<string, HanziData>()
for (const [file, data] of Object.entries(modules)) {
  // 文件名形如 ./lc-41.json → 码点 0x41（'A'）。
  const codePoint = Number.parseInt(file.slice(5, -5), 16)
  dataByChar.set(String.fromCodePoint(codePoint), data)
}

/** 取某字形（'A' | 'a' | …）的笔顺数据；无数据返回 null（调用方按 spec 降级）。 */
export function getLetterData(char: string): HanziData | null {
  return dataByChar.get(char) ?? null
}

/** 是否内置了某字形的笔顺数据。 */
export function hasLetterData(char: string): boolean {
  return dataByChar.has(char)
}

/** 全部内置字形（52 个：A–Z 大小写），测试与工具用。 */
export const LETTER_GLYPHS: string[] = [...dataByChar.keys()].sort()
