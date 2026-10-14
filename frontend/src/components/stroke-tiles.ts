/**
 * 笔顺拆解格纯逻辑（design D13）：数据整形 + path 解析，不含任何视图 API，
 * 供 stroke-strip 组件的三端渲染分支共用（H5/app SVG / mp canvas）。
 */
import type { HanziData } from '@/hanzi-data'

/** 每笔在拆解格中的角色色：已写黑 / 当前红（参考 笔顺.jpg）/ 未写浅灰幽灵。 */
export const TILE_COLORS = {
  past: '#1F2937',
  current: '#E5484D',
  future: '#E5E7EB',
} as const

export type StrokeTone = keyof typeof TILE_COLORS

export interface StrokeTilePath {
  d: string
  tone: StrokeTone
}

export interface StrokeTile {
  /** 1-based 笔序。 */
  num: number
  /** 标准笔顺名称（横/竖/撇/捺…）。 */
  name: string
  paths: StrokeTilePath[]
}

/**
 * 生成逐笔拆解格。strokeNames 缺失或与笔画数不符 → 返回空数组，
 * 调用方按 spec 隐藏整个拆解区（不渲染半残数据）。
 */
export function buildStrokeTiles(data: HanziData): StrokeTile[] {
  const strokeNames = data.strokeNames
  const total = data.strokes.length
  if (total === 0 || !strokeNames || strokeNames.length !== total) return []
  if (!strokeNames.every((n) => typeof n === 'string' && n.length > 0)) return []

  return data.strokes.map((_, i) => ({
    num: i + 1,
    name: strokeNames[i],
    paths: data.strokes.map((d, j) => ({
      d,
      tone: (j < i ? 'past' : j === i ? 'current' : 'future') as StrokeTone,
    })),
  }))
}

export interface PathCommand {
  cmd: 'M' | 'L' | 'Q' | 'C' | 'Z'
  params: number[]
}

const PARAM_COUNT: Record<PathCommand['cmd'], number> = { M: 2, L: 2, Q: 4, C: 6, Z: 0 }
const TOKEN_RE = /([A-Za-z])([^A-Za-z]*)/g
const NUM_RE = /^-?\d+(?:\.\d+)?$/

/**
 * 解析 hanzi-writer-data 的笔画 path（绝对指令 M/L/Q/C/Z，空格分隔）。
 * 数据异常（未知指令/小写相对指令/参数个数不符）直接抛错——早暴露，不允许静默画错。
 */
export function parsePath(d: string): PathCommand[] {
  const commands: PathCommand[] = []
  TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(d)) !== null) {
    const cmd = match[1] as PathCommand['cmd']
    const expected = PARAM_COUNT[cmd]
    if (expected === undefined) {
      throw new Error(`[stroke-tiles] 不支持的 path 指令：${match[1]}`)
    }
    const params = match[2].trim().split(/[\s,]+/).filter(Boolean)
    if (params.length !== expected || !params.every((p) => NUM_RE.test(p))) {
      throw new Error(`[stroke-tiles] 指令 ${cmd} 参数异常：${match[2].trim()}`)
    }
    commands.push({ cmd, params: params.map(Number) })
  }
  return commands
}
