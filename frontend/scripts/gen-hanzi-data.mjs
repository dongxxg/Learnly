// 从 hanzi-writer-data（MIT）导出 seed 字库的笔顺数据到 src/hanzi-data/。
// 文件按 Unicode 码点命名（如 一 → u4e00.json），规避中文文件名在 git/URL/跨端打包的坑。
// 缺字时输出清单并以非 0 退出（缺字由前端按 spec 降级隐藏书写入口）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const frontendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const seedsPath = path.join(frontendRoot, '../backend/seeds/characters.json')
const pkgDir = path.join(frontendRoot, 'node_modules/hanzi-writer-data')
const outDir = path.join(frontendRoot, 'src/hanzi-data')

const seeds = JSON.parse(readFileSync(seedsPath, 'utf-8'))
mkdirSync(outDir, { recursive: true })

// 清理旧导出（仅 u*.json），保证目录与 seed 一致。
for (const f of readdirSync(outDir)) {
  if (/^u[0-9a-f]+\.json$/.test(f)) unlinkSync(path.join(outDir, f))
}

const outName = (ch) => 'u' + ch.codePointAt(0).toString(16) + '.json'
const missing = []
let exported = 0
for (const item of seeds) {
  // 源包以汉字命名（一.json），导出统一为码点命名（u4e00.json）。
  const src = path.join(pkgDir, item.char + '.json')
  if (!existsSync(src)) {
    missing.push(item.char)
    continue
  }
  writeFileSync(path.join(outDir, outName(item.char)), readFileSync(src))
  exported++
}

console.log(`笔顺数据导出：${exported}/${seeds.length}`)
if (missing.length > 0) {
  console.error(`缺字清单（${missing.length} 个）：${missing.join(' ')}`)
  process.exit(1)
}
