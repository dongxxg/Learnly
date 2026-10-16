import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

// 设计令牌三源一致性守护（ui-polish / design-tokens 规格）：
//   uni.scss（SCSS 变量，编译期）↔ App.vue（CSS 变量，运行时）↔ pages.json（tabBar/导航栏）
// uni.scss 中的令牌必须保持"字面量单行"（值内不得引用其他变量/函数），否则本测试无法静态解析。

const srcDir = fileURLToPath(new URL('..', import.meta.url))

function read(path: string): string {
  return readFileSync(`${srcDir}/${path}`, 'utf8')
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 解析 uni.scss 的 $learnly-* 变量 → { 'learnly-primary': '#4CAF7A', ... } */
function parseScssTokens(): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const m of stripComments(read('uni.scss')).matchAll(/^\s*\$([a-z0-9-]+)\s*:\s*([^;]+);\s*$/gm)) {
    tokens[m[1]] = m[2].trim().replace(/\s+/g, ' ')
  }
  return tokens
}

/** 解析 App.vue <style> 块的 --learnly-* CSS 变量 → { 'learnly-primary': '#4CAF7A', ... } */
function parseCssVars(): Record<string, string> {
  const style = read('App.vue')
  const blocks = [...style.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
  const tokens: Record<string, string> = {}
  for (const m of blocks.join('\n').matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (!m[1].startsWith('learnly-')) continue
    tokens[m[1]] = m[2].trim().replace(/\s+/g, ' ')
  }
  return tokens
}

function parsePagesJson(): { tabBar: Record<string, string>; globalStyle: Record<string, string> } {
  // pages.json 允许注释，走去注释后 JSON.parse
  return JSON.parse(stripComments(read('pages.json')))
}

const norm = (v?: string) => (v ?? '<undefined>').trim().toLowerCase()

describe('设计令牌三源一致性', () => {
  it('uni.scss 每个 $learnly-* 变量在 App.vue 都有同值 CSS 变量', () => {
    const scss = parseScssTokens()
    expect(Object.keys(scss).length).toBeGreaterThan(0)
    const css = parseCssVars()
    const missing = Object.keys(scss).filter((name) => !(name in css))
    expect(missing, `App.vue 缺少 CSS 变量: ${missing.map((n) => `--${n}`).join(', ')}`).toEqual([])
    const drifted = Object.keys(scss).filter((name) => norm(scss[name]) !== norm(css[name]))
    expect(drifted, `CSS 变量与 SCSS 值漂移: ${drifted.join(', ')}`).toEqual([])
  })

  it('App.vue 不存在 uni.scss 之外的孤儿 --learnly-* 变量', () => {
    const scss = Object.keys(parseScssTokens())
    const css = Object.keys(parseCssVars())
    const orphan = css.filter((name) => !scss.includes(name))
    expect(orphan, `孤儿 CSS 变量（uni.scss 无对应）: ${orphan.map((n) => `--${n}`).join(', ')}`).toEqual([])
  })

  it('旧 6 变量名与值冻结（19 个既有文件兼容的静态证明）', () => {
    const scss = parseScssTokens()
    const legacy: Record<string, string> = {
      'learnly-primary': '#4CAF7A',
      'learnly-secondary': '#FFB43D',
      'learnly-bg': '#F7F8FA',
      'learnly-text': '#1F2937',
      'learnly-text-light': '#9CA3AF',
      'learnly-radius-sm': '8rpx',
      'learnly-radius-md': '16rpx',
      'learnly-radius-lg': '24rpx',
    }
    for (const [name, value] of Object.entries(legacy)) {
      expect(norm(scss[name]), `旧变量 $${name} 必须保留且值不变`).toBe(norm(value))
    }
  })

  it('hanzi-writer-mp canvas 配色与令牌同值（3.7 同步守护）', () => {
    const scss = parseScssTokens()
    const ctx = stripComments(read('hanzi-writer-mp/context.ts'))
    const pairs: Array<[string, string, string]> = [
      ['strokeColor', ctx.match(/strokeColor:\s*'(#\w+)'/)?.[1] ?? '', scss['learnly-text']],
      ['outlineColor', ctx.match(/outlineColor:\s*'(#\w+)'/)?.[1] ?? '', scss['learnly-border']],
      ['drawingColor', ctx.match(/drawingColor:\s*'(#\w+)'/)?.[1] ?? '', scss['learnly-primary']],
      ['highlightColor', ctx.match(/highlightColor:\s*'(#\w+)'/)?.[1] ?? '', scss['learnly-secondary']],
    ]
    for (const [name, actual, expected] of pairs) {
      expect(actual, `${name} 不存在`).toBeTruthy()
      expect(norm(actual), `canvas ${name} 与令牌漂移`).toBe(norm(expected))
    }
  })

  it('pages.json 主题色与令牌同值', () => {
    const scss = parseScssTokens()
    const { tabBar, globalStyle } = parsePagesJson()
    const pairs: Array<[string, string, string]> = [
      ['tabBar.selectedColor', tabBar.selectedColor, scss['learnly-primary']],
      ['tabBar.color', tabBar.color, scss['learnly-text-light']],
      ['tabBar.backgroundColor', tabBar.backgroundColor, scss['learnly-surface']],
      ['globalStyle.backgroundColor', globalStyle.backgroundColor, scss['learnly-bg']],
      ['globalStyle.navigationBarBackgroundColor', globalStyle.navigationBarBackgroundColor, scss['learnly-surface']],
    ]
    for (const [field, actual, expected] of pairs) {
      expect(norm(actual), `${field} 应与令牌同值`).toBe(norm(expected))
    }
  })
})
