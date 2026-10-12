import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderTarget, type CanvasNodeInfo, type MpViewShim } from './render-target'

/**
 * mp-weixin canvas 2d node 渲染目标单测。
 * canvas 2d 的 getContext('2d') 是标准实现：属性直接赋值、无需 legacy setter polyfill。
 */

function makeRawCtx() {
  return {
    scale: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    transform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    clip: vi.fn(),
  }
}

function makeNode(rawCtx = makeRawCtx()) {
  const node = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => rawCtx),
  }
  return { node, rawCtx }
}

function makeCanvasInfo(rawCtxInput?: ReturnType<typeof makeRawCtx>) {
  const { node, rawCtx } = makeNode(rawCtxInput)
  return {
    node: node as unknown as CanvasNodeInfo['node'],
    rawCtx,
    width: 335,
    height: 335,
  }
}

function makeView(): MpViewShim {
  return {
    scope: {},
    data: { width: 335, height: 335 },
    canvas: makeCanvasInfo(),
    selectComponent: vi.fn(),
    createSelectorQuery: vi.fn(() => ({
      select: () => ({
        boundingClientRect: (cb: (r: { left: number; top: number }) => void) =>
          ({ exec: () => cb({ left: 10, top: 20 }) }),
      }),
    })),
  }
}

describe('render-target / createRenderTarget（canvas 2d node）', () => {
  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).uni = {
      getSystemInfoSync: () => ({ pixelRatio: 2 }),
    }
  })

  it('按 dpr 设置 node 物理尺寸，getContext 后先 scale(dpr)', () => {
    const info = makeCanvasInfo()
    createRenderTarget(info, makeView())
    expect(info.node.width).toBe(670)
    expect(info.node.height).toBe(670)
    expect(info.node.getContext).toHaveBeenCalledWith('2d')
    expect(info.rawCtx.scale).toHaveBeenCalledWith(2, 2)
  })

  it('getContext 返回标准 2d ctx（无属性 polyfill）', () => {
    const info = makeCanvasInfo()
    const target = createRenderTarget(info, makeView())
    expect(target.getContext()).toBe(info.rawCtx)
  })

  it('trigger 把触点坐标换算为相对 canvas 的点位', async () => {
    const info = makeCanvasInfo()
    const target = createRenderTarget(info, makeView())
    const seen: Array<{ x: number; y: number }> = []
    target.addPointerStartListener((evt) => {
      seen.push(evt.getPoint())
    })
    target.trigger('pointerStart', { touches: [{ clientX: 60, clientY: 85 }] })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({ x: 50, y: 65 })
  })

  it('矩形位置仅查询一次并缓存（touchmove 高频不重复跨层查询）', async () => {
    const view = makeView()
    const target = createRenderTarget(makeCanvasInfo(), view)
    target.addPointerMoveListener(() => {})
    target.trigger('pointerStart', { touches: [{ clientX: 1, clientY: 1 }] })
    await vi.waitFor(() => {
      expect(view.createSelectorQuery).toHaveBeenCalledTimes(1)
    })
    target.trigger('pointerMove', { touches: [{ clientX: 2, clientY: 2 }] })
    await vi.waitFor(() => {
      expect(view.createSelectorQuery).toHaveBeenCalledTimes(1)
    })
  })

  it('node 或 2d context 缺失时快速失败并给出可读错误', () => {
    expect(() => createRenderTarget({ node: null as never, width: 10, height: 10 }, makeView())).toThrow(/canvas 2d/)
    const badNode = { width: 0, height: 0, getContext: () => null }
    expect(() => createRenderTarget({ node: badNode as never, width: 10, height: 10 }, makeView())).toThrow(/canvas 2d/)
  })
})
