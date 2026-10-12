#!/usr/bin/env node
/**
 * 英文字母笔顺数据生成器（design D1）。
 *
 * 52 字形（A–Z 大小写）人工定义教学笔顺 median 骨架 → 定宽圆头 offsetting
 * 生成闭合 outline path → 输出与 HanziData 同构 JSON（src/hanzi-letter-data/lc-<码点>.json），
 * 供 hanzi-writer 引擎（渲染 / 动画 / quiz 判定）零改动复用。
 *
 * 数据空间与 hanzi-writer-data 同构（Positioner CHARACTER_BOUNDS 固定框）：
 * - x ∈ [0, 1024]，y 轴向上 ∈ [-124, 900]（总高 1024，render 时 scale(1,-1) 翻转）。
 * - 四线三格（三带等高 ≈319）：TOP 顶线 / XLINE 中上线 / BASE 基线 / BOTTOM 底线。
 * - path 仅用 M/L/Z（空格分隔数值）——hanzi-writer 的 canvas 路径解析器只支持该子集。
 *
 * 用法：node scripts/gen-letter-data.mjs [--preview <输出目录>]
 *   --preview 额外输出 SVG 目测稿（每格：四线格 + 轮廓 + 红色 median 走向 + 绿色起笔点）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argv, exit } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'src', 'hanzi-letter-data')

// ---- 数据空间常量 ----
const TOP = 866 // 顶线（大写/升部顶）
const XLINE = 547 // 中上线（小写 x 高度线）
const BASE = 229 // 基线（中下线）
const BOTTOM = -90 // 底线（降部底）
const BOUNDS = { x: [0, 1024], y: [-124, 900] }
const STROKE_W = 66 // 主笔画定宽（半宽 33，两端圆头）
const CAP_SEGMENTS = 8 // 圆头采样段数

// ---- 几何工具 ----

/** 点。 */
const P = (x, y) => [x, y]

/** 拼接点序列（点 / 数组混排），去掉相邻重复点。 */
function S(...parts) {
  const out = []
  for (const part of parts) {
    for (const pt of Array.isArray(part[0]) ? part : [part]) {
      const last = out[out.length - 1]
      if (!last || last[0] !== pt[0] || last[1] !== pt[1]) out.push(pt)
    }
  }
  return out
}

/** 椭圆弧采样（角度制，y 轴向上，a0→a1 可跨越 ±360）。 */
function arc(cx, cy, rx, ry, a0, a1) {
  const sweep = a1 - a0
  const segs = Math.max(8, Math.ceil(Math.abs(sweep) / 12))
  const pts = []
  for (let i = 0; i <= segs; i++) {
    const a = (a0 + (sweep * i) / segs) * (Math.PI / 180)
    pts.push(P(cx + rx * Math.cos(a), cy + ry * Math.sin(a)))
  }
  return pts
}

/** 折线总长。 */
function polylineLength(pts) {
  let len = 0
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  }
  return len
}

const round1 = (v) => Math.round(v * 10) / 10

/**
 * 折线 → 定宽圆头闭合轮廓点环（miter 斜接 + 两端半圆头）。
 * 点笔（长度 < 1）退化为圆点轮廓。
 */
