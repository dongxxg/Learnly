// 从 hanzi-writer-data（MIT）导出 seed 字库的笔顺数据到 src/hanzi-data/。
// 文件按 Unicode 码点命名（如 一 → u4e00.json），规避中文文件名在 git/URL/跨端打包的坑。
// 笔画名称（strokeNames）构建期由 cnchar-order（MIT，devDependency，不进运行时包）生成，
// 经归一化 + 规范命名对齐 + 覆盖表修正后内嵌（design D13）。
// 缺字/名称异常时输出清单并以非 0 退出（缺字由前端按 spec 降级隐藏入口）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import cnchar from 'cnchar'
import cncharOrder from 'cnchar-order'

cnchar.use(cncharOrder)

const frontendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const seedsPath = path.join(frontendRoot, '../backend/seeds/characters.json')
const pkgDir = path.join(frontendRoot, 'node_modules/hanzi-writer-data')
const outDir = path.join(frontendRoot, 'src/hanzi-data')

/** 规范笔顺名称闭集（《现代汉语通用字笔顺规范》），名称校验用。 */
const STANDARD_NAMES = new Set([
  '横', '竖', '撇', '点', '捺', '提',
  '横折', '横撇', '横钩', '横折钩', '横折提', '横折弯', '横折弯钩',
  '横撇弯钩', '横折折撇', '横折折', '横折折折', '横折折折钩',
  '竖提', '竖折', '竖钩', '竖弯', '竖弯钩', '竖折撇', '竖折折', '竖折折钩',
  '撇折', '撇点', '斜钩', '卧钩', '弯钩',
])

/** cnchar 用缩减命名，逐名映射回规范名称（2026-10-14 全量核对 270 字后确认）。 */
const NAME_FIX = {
  竖弯: '竖折', // 山/四/出/母 等均为折角 𠃊，cnchar 一律标"竖弯"
  横斜钩: '横折弯钩', // 九/气/风/飞/机 等均为 ㇈
}

/** 心底字末钩为卧钩（㇃）；cnchar 标"斜钩|卧钩"取首会错，戈/氐/戊类钩才是斜钩。 */
const HEART_BOTTOM_CHARS = new Set(['心', '忘', '怎', '总', '想', '意', '您', '念', '急', '怒', '感'])

/** 几何仲裁覆盖（hanzi-writer median 证据）：这=文(点横撇捺)+辶，cnchar 次序误标第 4 笔。 */
const STROKE_NAME_OVERRIDES = new Map([
  ['这', ['点', '横', '撇', '捺', '点', '横折折撇', '捺']],
])

const seeds = JSON.parse(readFileSync(seedsPath, 'utf-8'))
mkdirSync(outDir, { recursive: true })

// 清理旧导出（仅 u*.json），保证目录与 seed 一致。
for (const f of readdirSync(outDir)) {
  if (/^u[0-9a-f]+\.json$/.test(f)) unlinkSync(path.join(outDir, f))
}

const outName = (ch) => 'u' + ch.codePointAt(0).toString(16) + '.json'

/** cnchar 原始名称 → 规范名称：去变体数字后缀、管道备选取首。 */
function normalizeName(raw) {
  return raw.replace(/\d+$/, '').split('|')[0]
}

/** 单字笔顺名称：cnchar 生成 + 规范对齐（覆盖表优先，校验在调用方）。 */
function strokeNamesFor(ch, strokeCount) {
  if (STROKE_NAME_OVERRIDES.has(ch)) {
    return [...STROKE_NAME_OVERRIDES.get(ch)]
  }
  const raw = cnchar.stroke(ch, 'order', 'name')?.[0]
  if (!Array.isArray(raw)) return null
  const names = raw.map(normalizeName)
  if (HEART_BOTTOM_CHARS.has(ch)) {
    const hookIndex = names.findLastIndex((n) => n === '斜钩')
    if (hookIndex >= 0) names[hookIndex] = '卧钩'
  }
  if (ch === '喝') {
    // 曷底末笔教学规范为竖弯钩（几何 median 无二次折角，非竖折折钩）。
    names[names.length - 1] = '竖弯钩'
  }
  return names.map((n) => NAME_FIX[n] ?? n)
}

const missing = []
const nameErrors = []
let exported = 0
for (const item of seeds) {
  // 源包以汉字命名（一.json），导出统一为码点命名（u4e00.json）。
  const src = path.join(pkgDir, item.char + '.json')
  if (!existsSync(src)) {
    missing.push(item.char)
    continue
  }
  const data = JSON.parse(readFileSync(src, 'utf-8'))
  const names = strokeNamesFor(item.char, data.strokes.length)
  if (!names || names.length !== data.strokes.length) {
    nameErrors.push(`${item.char}(数量 ${names ? names.length : '无'}/${data.strokes.length})`)
    continue
  }
  const illegal = names.filter((n) => !STANDARD_NAMES.has(n))
  if (illegal.length > 0) {
    nameErrors.push(`${item.char}(非法名称 ${illegal.join('/')})`)
    continue
  }
  writeFileSync(
    path.join(outDir, outName(item.char)),
    JSON.stringify({ strokes: data.strokes, medians: data.medians, strokeNames: names }),
  )
  exported++
}

console.log(`笔顺数据导出：${exported}/${seeds.length}`)
if (missing.length > 0) {
  console.error(`缺字清单（${missing.length} 个）：${missing.join(' ')}`)
}
if (nameErrors.length > 0) {
  console.error(`笔顺名称异常（${nameErrors.length} 个）：${nameErrors.join(' ')}`)
}
if (missing.length > 0 || nameErrors.length > 0) {
  process.exit(1)
}
