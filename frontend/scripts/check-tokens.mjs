// 令牌引用扫描器（ui-polish / design-tokens「令牌唯一权威」）
// 检出 .vue 样式中的三类硬编码：hex 色值 / 越阶字号 / 字面量阴影（含 rgba 字面量背景）。
// 白名单：教学组件 3 文件——田字格/四线三格渐变线位+线色是与 hanzi-writer 数据空间同源的
// 数学契约（见 ui-polish design.md D8），色值随几何冻结，整体豁免但单列计数防滥用。
// 行级豁免：行内注释 token-scan:ignore（同样单列计数）。
// CLI：node scripts/check-tokens.mjs [--strict]；默认报告模式退出 0，--strict 有违规时退出 1。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FONT_SCALE = [20, 24, 28, 32, 36, 44, 64, 88]
const FONT_SCALE_SET = new Set(FONT_SCALE)
const IGNORE_MARK = 'token-scan:ignore'

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const toPosix = (p) => p.split(path.sep).join('/')
const WHITELIST_FILES = new Set([
  // 令牌定义文件：App.vue 的 <style> 承载与 uni.scss 同值的 CSS 变量（运行时事实源，字面量是本职）。
  // 教学组件（hanzi-writer-board/letter-copybook/stroke-strip）不豁免：渐变线位百分比属几何契约
  // 冻结不动，线色/边框/底色已令牌化（ui-polish design D8），回归全程守护。
  'App.vue',
])

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/
const RGBA_LITERAL_RE = /rgba?\(\s*\d/

/**
 * 扫描一段样式内容（.vue 的 <style> 块或行内样式值）。
 * @returns {Array<{line: number, rule: string, snippet: string}>}
 */
export function scanStyleContent(content, { isWhitelisted = false } = {}) {
  if (isWhitelisted) return []
  const violations = []
  content.split(/\r?\n/).forEach((rawLine, i) => {
    if (rawLine.includes(IGNORE_MARK)) return
    const line = rawLine.replace(/\/\*[^*]*\*\//g, '') // 剥块注释（锚点/说明里的 # 不算色值）
    const push = (rule) => violations.push({ line: i + 1, rule, snippet: line.trim().slice(0, 90) })

    const shadowValue = line.match(/box-shadow\s*:\s*([^;]+)/)?.[1] ?? ''
    const withoutShadow = line.replace(/box-shadow\s*:\s*[^;]+/g, '')

    if (HEX_RE.test(line)) push('hardcoded-hex')
    else if (RGBA_LITERAL_RE.test(withoutShadow)) push('hardcoded-rgba')

    const fontSize = line.match(/font-size\s*:\s*(\d+)rpx/)
    if (fontSize && !FONT_SCALE_SET.has(Number(fontSize[1]))) push('off-scale-font')

    if (/box-shadow\s*:/.test(line) && /rgba?\(\s*\d|#[0-9a-fA-F]{3,8}\b/.test(shadowValue)) {
      push('literal-shadow')
    }
  })
  return violations
}

/** 扫描模板区行内 style 属性中的 hex 色值 */
export function scanTemplateAttrs(templateHtml) {
  const violations = []
  templateHtml.split(/\r?\n/).forEach((rawLine, i) => {
    if (rawLine.includes(IGNORE_MARK)) return
    const line = rawLine.replace(/\/\*[^*]*\*\//g, '')
    const styleValues = [...line.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join('; ')
    if (HEX_RE.test(styleValues)) {
      violations.push({ line: i + 1, rule: 'hardcoded-hex', snippet: line.trim().slice(0, 90) })
    }
  })
  return violations
}

function listVueFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    try {
      if (statSync(full).isDirectory()) out.push(...listVueFiles(full))
      else if (name.endsWith('.vue')) out.push(full)
    } catch {
      /* 跳过无权限/竞态删除 */
    }
  }
  return out
}

export function scanSrc(srcDir = SRC_DIR) {
  const report = []
  for (const file of listVueFiles(srcDir)) {
    const rel = toPosix(file).split(`${toPosix(srcDir)}/`)[1]
    const isWhitelisted = WHITELIST_FILES.has(rel)
    const source = readFileSync(file, 'utf8')
    const styleBlocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
    const template = source.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
    const violations = [
      ...styleBlocks.flatMap((block) => scanStyleContent(block, { isWhitelisted })),
      ...scanTemplateAttrs(isWhitelisted ? '' : template),
    ]
    const ignoredLines = (source.match(new RegExp(IGNORE_MARK, 'g')) ?? []).length
    if (violations.length > 0 || isWhitelisted || ignoredLines > 0) {
      report.push({ file: rel, isWhitelisted, ignoredLines, violations })
    }
  }
  return report
}

function main() {
  const strict = process.argv.includes('--strict')
  const report = scanSrc()
  let total = 0
  for (const entry of report) {
    const tag = entry.isWhitelisted ? ' [白名单]' : ''
    console.log(`\n${entry.file}${tag} 违规 ${entry.violations.length} 处${entry.ignoredLines ? `，行级豁免 ${entry.ignoredLines} 处` : ''}`)
    for (const v of entry.violations) {
      console.log(`  L${v.line} [${v.rule}] ${v.snippet}`)
    }
    total += entry.violations.length
  }
  const whitelisted = report.filter((r) => r.isWhitelisted).length
  console.log(`\n合计：违规 ${total} 处，白名单文件 ${whitelisted} 个，行级豁免 ${report.reduce((s, r) => s + r.ignoredLines, 0)} 处`)
  if (strict && total > 0) process.exit(1)
}

if (process.argv[1] && toPosix(process.argv[1]).endsWith('check-tokens.mjs')) {
  main()
}