function offsetOutline(pts, w) {
  const r = w / 2
  if (polylineLength(pts) < 1) {
    const [cx, cy] = pts[0]
    return arc(cx, cy, r, r, 0, 360)
  }

  const dirs = []
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0]
    const dy = pts[i][1] - pts[i - 1][1]
    const len = Math.hypot(dx, dy)
    dirs.push([dx / len, dy / len])
  }
  // 顶点斜接偏移：左右法向取相邻段平均并归一，miter 比例限幅防尖端。
  const sideOffsets = (sign) => {
    const side = []
    for (let i = 0; i < pts.length; i++) {
      const n0 = dirs[i - 1] ?? dirs[0]
      const n1 = dirs[i] ?? dirs[dirs.length - 1]
      let nx = sign * (-n0[1] + -n1[1]) / 2
      let ny = sign * (n0[0] + n1[0]) / 2
      const nlen = Math.hypot(nx, ny) || 1
      nx /= nlen
      ny /= nlen
      const ref = sign * (-n1[1] * nx + n1[0] * ny) // 投影到当前段法向
      const miter = Math.min(2.2, 1 / Math.max(0.45, Math.abs(ref)))
      side.push([pts[i][0] + nx * r * miter, pts[i][1] + ny * r * miter])
    }
    return side
  }
  const left = sideOffsets(1)
  const right = sideOffsets(-1)

  // 圆头：右法向绕行半圆到左法向（顺时针，经过折线背向）。
  const cap = (center, rn) => {
    const pts2 = []
    for (let i = 1; i < CAP_SEGMENTS; i++) {
      const t = (i / CAP_SEGMENTS) * Math.PI
      pts2.push([
        center[0] + r * (rn[0] * Math.cos(t) + rn[1] * Math.sin(t)),
        center[1] + r * (-rn[0] * Math.sin(t) + rn[1] * Math.cos(t)),
      ])
    }
    return pts2
  }

  const d0 = dirs[0]
  const dn = dirs[dirs.length - 1]
  return [
    ...cap(pts[0], [d0[1], -d0[0]]), // 起点圆头
    ...left,
    ...cap(pts[pts.length - 1], [-dn[1], dn[0]]), // 终点圆头
    ...[...right].reverse(),
  ]
}

