import { describe, expect, it } from 'vitest'
import {
  POEMS,
  POEM_COUNT,
  POEM_STAGES,
  getPoemById,
  poemCountByStage,
  poemLineCells,
  poemsByStage,
} from './poems'

describe('utils/poems / 数据完整性', () => {
  it('收录 90 首，满足"扩充 80+ 首"需求', () => {
    expect(POEM_COUNT).toBe(POEMS.length)
    expect(POEMS.length).toBeGreaterThanOrEqual(80)
  })

  it('每首必填字段齐全（标题/朝代/作者/诗行/译文非空）', () => {
    for (const poem of POEMS) {
      expect(poem.id.trim().length).toBeGreaterThan(0)
      expect(poem.title.trim().length).toBeGreaterThan(0)
      expect(poem.dynasty.trim().length).toBeGreaterThan(0)
      expect(poem.author.trim().length).toBeGreaterThan(0)
      expect(poem.lines.length).toBeGreaterThanOrEqual(2)
      for (const line of poem.lines) {
        expect(line.trim().length).toBeGreaterThan(0)
      }
      expect(poem.translation.trim().length).toBeGreaterThan(0)
    }
  })

  it('id 全局唯一（列表与详情靠 id 寻址）', () => {
    const ids = new Set(POEMS.map((p) => p.id))
    expect(ids.size).toBe(POEMS.length)
  })

  it('组诗副题可区分（同名组诗标题不重复）', () => {
    const titles = new Set(POEMS.map((p) => p.title))
    expect(titles.size).toBe(POEMS.length)
  })
})

describe('utils/poems / 学段分组', () => {
  it('三个学段标签齐全，且各学段都有诗', () => {
    expect(POEM_STAGES.map((s) => s.key)).toEqual(['lower', 'middle', 'upper'])
    expect(POEM_STAGES.map((s) => s.label)).toEqual(['1-2年级', '3-4年级', '5-6年级'])
    for (const stage of POEM_STAGES) {
      expect(poemsByStage(stage.key).length).toBeGreaterThan(0)
    }
  })

  it('各学段计数之和等于总数（无遗漏、无重复）', () => {
    const sum = POEM_STAGES.reduce((acc, s) => acc + poemCountByStage(s.key), 0)
    expect(sum).toBe(POEM_COUNT)
  })

  it('poemsByStage 只返回对应学段的诗', () => {
    const lower = poemsByStage('lower')
    const middle = poemsByStage('middle')
    const lowerIds = new Set(lower.map((p) => p.id))
    for (const poem of middle) {
      expect(lowerIds.has(poem.id)).toBe(false)
    }
  })
})

describe('utils/poems / getPoemById', () => {
  it('按 id 命中返回对应诗', () => {
    const poem = getPoemById('jing-ye-si')
    expect(poem).not.toBeNull()
    expect(poem?.title).toBe('静夜思')
    expect(poem?.author).toBe('李白')
  })

  it('非法 id 返回 null（详情页据此提示并返回）', () => {
    expect(getPoemById('not-exist')).toBeNull()
    expect(getPoemById('')).toBeNull()
  })
})

describe('utils/poems / 覆盖抽查', () => {
  it('课标篇目与教材补充篇目均在场', () => {
    const titles = new Set(POEMS.map((p) => p.title))
    // 课标 75 首抽查（首/中/尾）
    expect(titles.has('江南')).toBe(true)
    expect(titles.has('静夜思')).toBe(true)
    expect(titles.has('悯农（锄禾日当午）')).toBe(true)
    expect(titles.has('己亥杂诗')).toBe(true)
    // 教材补充抽查
    expect(titles.has('画')).toBe(true)
    expect(titles.has('清平乐·村居')).toBe(true)
    expect(titles.has('从军行')).toBe(true)
  })
})

describe('utils/poems / 拼音', () => {
  const HANZI_RE = /[一-鿿]/

  it('每首每行都有拼音，音节数与汉字数一致且均带声调', () => {
    for (const poem of POEMS) {
      expect(poem.linesPinyin.length, poem.id).toBe(poem.lines.length)
      for (let i = 0; i < poem.lines.length; i++) {
        const hanziCount = [...poem.lines[i]].filter((ch) => HANZI_RE.test(ch)).length
        const syllables = poem.linesPinyin[i].split(' ').filter(Boolean)
        expect(syllables.length, `${poem.id} 第${i + 1}行`).toBe(hanziCount)
        for (const syllable of syllables) {
          expect(syllable, `${poem.id} 第${i + 1}行「${syllable}」`).toMatch(
            /^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/,
          )
        }
      }
    }
  })

  it('多音字按教材读音覆盖（见/衰/单/更/重/教/那/亡/挑/没/供）', () => {
    const lineOf = (id: string, index: number) => getPoemById(id)!.linesPinyin[index]
    expect(lineOf('chi-le-ge', 6)).toContain('xiàn') // 风吹草低见牛羊
    expect(lineOf('hui-xiang-ou-shu', 1)).toContain('cuī') // 乡音无改鬓毛衰
    expect(lineOf('sai-xia-qu', 1)).toContain('chán') // 单于夜遁逃
    expect(lineOf('chang-xiang-si', 3)).toContain('gēng') // 风一更，雪一更
    expect(lineOf('zao-fa-bai-di-cheng', 3)).toContain('chóng') // 轻舟已过万重山
    expect(lineOf('bo-chuan-gua-zhou', 1)).toContain('chóng') // 钟山只隔数重山
    expect(lineOf('chu-sai', 3)).toContain('jiào') // 不教胡马度阴山
    expect(lineOf('guan-shu-you-gan', 2)).toContain('nǎ') // 问渠那得清如许
    expect(lineOf('qing-ping-yue-cun-ju', 6)).toContain('wú') // 最喜小儿亡赖
    expect(lineOf('ye-shu-suo-jian', 2)).toContain('tiǎo') // 知有儿童挑促织
    expect(lineOf('jiang-shang-yu-zhe', 3)).toContain('mò') // 出没风波里
    expect(lineOf('sishi-zaxing-zhou-chu', 2)).toContain('gōng') // 童孙未解供耕织
  })

  it('静夜思首行拼音正确', () => {
    expect(getPoemById('jing-ye-si')!.linesPinyin[0]).toBe('chuáng qián míng yuè guāng')
  })
})

describe('utils/poems / poemLineCells', () => {
  it('汉字挂拼音，标点不占音节', () => {
    const cells = poemLineCells('床前明月光，', 'chuáng qián míng yuè guāng')
    expect(cells).toHaveLength(6)
    expect(cells[0]).toEqual({ char: '床', pinyin: 'chuáng' })
    expect(cells[4]).toEqual({ char: '光', pinyin: 'guāng' })
    expect(cells[5]).toEqual({ char: '，', pinyin: '' })
  })

  it('音节不足时缺省为空串（对齐错误由数据测试兜底，不崩溃）', () => {
    const cells = poemLineCells('白日依山尽，', 'bái rì')
    expect(cells[2]).toEqual({ char: '依', pinyin: '' })
  })
})
