import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HanziData } from '@/hanzi-data'

/**
 * 渲染管线集成冒烟：真实 hanzi-writer + 录制型 legacy ctx 桩。
 * 目的：验证 animateCharacter 帧循环确实向 ctx 发出了绘制指令，
 * 并暴露在 legacy ctx 上会抛错/缺失的调用。
 */

const CHAR_DATA: HanziData = {
  strokes: [
    'M 121 393 Q 250 380 393 429 T 700 500 Q 750 520 700 540 L 300 520 Q 180 510 121 393 Z',
  ],
  medians: [[[121, 393], [300, 400], [500, 460], [700, 520]]],
}

function makeRecordingCtx() {
  const methods: Record<string, Array<unknown[]>> = {}
  return {
    calls: methods,
    ctx: new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (!(prop in methods)) methods[prop] = []
          return (...args: unknown[]) => {
            methods[prop].push(args)
          }
        },
        set(_t, prop: string, value) {
          if (!(prop in methods)) methods[prop] = []
          methods[prop].push([value])
          return true
        },
      }
    ),
  }
}

function makeView(getCtx: () => unknown): import('./render-target').MpViewShim {
  return {
    scope: {},
    data: { width: 335, height: 335 },
    canvas: {
      node: {
        width: 0,
        height: 0,
        getContext: getCtx,
      },
      width: 335,
      height: 335,
    },
    selectComponent: () => null,
    createSelectorQuery: () => ({
      select: () => ({
        boundingClientRect: (cb: (r: { left: number; top: number }) => void) =>
          ({ exec: () => cb({ left: 10, top: 20 }) }),
      }),
    }),
  } as unknown as import('./render-target').MpViewShim
}

describe('渲染管线冒烟（真实 hanzi-writer + canvas 渲染器）', () => {
  let recorded: ReturnType<typeof makeRecordingCtx>

  beforeEach(() => {
    recorded = makeRecordingCtx()
    ;(globalThis as Record<string, unknown>).uni = {
      getSystemInfoSync: () => ({ pixelRatio: 2 }),
    }
  })

  it('animateCharacter 帧循环向 legacy ctx 发出绘制指令', async () => {
    // 模拟微信 canvas 2d 环境存在的（不兼容的）全局 Path2D：加载后应被 polyfill 摘除，
    // 强制走指令式绘制（对应真机「new Path2D() should not be used」告警与笔画不可见问题）。
    ;(globalThis as Record<string, unknown>).Path2D = class FakePath2D {}
    const { createBoardContext } = await import('./context')
    expect((globalThis as Record<string, unknown>).Path2D).toBeUndefined()
    const board = createBoardContext(makeView(() => recorded.ctx), {
      mode: 'animation',
      autoPlay: true,
      leniency: 1.6,
      hintAfterMisses: 2,
      getCharData: () => CHAR_DATA,
      onReady: vi.fn(),
      onDataMissing: vi.fn(),
      onStrokeResult: vi.fn(),
      onQuizComplete: vi.fn(),
    })
    board.setup('七')

    // 真实时钟：让 rAF fallback（setTimeout 60fps）跑 1.5 秒动画。
    await new Promise((r) => setTimeout(r, 1500))

    const names = Object.keys(recorded.calls)
    const drawingOps = ['beginPath', 'stroke', 'fill', 'moveTo', 'draw']
    const fired = drawingOps.filter((op) => (recorded.calls[op]?.length ?? 0) > 0)
    console.log('[smoke] ctx 收到的调用：', names.join(', '))
    console.log('[smoke] 绘制类调用命中：', fired.join(', ') || '无')
    expect(fired.length, `绘制指令应到达 ctx，实际调用：${names.join(',') || '无'}`).toBeGreaterThan(0)
    expect(recorded.calls['draw']?.length ?? 0).toBeGreaterThan(0)
  })
})
