import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBoardContext, ensureGlobal, pointerEventFor } from './context'
import type { WriterLike } from './context'

/** hanzi-writer 3.7.3 实例桩（API 面与真实库一致：无 cleanup 方法）。 */
function makeWriterMock(): WriterLike & {
  quizOptions: () => Record<string, unknown>
} {
  let capturedQuizOptions: Record<string, unknown> = {}
  const writer = {
    target: { trigger: vi.fn() },
    setCharacter: vi.fn(),
    animateCharacter: vi.fn(),
    cancelQuiz: vi.fn(),
    pauseAnimation: vi.fn(),
    hideCharacter: vi.fn(),
    quiz: vi.fn((opts: Record<string, unknown>) => {
      capturedQuizOptions = opts
    }),
    quizOptions: () => capturedQuizOptions,
  }
  return writer as unknown as WriterLike & { quizOptions: () => Record<string, unknown> }
}

const CHAR_DATA = {
  strokes: ['M 0 0 Q 1 1 2 2 Z'],
  medians: [[[0, 0], [1, 1]]],
}

/** 满足 MpViewShim 形状的视图桩。 */
function makeView(width = 300) {
  return {
    data: { width, height: width },
    canvas: { node: { width: 0, height: 0, getContext: () => null }, width, height: width },
    selectComponent: () => null,
    createSelectorQuery: () => ({
      select: () => ({
        boundingClientRect: () => ({ exec: () => {} }),
      }),
    }),
  }
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    char: '一',
    mode: 'animation' as const,
    autoPlay: true,
    leniency: 1.6,
    hintAfterMisses: 2,
    getCharData: vi.fn(() => CHAR_DATA),
    onReady: vi.fn(),
    onDataMissing: vi.fn(),
    onStrokeResult: vi.fn(),
    onQuizComplete: vi.fn(),
    deps: {
      createWriter: vi.fn(() => makeWriterMock()),
    },
    ...overrides,
  }
}

