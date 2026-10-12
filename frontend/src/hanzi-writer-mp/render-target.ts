/**
 * mp-weixin canvas 2d node 渲染目标（设计参考 hanzi-writer-miniprogram src/RenderTarget.js，MIT）。
 *
 * 用 canvas type="2d" 的 node.getContext('2d')（标准实现、同层渲染），
 * 替代 legacy wx.createCanvasContext——后者的 clip/draw 延迟回放在新基础库上
 * 存在渲染不完全问题，且微信已建议迁移 2d 接口。
 *
 * 高清适配：node 物理尺寸 = 逻辑尺寸 × dpr，ctx 预乘 scale(dpr)，
 * hanzi-writer 帧内 save/restore 会回到含 dpr 的状态，不会叠加。
 */

type PointerEventName = 'pointerStart' | 'pointerMove' | 'pointerEnd'
type PointerListener = (evt: { getPoint: () => { x: number; y: number }; preventDefault: () => void }) => void
type RawTouch = { clientX: number; clientY: number }
type RawPointerEvent = { touches?: RawTouch[]; changedTouches?: RawTouch[] }

/** 组件在 init 前经 createSelectorQuery().fields({node,size}) 获取的 canvas 2d 信息。 */
export interface CanvasNodeInfo {
  node: { width: number; height: number; getContext(kind: '2d'): CanvasRenderingContext2D | null }
  /** 逻辑尺寸（px），与 hanzi-writer 的 width/height 选项一致。 */
  width: number
  height: number
  /** 该 canvas 的选择器（同页多板时 id 实例级唯一，用于触点 rect 查询）。 */
  selector?: string
}

/** 视图层桩：uni-app 组件以 $scope + data 组装（见 hanzi-writer-board.vue mp 分支）。 */
export interface MpViewShim {
  /** 原生组件实例（测试环境可缺省）。 */
  scope?: unknown
  data: { width: number; height: number }
  /** canvas 2d node 信息（组件 init 时经 fields({node,size}) 异步获取后注入）。 */
  canvas: CanvasNodeInfo
  selectComponent(selector: string): unknown
  createSelectorQuery(): {
    select(selector: string): {
      boundingClientRect(cb: (rect: { left: number; top: number }) => void): { exec(): void }
    }
  }
}

export interface HanziRenderTarget {
  getContext(): CanvasRenderingContext2D
  addPointerStartListener(cb: PointerListener): void
  addPointerMoveListener(cb: PointerListener): void
  addPointerEndListener(cb: PointerListener): void
  trigger(name: PointerEventName, evt: RawPointerEvent): void
  removeAllListeners(): void
  updateDimensions(width: number, height: number): void
}

function createEventEmitter() {
  const listeners = new Map<PointerEventName, Set<PointerListener>>()
  return {
    addListener(name: PointerEventName, cb: PointerListener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(cb)
    },
    removeAllListeners() {
      listeners.clear()
    },
    trigger(name: PointerEventName, evt: { getPoint: () => { x: number; y: number }; preventDefault: () => void }) {
      listeners.get(name)?.forEach((cb) => cb(evt))
    },
  }
}

function primaryTouch(evt: RawPointerEvent): RawTouch | undefined {
  return evt.touches?.[0] ?? evt.changedTouches?.[0]
}

function pixelRatio(): number {
  const uni = (globalThis as { uni?: { getSystemInfoSync?(): { pixelRatio?: number } } }).uni
  return uni?.getSystemInfoSync?.()?.pixelRatio || 1
}

/** 创建 hanzi-writer 渲染目标（rendererOverride.createRenderTarget 签名）。 */
export function createRenderTarget(canvas: CanvasNodeInfo, view: MpViewShim): HanziRenderTarget {
  if (!canvas.node?.getContext) {
    throw new Error('[hanzi-writer-mp] canvas 2d node 不可用：确认 canvas 声明 type="2d" 且经 fields({node:true}) 获取')
  }
  const dpr = pixelRatio()
  canvas.node.width = canvas.width * dpr
  canvas.node.height = canvas.height * dpr
  const ctx = canvas.node.getContext('2d')
  if (!ctx) {
    throw new Error('[hanzi-writer-mp] canvas 2d context 获取失败：确认 canvas 声明 type="2d"')
  }
  ctx.scale(dpr, dpr)

  const emitter = createEventEmitter()

  // 画板位置在页面生命周期内稳定（竖屏固定布局），rect 只查一次并缓存，
  // 避免 touchmove 高频下逐事件跨层查询导致的乱序与开销。
  let rectCache: Promise<{ left: number; top: number }> | null = null
  const rectSelector = canvas.selector ?? '#writer-canvas'
  const getRect = () => {
    if (!rectCache) {
      rectCache = new Promise<{ left: number; top: number }>((resolve) => {
        view
          .createSelectorQuery()
          .select(rectSelector)
          .boundingClientRect((rect) => resolve(rect ?? { left: 0, top: 0 }))
          .exec()
      })
    }
    return rectCache
  }

  return {
    getContext: () => ctx,
    addPointerStartListener: (cb: PointerListener) => emitter.addListener('pointerStart', cb),
    addPointerMoveListener: (cb: PointerListener) => emitter.addListener('pointerMove', cb),
    addPointerEndListener: (cb: PointerListener) => emitter.addListener('pointerEnd', cb),
    /** 组件 touch 事件入口：异步取 canvas 位置后换算相对点位再分发。 */
    trigger(name: PointerEventName, evt: RawPointerEvent) {
      void getRect().then((rect) => {
        const touch = primaryTouch(evt)
        if (!touch) return
        emitter.trigger(name, {
          getPoint: () => ({ x: touch.clientX - rect.left, y: touch.clientY - rect.top }),
          preventDefault: () => {},
        })
      })
    },
    removeAllListeners: () => emitter.removeAllListeners(),
    /** 物理尺寸由本函数按 dpr 一次性设定，运行期固定。 */
    updateDimensions: () => {},
  }
}
