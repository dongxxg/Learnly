/**
 * 笔顺数据入口。src/hanzi-data/u*.json 由 scripts/gen-hanzi-data.mjs
 * 从 hanzi-writer-data（MIT）构建期导出，import.meta.glob 全量打包进 bundle。
 */

export interface HanziData {
  /** 每笔的 SVG path（含弧线控制点）。 */
  strokes: string[]
  /** 每笔中线点序列，用于动画与判定。 */
  medians: number[][][]
}

const modules = import.meta.glob<HanziData>('./u*.json', { eager: true })

const dataByChar = new Map<string, HanziData>()
for (const [file, data] of Object.entries(modules)) {
  // 文件名形如 ./u4e00.json → 码点 0x4e00。
  const codePoint = Number.parseInt(file.slice(3, -5), 16)
  dataByChar.set(String.fromCodePoint(codePoint), data)
}

/** 取某字的笔顺数据；无数据返回 null（调用方按 spec 降级隐藏书写入口）。 */
export function getHanziData(char: string): HanziData | null {
  return dataByChar.get(char) ?? null
}

/** 是否内置了某字的笔顺数据。 */
export function hasHanziData(char: string): boolean {
  return dataByChar.has(char)
}
