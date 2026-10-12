/**
 * mp-weixin 书写板桥接（改编自 hanzi-writer-miniprogram src/hanzi-writer-context.js，MIT）。
 *
 * 替代 mp 端失效的 renderjs 方案：逻辑层直接构造 HanziWriter（canvas 渲染器 + 自定义
 * 渲染目标），动画/判定回调均为普通 JS，无需视图层桥接。笔顺数据来自本地
 * hanzi-data（构建期内嵌，不走 CDN）。
 */
import './global-polyfill' // 必须先于 hanzi-writer 求值：补逻辑层缺失的 global
import { ensureGlobal } from './global-polyfill'
import HanziWriter from 'hanzi-writer'
import { createRenderTarget, type CanvasNodeInfo, type MpViewShim } from './render-target'
import type { HanziData } from '@/hanzi-data'

/** 与 hanzi-writer-board.vue H5 分支保持一致的视觉参数。 */
const STYLE_OPTIONS = {
  strokeAnimationSpeed: 1.2,
  delayBetweenStrokes: 700,
  strokeColor: '#1F2937',
  outlineColor: '#E5E7EB',
  drawingColor: '#4CAF7A',
  drawingWidth: 4,
  highlightColor: '#FFB43D',
  padding: 8,
  showOutline: true,
  showCharacter: false,
} as const

/** 运行链路诊断日志（仅开发构建输出，便于真机排障）。 */
const DEBUG = import.meta.env.DEV
function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    console.log('[hanzi-mp]', ...args)
  }
}

/** 动画/判定为异步流程，失败静默会成为无报错白板；统一落错误日志。 */
function swallowRejection(label: string, result: unknown): void {
  Promise.resolve(result).catch((err: unknown) => {
    console.error(`[hanzi-mp] ${label} 失败`, err)
  })
}

export interface WriterLike {
  target?: { trigger(name: string, evt: unknown): void }
  /** 装载汉字（经 charDataLoader）并渲染初始轮廓；动画/判定的前置。 */
  setCharacter(char: string): unknown
  animateCharacter(options?: unknown): unknown
  quiz(options: Record<string, unknown>): unknown
  cancelQuiz?(): unknown
  pauseAnimation?(): unknown
}

export interface BoardCallbacks {
  onReady?: () => void
  onDataMissing?: () => void
  onStrokeResult?: (payload: { type: 'mistake' | 'correct'; strokeNum: number; mistakesOnStroke?: number }) => void
  onQuizComplete?: (payload: { totalMistakes: number }) => void
}

export interface BoardContextOptions extends BoardCallbacks {
  mode: 'animation' | 'quiz'
  autoPlay: boolean
  leniency: number
  hintAfterMisses: number
  /** 本地笔顺数据源（缺字返回 null 走降级）。 */
  getCharData(char: string): HanziData | null
  /** 测试注入缝；生产为默认 HanziWriter 构造。 */
  deps?: { createWriter?: (view: MpViewShim, opts: Record<string, unknown>) => WriterLike }
}

export type PointerEventName = 'pointerStart' | 'pointerMove' | 'pointerEnd'

/** uni-app touch 事件名 → hanzi-writer 指针事件名。 */
export function pointerEventFor(touchEventName: string): PointerEventName | null {
  switch (touchEventName) {
    case 'touchstart':
      return 'pointerStart'
    case 'touchmove':
      return 'pointerMove'
    case 'touchend':
    case 'touchcancel':
      return 'pointerEnd'
    default:
      return null
  }
}

export interface BoardContext {
  /** （重建并）装载指定汉字；无数据触发 onDataMissing 且不构造 writer。 */
  setup(char: string): void
  /** 播放笔顺动画。 */
  play(): void
  /** 开始/重开书写判定（重复调用先取消旧判定）。 */
  startQuiz(): void
  /** 释放 writer（幂等）。 */
  teardown(): void
  /** 组件 touch 事件转发入口。 */
  trigger(name: PointerEventName, evt: unknown): void
  /** @internal 测试观察口。 */
  writerForTest(): WriterLike | null
}

export { ensureGlobal }

export function createBoardContext(view: MpViewShim, options: BoardContextOptions): BoardContext {
  const createWriter =
    options.deps?.createWriter ??
    ((v: MpViewShim, opts: Record<string, unknown>) =>
      new HanziWriter(v.canvas as never, {
        ...opts,
        rendererOverride: {
          createRenderTarget: (canvasInfo: CanvasNodeInfo) => createRenderTarget(canvasInfo, v),
        },
      }) as unknown as WriterLike)

  let writer: WriterLike | null = null

  function teardown() {
    // hanzi-writer 3.7.3 实例无 cleanup 方法：用 cancelQuiz + pauseAnimation
    // 停掉进行中的判定与动画帧循环，避免旧 writer 在同一 canvas-id 上继续刷帧。
    writer?.cancelQuiz?.()
    writer?.pauseAnimation?.()
    writer = null
  }

  function buildQuizOptions(): Record<string, unknown> {
    return {
      leniency: options.leniency,
      showHintAfterMisses: options.hintAfterMisses,
      onMistake: (strokeData: { strokeNum: number; mistakesOnStroke: number }) => {
        options.onStrokeResult?.({ type: 'mistake', strokeNum: strokeData.strokeNum, mistakesOnStroke: strokeData.mistakesOnStroke })
      },
      onCorrectStroke: (strokeData: { strokeNum: number }) => {
        options.onStrokeResult?.({ type: 'correct', strokeNum: strokeData.strokeNum })
      },
      onComplete: (data: { totalMistakes: number }) => {
        options.onQuizComplete?.({ totalMistakes: data.totalMistakes })
      },
    }
  }

  function startQuiz() {
    if (!writer) return
    writer.cancelQuiz?.()
    swallowRejection('quiz', writer.quiz(buildQuizOptions()))
  }

  function play() {
    if (!writer) return
    swallowRejection('animate', writer.animateCharacter())
  }

  function setup(char: string) {
    teardown()
    const data = options.getCharData(char)
    if (!data) {
      debugLog('setup：无笔顺数据', char)
      options.onDataMissing?.()
      return
    }

    try {
      writer = createWriter(view, {
        ...STYLE_OPTIONS,
        renderer: 'canvas',
        width: view.data.width,
        height: view.data.height,
        charDataLoader: (_loadedChar: string, onComplete: (d: HanziData) => void) => {
          onComplete(data)
        },
      })
    } catch (err) {
      console.error('[hanzi-mp] writer 构造失败', char, err)
      options.onDataMissing?.()
      return
    }
    debugLog('setup：writer 就绪', char, `size=${view.data.width}x${view.data.height}`)
    // 必须显式装载汉字（H5 分支的 HanziWriter.create 内部即 setCharacter）：
    // 缺少它 hanzi-writer 无 character 上下文，动画/判定空转且无报错。
    swallowRejection('setCharacter', writer.setCharacter(char))
    options.onReady?.()

    if (options.mode === 'quiz') {
      // 全新 writer 无需先取消旧判定，直接开判。
      swallowRejection('quiz', writer.quiz(buildQuizOptions()))
    } else if (options.autoPlay) {
      play()
    }
  }

  return {
    setup,
    play,
    startQuiz,
    teardown,
    trigger: (name, evt) => {
      writer?.target?.trigger?.(name, evt)
    },
    writerForTest: () => writer,
  }
}