/** 轮廓点环 → 闭合 path（仅 M/L/Z，数值空格分隔）。 */
function outlinePath(ring) {
  const cmds = ring.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${round1(pt[0])} ${round1(pt[1])}`)
  const first = ring[0]
  cmds.push(`L ${round1(first[0])} ${round1(first[1])}`)
  return cmds.join(' ') + ' Z'
}

// ---- 字形骨架 ----
// 教学笔顺（Zaner-Bloser 风格，对齐国内小学字母书写规范）：每笔一个 median 点序列，
// 点序即书写方向（quiz 判定依赖）。

const C = 512
const CAP_H = TOP - BASE
const MID_BAR_Y = BASE + Math.round(CAP_H * 0.44) // E/F/H/K 横杠高度

const UPPER = {
  A: [S(P(C, TOP), P(C - 260, BASE)), S(P(C, TOP), P(C + 260, BASE)), S(P(C - 70, 430), P(C + 70, 430))],
  B: [
    S(P(C - 225, TOP), P(C - 225, BASE)),
    S(P(C - 225, TOP), P(C + 70, TOP), arc(C + 70, 706.5, 155, 159.5, 90, -90), P(C - 225, XLINE)),
    S(P(C - 225, XLINE), P(C + 90, XLINE), arc(C + 90, 388, 165, 159, 90, -90), P(C - 225, BASE)),
  ],
  C: [arc(C, 547.5, 250, 318.5, 55, 305)],
  D: [
    S(P(C - 245, TOP), P(C - 245, BASE)),
    S(P(C - 245, TOP), P(C + 60, TOP), arc(C + 60, 547.5, 185, 318.5, 90, -90), P(C - 245, BASE)),
  ],
  E: [
    S(P(C - 220, TOP), P(C - 220, BASE)),
    S(P(C - 220, TOP), P(C + 220, TOP)),
    S(P(C - 220, MID_BAR_Y), P(C + 188, MID_BAR_Y)),
    S(P(C - 220, BASE), P(C + 200, BASE)),
  ],
  F: [
    S(P(C - 215, TOP), P(C - 215, BASE)),
    S(P(C - 215, TOP), P(C + 215, TOP)),
    S(P(C - 215, MID_BAR_Y), P(C + 183, MID_BAR_Y)),
  ],
  G: [arc(C, 547.5, 250, 318.5, 55, 344), S(P(C + 240, 460), P(C + 80, 460))],
  H: [
    S(P(C - 235, TOP), P(C - 235, BASE)),
    S(P(C + 235, TOP), P(C + 235, BASE)),
    S(P(C - 235, MID_BAR_Y), P(C + 235, MID_BAR_Y)),
  ],
  I: [S(P(C - 220, TOP), P(C + 220, TOP)), S(P(C, TOP), P(C, BASE)), S(P(C - 220, BASE), P(C + 220, BASE))],
  J: [
    S(P(C - 180, TOP), P(C + 180, TOP)),
    S(P(C + 90, TOP), P(C + 90, -20), arc(C + 30, -20, 60, 70, 0, -150)),
  ],
  K: [
    S(P(C - 235, TOP), P(C - 235, BASE)),
    S(P(C + 205, TOP), P(C - 225, 455)),
    S(P(C - 185, 455), P(C + 225, BASE)),
  ],
  L: [S(P(C - 200, TOP), P(C - 200, BASE), P(C + 200, BASE))],
  M: [
    S(P(C - 300, TOP), P(C - 300, BASE)),
    S(P(C - 300, TOP), P(C, BASE)),
    S(P(C, BASE), P(C + 300, TOP)),
    S(P(C + 300, TOP), P(C + 300, BASE)),
  ],
  N: [
    S(P(C - 290, TOP), P(C - 290, BASE)),
    S(P(C - 290, BASE), P(C + 290, TOP)),
    S(P(C + 290, TOP), P(C + 290, BASE)),
  ],
  O: [arc(C, 547.5, 265, 318.5, 80, 428)],
  P: [
    S(P(C - 235, TOP), P(C - 235, BASE)),
    S(P(C - 235, TOP), P(C + 60, TOP), arc(C + 60, 706.5, 155, 159.5, 90, -90), P(C - 235, XLINE)),
  ],
  Q: [arc(C, 547.5, 265, 318.5, 80, 428), S(P(C + 40, 330), P(C + 330, 50))],
  R: [
    S(P(C - 235, TOP), P(C - 235, BASE)),
    S(P(C - 235, TOP), P(C + 60, TOP), arc(C + 60, 706.5, 155, 159.5, 90, -90), P(C - 235, XLINE)),
    S(P(C - 235, XLINE), P(C + 240, BASE)),
  ],
  S: [arc(C, 706.75, 185, 159.25, 55, 270), arc(C, 388.25, 185, 159.25, 90, -115)],
  T: [S(P(C - 235, TOP), P(C + 235, TOP)), S(P(C, TOP), P(C, BASE))],
  U: [S(P(C - 245, TOP), P(C - 245, 480), arc(C, 480, 245, 251, 180, 360), P(C + 245, 480), P(C + 245, TOP))],
  V: [S(P(C - 260, TOP), P(C, BASE)), S(P(C, BASE), P(C + 260, TOP))],
  W: [S(P(C - 330, TOP), P(C - 165, BASE), P(C, TOP), P(C + 165, BASE), P(C + 330, TOP))],
  X: [S(P(C - 260, TOP), P(C + 260, BASE)), S(P(C + 260, TOP), P(C - 260, BASE))],
  Y: [S(P(C - 260, TOP), P(C, 500)), S(P(C + 260, TOP), P(C, 500), P(C, BASE))],
  Z: [S(P(C - 240, TOP), P(C + 240, TOP), P(C - 240, BASE), P(C + 240, BASE))],
}

const LOWER = {
  a: [arc(C - 45, 388, 170, 159, 75, 435), S(P(C + 125, XLINE), P(C + 125, BASE))],
  b: [
    S(P(C - 195, TOP), P(C - 195, BASE)),
    arc(C - 35, 388, 160, 159, 180, 420),
  ],
  c: [arc(C, 388, 185, 159, 60, 300)],
  d: [arc(C - 45, 388, 170, 159, 75, 435), S(P(C + 125, TOP), P(C + 125, BASE))],
  e: [S(P(C - 185, 440), P(C + 149, 440), arc(C, 400, 155, 147, 16, 316))],
  f: [
    { pts: S(arc(C + 25, 800, 55, 66, 180, 90), P(C + 25, BASE)), w: 60 },
    S(P(C - 105, 470), P(C + 155, 470)),
  ],
  g: [
    arc(C - 45, 388, 170, 159, 75, 435),
    S(P(C + 125, XLINE), P(C + 125, -30), arc(C + 65, -30, 60, 60, 0, -150)),
  ],
  h: [
    S(P(C - 195, TOP), P(C - 195, BASE)),
    S(arc(C - 55, 470, 140, 77, 180, 0), P(C + 85, BASE)),
  ],
  i: [S(P(C, XLINE), P(C, BASE)), { pts: S(P(C, 646), P(C, 650)), w: 44 }],
  j: [
    S(P(C + 30, XLINE), P(C + 30, -30), arc(C - 30, -30, 60, 60, 0, -150)),
    { pts: S(P(C + 30, 646), P(C + 30, 650)), w: 44 },
  ],
  k: [
    S(P(C - 210, TOP), P(C - 210, BASE)),
    S(P(C + 155, XLINE), P(C - 205, 430)),
    S(P(C - 155, 430), P(C + 165, BASE)),
  ],
  l: [S(P(C, TOP), P(C, BASE))],
  m: [
    S(P(C - 290, XLINE), P(C - 290, BASE)),
    S(arc(C - 150, 470, 140, 77, 180, 0), P(C - 10, BASE)),
    S(arc(C + 130, 470, 140, 77, 180, 0), P(C + 270, BASE)),
  ],
  n: [S(P(C - 210, XLINE), P(C - 210, BASE)), S(arc(C - 70, 470, 140, 77, 180, 0), P(C + 70, BASE))],
  o: [arc(C, 388, 200, 159, 80, 428)],
  p: [S(P(C - 195, XLINE), P(C - 195, BOTTOM)), arc(C - 35, 388, 160, 159, 180, 420)],
  q: [arc(C - 45, 388, 170, 159, 75, 435), S(P(C + 125, XLINE), P(C + 125, BOTTOM))],
  r: [S(P(C - 150, XLINE), P(C - 150, BASE)), S(arc(C - 60, 470, 90, 77, 180, 90), P(C + 10, 545))],
  s: [arc(C, 467.5, 135, 79.5, 55, 270), arc(C, 308.5, 135, 79.5, 90, -115)],
  t: [S(P(C - 30, 790), P(C - 30, BASE)), S(P(C - 160, 470), P(C + 160, 470))],
  u: [
    S(P(C - 200, XLINE), P(C - 200, 480), arc(C - 65, 480, 135, 251, 180, 360), P(C + 70, 480), P(C + 70, 515)),
    S(P(C + 70, XLINE), P(C + 70, BASE)),
  ],
  v: [S(P(C - 190, XLINE), P(C, BASE)), S(P(C, BASE), P(C + 190, XLINE))],
  w: [S(P(C - 280, XLINE), P(C - 140, BASE), P(C, XLINE), P(C + 140, BASE), P(C + 280, XLINE))],
  x: [S(P(C - 190, XLINE), P(C + 190, BASE)), S(P(C + 190, XLINE), P(C - 190, BASE))],
  y: [S(P(C - 190, XLINE), P(C + 10, 420)), S(P(C + 190, XLINE), P(C + 10, 420), P(C - 70, BOTTOM))],
  z: [S(P(C - 175, XLINE), P(C + 175, XLINE), P(C - 175, BASE), P(C + 175, BASE))],
}

// ---- 构建 / 校验 / 输出 ----

const LETTER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').flatMap((u) => [u, u.toLowerCase()])
const SKELETONS = { ...UPPER, ...LOWER }

function buildData() {
  const out = new Map()
  for (const [char, strokes] of Object.entries(SKELETONS)) {
    const strokeEntries = strokes.map((s) => (Array.isArray(s[0]) && typeof s[0][0] === 'number' ? { pts: s } : s))
    const paths = []
    const medians = []
    for (const { pts, w = STROKE_W } of strokeEntries) {
      paths.push(outlinePath(offsetOutline(pts, w)))
      medians.push(pts.map(([x, y]) => [round1(x), round1(y)]))
    }
    out.set(char, { strokes: paths, medians })
  }
  return out
}

/** 内置校验：52 字形齐全、strokes/medians 一致、path 可解析、median 在数据边界内。 */
function validate(data) {
  const problems = []
  if (data.size !== 52) problems.push(`字形数量 ${data.size} ≠ 52`)
  const num = String.raw`-?\d+(\.\d+)?`
  const pathRe = new RegExp(`^M ${num} ${num}( L ${num} ${num})* Z$`)
  for (const [char, { strokes, medians }] of data) {
    const tag = (msg) => `[${char}] ${msg}`
    if (!strokes.length) problems.push(tag('无笔画'))
    if (strokes.length !== medians.length) problems.push(tag(`strokes(${strokes.length})/medians(${medians.length}) 数量不一致`))
    strokes.forEach((path) => {
      if (!pathRe.test(path)) problems.push(tag(`path 格式非法: ${path.slice(0, 40)}…`))
    })
    medians.forEach((median, i) => {
      if (median.length < 2) problems.push(tag(`第 ${i + 1} 笔 median 点数 < 2`))
      for (const [x, y] of median) {
        if (x < BOUNDS.x[0] || x > BOUNDS.x[1] || y < BOUNDS.y[0] || y > BOUNDS.y[1]) {
          problems.push(tag(`第 ${i + 1} 笔 median 越界: (${x}, ${y})`))
        }
      }
    })
  }
  return problems
}

/** 目测稿：四线格 + 轮廓 + median 走向（红）+ 起笔点（绿）。 */
function glyphSvg(char, { strokes, medians }) {
  const sx = (x) => round1(10 + (x / 1024) * 220)
  const sy = (y) => round1(10 + ((900 - y) / 1024) * 220)
  const grid = [TOP, XLINE, BASE, BOTTOM]
    .map((y) => `<line x1="10" y1="${sy(y)}" x2="230" y2="${sy(y)}" stroke="#c9d2dd" stroke-width="1"/>`)
    .join('')
  // 数据空间 (x,y) → 格内：translate(10, 10+900k) scale(k,-k)，k=220/1024
  const k = round1((220 / 1024) * 10000) / 10000
  const fills = strokes.map(
    (d) => `<path d="${d}" fill="#333a45" fill-rule="nonzero" transform="translate(10,${round1(10 + 900 * k)}) scale(${k},${-k})"/>`,
  )
  const guides = medians
    .map(
      (m) =>
        `<polyline points="${m.map(([x, y]) => `${sx(x)},${sy(y)}`).join(' ')}" fill="none" stroke="#e2554d" stroke-width="1.4" stroke-dasharray="4 3"/>` +
        `<circle cx="${sx(m[0][0])}" cy="${sy(m[0][1])}" r="3" fill="#2fa25b"/>`,
    )
    .join('')
  return `<g>${grid}${fills.join('')}${guides}</g>`
}

function previewSvg(data, chars, title) {
  const cols = 6
  const cell = 240
  const rows = Math.ceil(chars.length / cols)
  const cells = chars
    .map((ch, i) => {
      const x = (i % cols) * cell
      const y = Math.floor(i / cols) * cell
      return `<g transform="translate(${x},${y})">${glyphSvg(ch, data.get(ch))}<text x="118" y="234" font-size="14" fill="#889" text-anchor="middle">${ch}</text></g>`
    })
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell + 30}" font-family="sans-serif">
<rect width="100%" height="100%" fill="#fff"/>
<text x="12" y="24" font-size="18" fill="#333a45">${title}</text>
<g transform="translate(0,30)">${cells}</g>
</svg>`
}

function main() {
  const data = buildData()
  const problems = validate(data)
  if (problems.length) {
    console.error(`校验失败 ${problems.length} 项：\n` + problems.map((p) => `  - ${p}`).join('\n'))
    exit(1)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  for (const [char, jsonData] of data) {
    const cp = char.codePointAt(0).toString(16)
    writeFileSync(join(OUT_DIR, `lc-${cp}.json`), JSON.stringify(jsonData))
  }
  console.log(`字母笔顺数据生成完成：${data.size}/52 → ${OUT_DIR}`)

  const previewIdx = argv.indexOf('--preview')
  if (previewIdx > -1) {
    const dir = argv[previewIdx + 1]
    mkdirSync(dir, { recursive: true })
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const lower = upper.map((u) => u.toLowerCase())
    writeFileSync(join(dir, 'letter-preview-upper.svg'), previewSvg(data, upper, '大写 A–Z（红线=median 走向，绿点=起笔）'))
    writeFileSync(join(dir, 'letter-preview-lower.svg'), previewSvg(data, lower, '小写 a–z（红线=median 走向，绿点=起笔）'))
    console.log(`目测稿输出 → ${dir}`)
  }
}

main()