describe('context / createBoardContext', () => {
  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).wx = {
      createCanvasContext: vi.fn(() => ({ draw: vi.fn() })),
    }
  })

  it('有数据：以 canvas 渲染器 + 本地数据 charDataLoader 构造 writer，并回调 onReady', () => {
    const opts = makeOptions()
    const view = makeView(320)
    const ctx = createBoardContext(view, opts)
    ctx.setup('一')

    const createWriter = opts.deps.createWriter as ReturnType<typeof vi.fn>
    expect(createWriter).toHaveBeenCalledTimes(1)
    const [calledView, writerOpts] = createWriter.mock.calls[0]
    expect(calledView).toBe(view)
    expect(writerOpts.renderer).toBe('canvas')
    expect(writerOpts.width).toBe(320)
    expect(writerOpts.height).toBe(320)
    const deliver = vi.fn()
    writerOpts.charDataLoader('一', deliver)
    expect(deliver).toHaveBeenCalledWith(CHAR_DATA)
    expect(opts.onReady).toHaveBeenCalledTimes(1)
  })

  it('无数据：不构造 writer，回调 onDataMissing，后续命令安全无操作', () => {
    const opts = makeOptions({ getCharData: () => null })
    const ctx = createBoardContext(makeView(), opts)
    ctx.setup('花')

    expect(opts.deps.createWriter).not.toHaveBeenCalled()
    expect(opts.onDataMissing).toHaveBeenCalledTimes(1)
    expect(() => {
      ctx.play()
      ctx.startQuiz()
      ctx.trigger('pointerMove', {})
    }).not.toThrow()
  })

  it('animation 模式 autoPlay 时自动演示；autoPlay 关闭则不播', () => {
    const on = createBoardContext(makeView(), makeOptions())
    on.setup('一')
    const writerOn = on.writerForTest()
    expect(writerOn?.animateCharacter).toHaveBeenCalledTimes(1)

    const off = createBoardContext(
      makeView(),
      makeOptions({ autoPlay: false })
    )
    off.setup('一')
    expect(off.writerForTest()?.animateCharacter).not.toHaveBeenCalled()
  })

  it('quiz 模式 setup 即开始判定，选项含容差与提示阈值', () => {
    const opts = makeOptions({ mode: 'quiz' })
    const ctx = createBoardContext(makeView(), opts)
    ctx.setup('一')

    const writer = ctx.writerForTest() as unknown as ReturnType<typeof makeWriterMock>
    expect(writer.quiz).toHaveBeenCalledTimes(1)
    const quizOpts = writer.quizOptions()
    expect(quizOpts.leniency).toBe(1.6)
    expect(quizOpts.showHintAfterMisses).toBe(2)
    expect(quizOpts.onMistake).toBeTypeOf('function')
  })

  it('quiz 回调桥接为 strokeResult / quizComplete 事件', () => {
    const opts = makeOptions({ mode: 'quiz' })
    const ctx = createBoardContext(makeView(), opts)
    ctx.setup('一')

    const writer = ctx.writerForTest() as unknown as ReturnType<typeof makeWriterMock>
    const quizOpts = writer.quizOptions()
    ;(quizOpts.onMistake as (d: unknown) => void)({ strokeNum: 2, mistakesOnStroke: 1 })
    expect(opts.onStrokeResult).toHaveBeenCalledWith({
      type: 'mistake',
      strokeNum: 2,
      mistakesOnStroke: 1,
    })
    ;(quizOpts.onCorrectStroke as (d: unknown) => void)({ strokeNum: 1 })
    expect(opts.onStrokeResult).toHaveBeenCalledWith({ type: 'correct', strokeNum: 1 })
    ;(quizOpts.onComplete as (d: unknown) => void)({ totalMistakes: 3 })
    expect(opts.onQuizComplete).toHaveBeenCalledWith({ totalMistakes: 3 })
  })

  it('重复 startQuiz 先 cancelQuiz 再重开', () => {
    const ctx = createBoardContext(
      makeView(),
      makeOptions({ mode: 'quiz' })
    )
    ctx.setup('一')
    ctx.startQuiz()
    const writer = ctx.writerForTest() as unknown as ReturnType<typeof makeWriterMock>
    expect(writer.cancelQuiz).toHaveBeenCalledTimes(1)
    expect(writer.quiz).toHaveBeenCalledTimes(2)
  })

  it('换字重建：旧 writer 先停判定/停动画再废弃（hanzi-writer 无 cleanup，用 cancelQuiz+pauseAnimation）', () => {
    const opts = makeOptions()
    const ctx = createBoardContext(makeView(), opts)
    ctx.setup('一')
    const first = ctx.writerForTest() as unknown as ReturnType<typeof makeWriterMock>
    ctx.setup('二')

    expect(first.cancelQuiz).toHaveBeenCalledTimes(1)
    expect(first.pauseAnimation).toHaveBeenCalledTimes(1)
    expect(ctx.writerForTest()).not.toBe(first)
    expect(opts.deps.createWriter).toHaveBeenCalledTimes(2)
  })

  it('teardown 幂等：停判定/停动画后重复调用与命令均不抛', () => {
    const ctx = createBoardContext(makeView(), makeOptions())
    ctx.setup('一')
    ctx.teardown()
    const writer = ctx.writerForTest()
    expect(writer).toBeNull()
    expect(() => {
      ctx.teardown()
      ctx.play()
      ctx.startQuiz()
      ctx.trigger('pointerEnd', {})
    }).not.toThrow()
  })

  it('trigger 透传到 writer.target（书写触点事件来源）', () => {
    const ctx = createBoardContext(makeView(), makeOptions())
    ctx.setup('一')
    const writer = ctx.writerForTest() as unknown as ReturnType<typeof makeWriterMock>
    const evt = { touches: [{ clientX: 1, clientY: 2 }] }
    ctx.trigger('pointerMove', evt)
    expect(writer.target?.trigger).toHaveBeenCalledWith('pointerMove', evt)
  })
})

describe('pointerEventFor / 触摸事件名映射', () => {
  it('touchstart→pointerStart, touchmove→pointerMove, touchend/touchcancel→pointerEnd', () => {
    expect(pointerEventFor('touchstart')).toBe('pointerStart')
    expect(pointerEventFor('touchmove')).toBe('pointerMove')
    expect(pointerEventFor('touchend')).toBe('pointerEnd')
    expect(pointerEventFor('touchcancel')).toBe('pointerEnd')
  })
})

describe('ensureGlobal / 小程序逻辑层环境修正', () => {
  it('global 缺失时补齐为 globalThis，已存在时不覆盖', () => {
    const g = globalThis as Record<string, unknown>
    const original = g.global
    try {
      delete g.global
      ensureGlobal()
      expect(g.global).toBe(globalThis)
      const sentinel = { marked: true }
      g.global = sentinel
      ensureGlobal()
      expect(g.global).toBe(sentinel)
    } finally {
      g.global = original
    }
  })

  it('全局 Path2D 被摘除（强制 hanzi-writer 走指令式绘制，规避微信 canvas 2d 不兼容）', () => {
    const g = globalThis as Record<string, unknown>
    const originalPath2D = g.Path2D
    try {
      class FakePath2D {}
      g.Path2D = FakePath2D
      ensureGlobal()
      expect(g.Path2D).toBeUndefined()
    } finally {
      if (originalPath2D === undefined) {
        delete g.Path2D
      } else {
        g.Path2D = originalPath2D
      }
    }
  })
})
