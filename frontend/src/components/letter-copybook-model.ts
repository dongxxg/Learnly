/**
 * 字帖模型纯逻辑（img.png 字帖样式）：大小写并排共享四线格，每笔带
 * 行笔方向箭头 + 起笔序号。几何全部在屏幕坐标系内算好，SVG/canvas
 * 渲染分支只做绘制，不含布局计算。
 *
 * 坐标约定（与 hanzi-writer-board .grid-fourline 注释同源）：
 * - 数据空间：固定框 1024 见方，y 向下，四线 y ∈ {866(顶), 547(中), 229(基), -90(底)}。
 * - 屏幕空间：y 翻转 y_s = PAD_TOP + (900 - y_data)，PAD_TOP 为顶部序号带
 *   （img.png 的序号画在四线格上方带内）；幅面高 = PAD_TOP + 1024。
 * - 每个字形占 1024 宽的半格，offsetX = 序号 × 1024（并排共享同一组四线）。
 */
import { parsePath } from './stroke-tiles'

export interface LetterGlyphData {
  strokes: string[]
  medians?: number[][][]
}

export interface CopybookPoint {
  x: number
  y: number
}

/** 箭头三角：tip 在 median 末端，left/right 为尾翼。 */
export interface CopybookArrow {
  tip: CopybookPoint
  left: CopybookPoint
  right: CopybookPoint
}

export interface CopybookMark {
  /** 1-based 笔序。 */
  num: number
  /** median 折线（屏幕坐标），箭杆。 */
  points: CopybookPoint[]
  /** median 少于 2 点（方向未知）时为 null。 */
  arrow: CopybookArrow | null
  /** 序号文字锚点（屏幕坐标）。 */
  label: CopybookPoint
}

export interface CopybookGlyph {
  /** 字形填充路径（原始 d，渲染方自带翻转/平移变换）。 */
  paths: string[]
  marks: CopybookMark[]
}

/** 字帖幅面常量（渲染分支与测试共用，改值需同步 .copybook 渐变百分比）。 */
export const COPYBOOK = {
  /** 单字形幅面边长（数据空间）。 */
  FRAME: 1024,
  /** 顶部序号带高（数据空间）。 */
  PAD_TOP: 100,
  /** 幅面总高 = PAD_TOP + FRAME。 */
  HEIGHT: 1124,
  /** 四线格线位（数据空间 y，自上而下）。 */
  LINES: { top: 866, middle: 547, base: 229, bottom: -90 },
} as const

/** 箭杆回退长度/箭头翼长/序号回退距离（数据空间单位）。 */
const ARROW_LEN = 34
const ARROW_HALF_W = 15
const LABEL_BACK = 52
/** 序号字号（数据空间单位，屏幕按 k 缩放）。 */
const LABEL_FONT = 56
/** 同起笔多笔的序号横向错开间距。 */
const LABEL_SPREAD = 76
/** 序号锚点间距小于该值视为同组。 */
const LABEL_GROUP_DIST = 90

function toScreen(p: [number, number], offsetX: number): CopybookPoint {
  return { x: p[0] + offsetX, y: COPYBOOK.PAD_TOP + (900 - p[1]) }
}

function arrowFor(points: CopybookPoint[]): CopybookArrow | null {
  if (points.length < 2) return null
  const tip = points[points.length - 1]
  const prev = points[points.length - 2]
  const dx = tip.x - prev.x
  const dy = tip.y - prev.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return null
  const ux = dx / len
  const uy = dy / len
  // 尾翼中心在尖端后方，两翼垂直行笔方向展开。
  const bx = tip.x - ux * ARROW_LEN
  const by = tip.y - uy * ARROW_LEN
  return {
    tip,
    left: { x: bx + uy * ARROW_HALF_W, y: by - ux * ARROW_HALF_W },
    right: { x: bx - uy * ARROW_HALF_W, y: by + ux * ARROW_HALF_W },
  }
}

