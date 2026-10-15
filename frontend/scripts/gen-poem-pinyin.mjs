// 从 src/utils/poems-data-{lower,middle,upper}.ts 提取诗行，用 cnchar 生成逐字拼音，
// 写入 src/utils/poems-pinyin-data.ts（构建期产物，与 gen-hanzi-data.mjs 同模式：
// devDependency 不进运行时包）。多音字/生僻字读音经 OVERRIDES 修正对齐部编教材。
// 用法：node scripts/gen-poem-pinyin.mjs （生成后 vitest 兜底校验音节-汉字对齐）。
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cnchar from 'cnchar'

const frontendRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DATA_FILES = [
  'src/utils/poems-data-lower.ts',
  'src/utils/poems-data-middle.ts',
  'src/utils/poems-data-upper.ts',
]
const OUT_FILE = 'src/utils/poems-pinyin-data.ts'

/**
 * 全局读音覆盖（全语料生效）：仅当该读音在本库 90 首内一致时才可放这里。
 * 新增诗行若出现这些字的不同读音，须改用按诗覆盖（OVERRIDES）。
 */
const GLOBAL_OVERRIDES = {
  见: 'xiàn', // 敕勒歌：风吹草低见牛羊（通"现"）
  衰: 'cuī', // 回乡偶书：乡音无改鬓毛衰（教材注音）
  还: 'huán', // 人未还/照我还/终不还
}

/** 按诗覆盖：poemId → { 汉字: 读音 }。 */
const OVERRIDES = {
  'sai-xia-qu': { 单: 'chán' },
  'chang-xiang-si': { 更: 'gēng' }, // 风一更，雪一更
  'zao-fa-bai-di-cheng': { 重: 'chóng' }, // 万重山
  'bo-chuan-gua-zhou': { 重: 'chóng' }, // 数重山
  'chu-sai': { 教: 'jiào' }, // 不教胡马度阴山
  'you-zi-yin': { 缝: 'féng' }, // 临行密密缝
  'jiang-shang-yu-zhe': { 没: 'mò' }, // 出没风波里
  'guo-gu-ren-zhuang': { 场: 'cháng', 黍: 'shǔ', 圃: 'pǔ' }, // 开轩面场圃
  'sishi-zaxing-zhou-chu': { 供: 'gōng' }, // 未解供耕织
  'qing-ping-yue-cun-ju': { 亡: 'wú', 剥: 'bō', 媪: 'ǎo' }, // 亡赖/卧剥莲蓬/翁媪
  'ye-shu-suo-jian': { 挑: 'tiǎo' }, // 挑促织
  'tiao-tiao-qian-niu-xing': { 擢: 'zhuó', 札: 'zhá', 杼: 'zhù', 脉: 'mò' },
  'lang-tao-sha': { 簸: 'bǒ' }, // 浪淘风簸
  'yu-ge-zi': { 箬: 'ruò', 鳜: 'guì' },
  'yong-liu': { 绦: 'tāo' }, // 绿丝绦
  'jiu-yue-jiu-ri': { 茱: 'zhū', 萸: 'yú' },
  'yuan-ri': { 曈: 'tóng', 屠: 'tú', 苏: 'sū' },
  'hui-chong-chun-jiang-wan-jing': { 蒌: 'lóu' },
  'suo-jian': { 樾: 'yuè' }, // 歌声振林樾
  'shan-ju-qiu-ming': { 暝: 'míng', 浣: 'huàn' },
  'ji-hai-za-shi': { 恃: 'shì', 喑: 'yīn', 擞: 'sǒu' },
  'xiao-chi': { 露: 'lù' }, // 小荷才露尖尖角
  'xiao-er-chui-diao': { 应: 'yìng' }, // 怕得鱼惊不应人
  'you-yuan-bu-zhi': { 应: 'yīng' }, // 应怜屐齿印苍苔
  'yong-e': { 曲: 'qū' }, // 曲项向天歌
  'chi-le-ge': { 敕: 'chì', 勒: 'lè' },
  'guan-shu-you-gan': { 那: 'nǎ' }, // 问渠那得清如许
  'song-yuan-er-shi-an-xi': { 浥: 'yì' }, // 渭城朝雨浥轻尘（cnchar 词库缺字）
}

const HANZI_RE = /[一-鿿]/
const SYLLABLE_RE = /^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/

/** 从数据文件提取 { id, lines }（格式固定：id 在前、lines 数组在同一条目内）。 */
function extractPoems(source) {
  const poems = []
  const entryRe = /id:\s*'([^']+)'[\s\S]*?lines:\s*\[([^\]]+)\]/g
  let match
  while ((match = entryRe.exec(source)) !== null) {
    const lines = []
    const strRe = /'((?:[^'\\]|\\.)*)'/g
    let strMatch
    while ((strMatch = strRe.exec(match[2])) !== null) {
      lines.push(strMatch[1])
    }
    if (lines.length === 0) {
      throw new Error(`条目 ${match[1]} 未解析到诗行`)
    }
    poems.push({ id: match[1], lines })
  }
  return poems
}

function spellChar(char, poemId) {
  const overridden = OVERRIDES[poemId]?.[char] ?? GLOBAL_OVERRIDES[char]
  if (overridden) {
    return overridden
  }
  const [spelled] = cnchar.spell(char, 'tone', 'low', 'array')
  if (!SYLLABLE_RE.test(spelled)) {
    throw new Error(`「${char}」(${poemId}) 拼音异常：${spelled}，请在 OVERRIDES 中补覆盖`)
  }
  return spelled
}

const poems = DATA_FILES.flatMap((file) =>
  extractPoems(readFileSync(path.join(frontendRoot, file), 'utf-8')),
)

const ids = new Set(poems.map((p) => p.id))
if (ids.size !== poems.length) {
  throw new Error('数据文件存在重复 id')
}

const entries = poems.map(({ id, lines }) => {
  const pinyinLines = lines.map((line) =>
    [...line]
      .filter((ch) => HANZI_RE.test(ch))
      .map((ch) => spellChar(ch, id))
      .join(' '),
  )
  return `  '${id}': [\n${pinyinLines.map((p) => `    '${p}',`).join('\n')}\n  ],`
})

const header =
  '/** 构建期产物（scripts/gen-poem-pinyin.mjs 生成），勿手改；读音修正请改脚本 OVERRIDES 后重新生成。 */\n' +
  'export const POEM_PINYIN: Readonly<Record<string, readonly string[]>> = {\n'

writeFileSync(path.join(frontendRoot, OUT_FILE), header + entries.join('\n') + '\n}\n')
console.log(`已生成 ${OUT_FILE}：${poems.length} 首诗`)
