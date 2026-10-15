/** 知节数学·加减法口算纯逻辑工具（与页面解耦，便于复用与类型收敛）。 */

/** 口算题：a op b = answer。 */
export interface MathProblem {
  a: number
  op: '+' | '-'
  b: number
  answer: number
}

/** 难度档位（升序即选卡顺序；value 语义：操作数与得数均在 0..value 内）。 */
export const MATH_RANGES: readonly number[] = [10, 20, 50, 100, 1000]

/** 难度文案：10 → 「10以内」。 */
export function rangeLabel(range: number): string {
  return `${range}以内`
}

/** 得数 ≤ range，故最大输入位数 = range 的位数（键盘据此截断输入）。 */
export function maxInputLength(range: number): number {
  return String(range).length
}

/** 随机整数 [min, max]（含两端）；random 可注入以便测试。 */
function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

/**
 * 随机生成一道加减口算题（加减各半；前置条件 range ≥ 1）：
 * - 加法：1 ≤ a、1 ≤ b 且 a+b ≤ range（不超档位；要求 range ≥ 2）
 * - 减法：1 ≤ b ≤ a ≤ range（不出负数）
 * range = 1 时加法分支无法满足 a+b ≤ range，退化为纯减法。
 * random 参数供测试注入，默认 Math.random。
 */
export function generateProblem(range: number, random: () => number = Math.random): MathProblem {
  if (range >= 2 && random() < 0.5) {
    const a = randomInt(random, 1, range - 1)
    const b = randomInt(random, 1, range - a)
    return { a, op: '+', b, answer: a + b }
  }
  const a = randomInt(random, 1, range)
  const b = randomInt(random, 1, a)
  return { a, op: '-', b, answer: a - b }
}

/** 判定作答：input 为键入数字串，空串/非数字一律判错。 */
export function judgeAnswer(problem: MathProblem, input: string): boolean {
  if (!/^\d+$/.test(input)) {
    return false
  }
  return Number(input) === problem.answer
}