/**
 * 构建单字形字帖数据；无笔画返回 null（调用方隐藏）。
 * median 缺笔时该笔无序号标注（不猜位置），字形照常绘制。
 */
export function buildCopybookGlyph(data: LetterGlyphData | null, offsetX = 0): CopybookGlyph | null {
  if (!data || data.strokes.length === 0) return null

  const marks: CopybookMark[] = []
  data.strokes.forEach((_, i) => {
    const median = data.medians?.[i]
    if (!median || median.length === 0) return
    const points = median.map((p) => toScreen(p as [number, number], offsetX))

    // 序号锚点：起笔点沿行笔反方向外推（竖笔的序号落在起笔点上方）。
    let dir = { x: 0, y: -1 }
    if (points.length >= 2) {
      const dx = points[1].x - points[0].x
      const dy = points[1].y - points[0].y
      const len = Math.hypot(dx, dy)
      if (len > 0) dir = { x: dx / len, y: dy / len }
    }
    marks.push({
      num: i + 1,
      points,
      arrow: arrowFor(points),
      label: { x: points[0].x - dir.x * LABEL_BACK, y: points[0].y - dir.y * LABEL_BACK },
    })
  })

  spreadCollidingLabels(marks)
  clampLabels(marks, offsetX)

  return { paths: [...data.strokes], marks }
}

/** 同起笔多笔（如 A 的 1/2）：按行笔方向角排序后沿各自法向错开，避免序号重叠。 */
function spreadCollidingLabels(marks: CopybookMark[]): void {
  let groupStart = 0
  while (groupStart < marks.length) {
    let groupEnd = groupStart + 1
    while (
      groupEnd < marks.length &&
      Math.hypot(
        marks[groupEnd].label.x - marks[groupEnd - 1].label.x,
        marks[groupEnd].label.y - marks[groupEnd - 1].label.y,
      ) < LABEL_GROUP_DIST
    ) {
      groupEnd += 1
    }
    const group = marks.slice(groupStart, groupEnd)
    if (group.length > 1) {
      const ordered = [...group].sort(
        (a, b) => labelAngle(a) - labelAngle(b),
      )
      ordered.forEach((mark, idx) => {
        const shift = (idx - (ordered.length - 1) / 2) * LABEL_SPREAD
        // 法向取行笔方向的右侧，保证有序错开不回叠。
        const p0 = mark.points[0]
        const p1 = mark.points[Math.min(1, mark.points.length - 1)]
        const dx = p1.x - p0.x
        const dy = p1.y - p0.y
        const len = Math.hypot(dx, dy) || 1
        mark.label.x += (dy / len) * shift
        mark.label.y += (-dx / len) * shift
      })
    }
    groupStart = groupEnd
  }
}

/** 序号行笔方向角（用于同组排序，方向相近的贴在一起）。 */
function labelAngle(mark: CopybookMark): number {
  const p0 = mark.points[0]
  const p1 = mark.points[Math.min(1, mark.points.length - 1)]
  return Math.atan2(p1.y - p0.y, p1.x - p0.x)
}

/** 序号钳回幅面内（顶部带内贴边、左右不越半格）。 */
function clampLabels(marks: CopybookMark[], offsetX: number): void {
  const margin = LABEL_FONT / 2
  const left = offsetX + margin
  const right = offsetX + COPYBOOK.FRAME - margin
  for (const mark of marks) {
    mark.label.x = Math.min(right, Math.max(left, mark.label.x))
    mark.label.y = Math.min(COPYBOOK.HEIGHT - margin, Math.max(margin, mark.label.y))
  }
}

/** 序号字号（渲染分支取用，保持同一字号来源）。 */
export const COPYBOOK_LABEL_FONT = LABEL_FONT

/** 供测试与渲染复用的 path 解析（M/L/Q/C/Z，含翻转错误的早暴露）。 */
export { parsePath }
