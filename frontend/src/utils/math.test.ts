import { describe, expect, it } from 'vitest'
import { MATH_RANGES, generateProblem, judgeAnswer, maxInputLength, rangeLabel } from './math'
import type { MathProblem } from './math'

/** 固定随机数：恒返回 value（用于锁定加/减分支）。 */
function alwaysRandom(value: number) {
  return () => value
}

describe('utils/math / MATH_RANGES', () => {
  it('难度档位为 10/20/50/100/1000，按升序', () => {
    expect([...MATH_RANGES]).toEqual([10, 20, 50, 100, 1000])
  })
})

describe('utils/math / rangeLabel', () => {
  it('难度值 → 「N以内」文案', () => {
    expect(rangeLabel(10)).toBe('10以内')
    expect(rangeLabel(1000)).toBe('1000以内')
  })
})

describe('utils/math / generateProblem', () => {
  it.each(MATH_RANGES)('range=%i：500 道题全部满足范围约束（不出负数、不超档位）', (range) => {
    for (let i = 0; i < 500; i++) {
      const p = generateProblem(range)
      expect(p.op === '+' || p.op === '-').toBe(true)
      expect(p.a).toBeGreaterThanOrEqual(1)
      expect(p.b).toBeGreaterThanOrEqual(1)
      expect(p.a).toBeLessThanOrEqual(range)
      expect(p.b).toBeLessThanOrEqual(range)
      expect(p.answer).toBeGreaterThanOrEqual(0)
      expect(p.answer).toBeLessThanOrEqual(range)
      if (p.op === '+') {
        // 加法：得数 = a+b 且不超档位
        expect(p.answer).toBe(p.a + p.b)
        expect(p.a + p.b).toBeLessThanOrEqual(range)
      } else {
        // 减法：不出负数（a ≥ b）
        expect(p.a).toBeGreaterThanOrEqual(p.b)
        expect(p.answer).toBe(p.a - p.b)
      }
    }
  })

  it('加减混合：大量随机下两种运算符都会出现', () => {
    const ops = new Set<string>()
    for (let i = 0; i < 200; i++) {
      ops.add(generateProblem(10).op)
    }
    expect(ops.has('+')).toBe(true)
    expect(ops.has('-')).toBe(true)
  })

  it('注入 random 锁定分支：恒 0.49 → 加法；恒 0.51 → 减法', () => {
    const plus = generateProblem(10, alwaysRandom(0.49))
    expect(plus.op).toBe('+')
    const minus = generateProblem(10, alwaysRandom(0.51))
    expect(minus.op).toBe('-')
  })

  it('注入 random=0 取各分支最小操作数', () => {
    // 加法：a=1, b=1
    expect(generateProblem(10, alwaysRandom(0))).toEqual<MathProblem>({
      a: 1,
      op: '+',
      b: 1,
      answer: 2,
    })
  })

  it('range = 1 退化为纯减法（加法分支无法满足 a+b ≤ range；range < 1 属非法入参不在契约内）', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateProblem(1)).toEqual<MathProblem>({ a: 1, op: '-', b: 1, answer: 0 })
    }
  })
})

describe('utils/math / judgeAnswer', () => {
  const problem: MathProblem = { a: 7, op: '+', b: 5, answer: 12 }

  it('正确答案判对', () => {
    expect(judgeAnswer(problem, '12')).toBe(true)
  })

  it('错误答案判错', () => {
    expect(judgeAnswer(problem, '11')).toBe(false)
    expect(judgeAnswer(problem, '13')).toBe(false)
  })

  it('得数为 0 时输入 0 判对', () => {
    const zero: MathProblem = { a: 3, op: '-', b: 3, answer: 0 }
    expect(judgeAnswer(zero, '0')).toBe(true)
  })

  it('空串 / 非数字输入一律判错', () => {
    expect(judgeAnswer(problem, '')).toBe(false)
    expect(judgeAnswer(problem, 'abc')).toBe(false)
    expect(judgeAnswer(problem, '12x')).toBe(false)
    expect(judgeAnswer(problem, '-12')).toBe(false)
    expect(judgeAnswer(problem, ' 12')).toBe(false)
  })

  it('前导零按数值语义判对（键入「012」等价 12）', () => {
    expect(judgeAnswer(problem, '012')).toBe(true)
  })
})

describe('utils/math / maxInputLength', () => {
  it('得数 ≤ range，最大输入位数为 range 的位数', () => {
    expect(maxInputLength(10)).toBe(2)
    expect(maxInputLength(20)).toBe(2)
    expect(maxInputLength(50)).toBe(2)
    expect(maxInputLength(100)).toBe(3)
    expect(maxInputLength(1000)).toBe(4)
  })
})
