<!-- eslint-disable vue/no-mutating-props -->
<template>
  <!-- 模板级 #ifdef 会被 mp 编译器转为未赋值的 wx:if={{rN}}（永不渲染），
       故用数据标志 isMpWeixin 区分分支；renderjs 块在 mp 端本就被编译器丢弃。 -->
  <view class="hw-board" :style="isMpWeixin && boardSize ? { height: boardSize + 'px' } : {}">
    <canvas
      v-if="isMpWeixin"
      :id="canvasId"
      type="2d"
      class="hw-host"
      :style="{ width: boardSize + 'px', height: boardSize + 'px' }"
      disable-scroll
      @touchstart="onTouch('touchstart', $event)"
      @touchmove.stop.prevent="onTouch('touchmove', $event)"
      @touchend="onTouch('touchend', $event)"
      @touchcancel="onTouch('touchcancel', $event)"
    />
    <view
      v-else
      ref="host"
      class="hw-host"
      :spec="spec"
      :change:spec="hw.onSpecChange"
    />
  </view>
</template>

<script lang="ts">
// @ts-nocheck
// renderjs 模板绑定（:change:spec="hw.onSpecChange"）是 uni-app 编译器语法，
// vue-tsc 无法识别 hw 模块命名空间，故对本组件整体关闭类型检查（契约由 spec 对象收敛）。
/**
 * 田字格书写画板（design D8）。
 *
 * - H5 / app-vue：renderjs 封装（视图层直驱 HanziWriter SVG 渲染器），
 *   逻辑层经 spec prop 下发命令、__on* 回调转发事件。
 * - mp-weixin：renderjs 被编译器丢弃（mp 端 renderjs 实为 wxs，无 DOM/SVG 能力），
 *   改用逻辑层 canvas 方案（hanzi-writer-mp/，rendererOverride 自定义渲染目标）。
 * - 笔顺判定严格保序保向（quiz 默认行为）；空间容差 leniency 放宽适配儿童；
 *   同一笔连错 hintAfterMisses 次后显示提示轨迹。
 * - 无笔顺数据时触发 dataMissing，页面按 spec 降级隐藏演示与书写入口。
 */
// #ifdef MP-WEIXIN
// mp 桥接与笔顺数据仅在逻辑层 mp 分支使用，条件编译避免 H5/app 包附带
// （hanzi-data 956KB 已由 renderjs 视图层分支独立打包，不在此重复）。
import { createBoardContext, pointerEventFor, type BoardContext } from '@/hanzi-writer-mp/context'
import { getHanziData } from '@/hanzi-data'
// #endif

/** mp 端 canvas 兜底尺寸（rpx），与样式表 .hw-board 固定高度一致。 */
const MP_FALLBACK_SIZE_RPX = 560

/** 页面可能同时挂多块板（演示+书写），canvas 节点 id 需实例级唯一。 */
let boardInstanceCount = 0

export default {
  props: {
    char: { type: String, required: true },
    mode: {
      type: String,
      default: 'animation', // animation | quiz
    },
    /** 空间容差（1 为标准，儿童建议放宽到 ~1.6）。 */
    leniency: { type: Number, default: 1.6 },
    /** 同一笔连续写错 N 次后显示提示轨迹。 */
    hintAfterMisses: { type: Number, default: 2 },
    /** animation 模式挂载后是否自动演示。 */
    autoPlay: { type: Boolean, default: true },
  },

  emits: ['ready', 'dataMissing', 'strokeResult', 'quizComplete'],

  data() {
    return {
      rev: 0,
      cmd: 'setup',
      isMpWeixin: false,
      canvasId: 'writer-canvas',
      // #ifdef MP-WEIXIN
      boardSize: 0,
      mpContext: null as BoardContext | null,
      mpDestroyed: false,
      // #endif
    }
  },

  created() {
    // #ifdef MP-WEIXIN
    this.isMpWeixin = true
    this.canvasId = `writer-canvas-${++boardInstanceCount}`
    // #endif
  },

  computed: {
    /** 下发给视图层的完整规格；rev 递增保证每次变更都被视图层感知。 */
    spec() {
      return {
        rev: this.rev,
        cmd: this.cmd,
        char: this.char,
        mode: this.mode,
        autoPlay: this.autoPlay,
        leniency: this.leniency,
        hint: this.hintAfterMisses,
      }
    },
  },

  watch: {
    char() {
      // #ifdef MP-WEIXIN
      this.mpSetup()
      // #endif
      // #ifndef MP-WEIXIN
      this.cmd = 'setup'
      this.rev++
      // #endif
    },
    mode() {
      // #ifdef MP-WEIXIN
      this.mpSetup()
      // #endif
      // #ifndef MP-WEIXIN
      this.cmd = 'setup'
      this.rev++
      // #endif
    },
  },

  mounted() {
    // #ifdef MP-WEIXIN
    this.initMpBoard()
    // #endif
    // #ifndef MP-WEIXIN
    // 首个 spec 由 mounted 后的首次渲染下发，cmd 已是 setup。
    // #endif
  },

  // #ifdef MP-WEIXIN
  beforeUnmount() {
    this.mpDestroyed = true
    this.mpContext?.teardown()
    this.mpContext = null
  },
  // #endif

  methods: {
    // ---- 视图层回调（renderjs callMethod 进来）----
    __onReady() {
      this.$emit('ready')
    },
    __onDataMissing() {
      this.$emit('dataMissing')
    },
    __onStrokeResult(payload: { type: string; strokeNum: number; mistakesOnStroke: number }) {
      this.$emit('strokeResult', payload)
    },
    __onQuizComplete(payload: { totalMistakes: number }) {
      this.$emit('quizComplete', payload)
    },

    // ---- 对外命令 ----
    /** 播放笔顺动画。 */
    play() {
      // #ifdef MP-WEIXIN
      this.mpContext?.play()
      // #endif
      // #ifndef MP-WEIXIN
      this.cmd = 'animate'
      this.rev++
      // #endif
    },
    /** 开始书写测验。 */
    startQuiz() {
      // #ifdef MP-WEIXIN
      this.mpContext?.startQuiz()
      // #endif
      // #ifndef MP-WEIXIN
      this.cmd = 'quiz'
      this.rev++
      // #endif
    },
    /** 清空重写（按当前配置重建）。 */
    reset() {
      // #ifdef MP-WEIXIN
      this.mpSetup()
      // #endif
      // #ifndef MP-WEIXIN
      this.cmd = 'reset'
      this.rev++
      // #endif
    },

    // ---- mp-weixin 分支 ----
    // #ifdef MP-WEIXIN
    /** 初始化 canvas 尺寸并构建桥接上下文（首次装载自动演示/开判）。 */
    async initMpBoard() {
      try {
        this.boardSize = await this.measureBoardSize()
        // 尺寸查询为异步：期间组件可能已卸载，防 writer 泄漏到已卸载 scope。
        if (this.mpDestroyed) return
        const canvasInfo = await this.getCanvasNode()
        if (this.mpDestroyed) return
        console.log('[hanzi-mp] init: scope=', !!this.$scope, 'size=', this.boardSize, 'char=', this.char)
        this.mpContext = createBoardContext(this.buildViewShim(canvasInfo), {
          mode: this.mode,
          autoPlay: this.autoPlay,
          leniency: this.leniency,
          hintAfterMisses: this.hintAfterMisses,
          getCharData: getHanziData,
          onReady: () => this.$emit('ready'),
          onDataMissing: () => this.$emit('dataMissing'),
          onStrokeResult: (payload) => this.$emit('strokeResult', payload),
          onQuizComplete: (payload) => this.$emit('quizComplete', payload),
        })
        this.mpSetup()
      } catch (err) {
        // 初始化任何异常统一降级为无书写入口，不允许静默白板。
        console.error('[hanzi-mp] 初始化失败', err)
        this.$emit('dataMissing')
      }
    },

    /** 重建当前字的 writer（换字/换模式/重写共用）。 */
    mpSetup() {
      this.mpContext?.setup(this.char)
    },

    /** $scope（原生组件实例）+ 本地尺寸 + canvas 2d node 组装视图层桩。 */
    buildViewShim(canvasInfo: { node: unknown; width: number; height: number }) {
      const scope = (this as { $scope?: { selectComponent(sel: string): unknown; createSelectorQuery(): unknown } }).$scope
      const size = this.boardSize
      return {
        scope,
        data: { width: size, height: size },
        canvas: canvasInfo,
        selectComponent: (selector: string) => scope?.selectComponent(selector),
        createSelectorQuery: () =>
          scope?.createSelectorQuery() ?? uni.createSelectorQuery().in(this),
      }
    },

    /** 获取 canvas 2d node（同层渲染，逻辑尺寸与 boardSize 对齐）。 */
    getCanvasNode(): Promise<{ node: unknown; width: number; height: number; selector: string }> {
      const size = this.boardSize
      const selector = `#${this.canvasId}`
      return new Promise((resolve, reject) => {
        uni
          .createSelectorQuery()
          .in(this)
          .select(selector)
          .fields({ node: true, size: true }, (res: { node?: unknown; width?: number } | null) => {
            if (res && res.node) {
              resolve({ node: res.node, width: size, height: size, selector })
            } else {
              reject(new Error('[hanzi-writer-mp] canvas 2d node 获取失败'))
            }
          })
          .exec()
      })
    },

    /** 画板实际渲染宽度（px）；布局未就绪时按 rpx 兜底换算。 */
    measureBoardSize(): Promise<number> {
      return new Promise((resolve) => {
        uni
          .createSelectorQuery()
          .in(this)
          .select('.hw-board')
          .boundingClientRect((rect) => {
            const width = rect && (rect as { width?: number }).width
            resolve(width && width > 0 ? Math.floor(width) : uni.upx2px(MP_FALLBACK_SIZE_RPX))
          })
          .exec()
      })
    },

    /** 触屏事件 → hanzi-writer 指针事件。 */
    onTouch(touchEventName: string, evt: unknown) {
      const pointerEvent = pointerEventFor(touchEventName)
      if (pointerEvent) {
        this.mpContext?.trigger(pointerEvent, evt)
      }
    },
    // #endif
  },
}
</script>

<!-- 视图层：直接驱动 Hanzi Writer（H5 / app-vue / mp-weixin 三端经 renderjs 编译）。 -->
<script module="hw" lang="renderjs">
import HanziWriter from 'hanzi-writer'
import { getHanziData } from '@/hanzi-data'

const CREATE_OPTIONS = {
  strokeAnimationSpeed: 1.2,
  delayBetweenStrokes: 700,
  strokeColor: '#1F2937',
  outlineColor: '#E5E7EB',
  drawingColor: '#4CAF7A',
  drawingWidth: 4,
  highlightColor: '#FFB43D',
}

export default {
  data() {
    return {
      writer: null,
      currentChar: '',
      config: { mode: 'animation', autoPlay: true, leniency: 1.6, hint: 2 },
    }
  },

  beforeUnmount() {
    this.teardown()
  },

  methods: {
    teardown() {
      if (this.writer) {
        try {
          this.writer.cleanup()
        } catch (e) {
          // 实例可能已被页面销毁，忽略清理异常。
        }
        this.writer = null
      }
    },

    onSpecChange(spec, oldVal, ownerInstance) {
      this.config = {
        mode: spec.mode,
        autoPlay: spec.autoPlay,
        leniency: spec.leniency,
        hint: spec.hint,
      }

      if (spec.char !== this.currentChar) {
        this.currentChar = spec.char
        this.setup(spec.char)
        return
      }

      if (!spec.cmd) return
      if (spec.cmd === 'setup' || spec.cmd === 'reset') {
        this.setup(this.currentChar)
      } else if (spec.cmd === 'animate') {
        if (this.writer) this.writer.animateCharacter()
      } else if (spec.cmd === 'quiz') {
        this.startQuiz()
      }
    },

    setup(char) {
      this.teardown()
      const host = this.resolveHost()
      if (!host || !char) return

      const data = getHanziData(char)
      if (!data) {
        this.callOwner('__onDataMissing')
        return
      }

      const size = host.clientWidth || 320
      const writer = HanziWriter.create(host, char, {
        ...CREATE_OPTIONS,
        width: size,
        height: size,
        padding: 8,
        showOutline: true,
        showCharacter: false,
        charDataLoader: (loadedChar, onComplete) => {
          onComplete(data)
        },
      })
      this.writer = writer
      this.callOwner('__onReady')

      if (this.config.mode === 'quiz') {
        this.startQuiz()
      } else if (this.config.autoPlay) {
        writer.animateCharacter()
      }
    },

    startQuiz() {
      if (!this.writer) return
      this.writer.cancelQuiz()
      this.writer.quiz({
        leniency: this.config.leniency,
        showHintAfterMisses: this.config.hint,
        onMistake: (strokeData) => {
          this.callOwner('__onStrokeResult', {
            type: 'mistake',
            strokeNum: strokeData.strokeNum,
            mistakesOnStroke: strokeData.mistakesOnStroke,
          })
        },
        onCorrectStroke: (strokeData) => {
          this.callOwner('__onStrokeResult', {
            type: 'correct',
            strokeNum: strokeData.strokeNum,
          })
        },
        onComplete: (data) => {
          this.callOwner('__onQuizComplete', { totalMistakes: data.totalMistakes })
        },
      })
    },

    callOwner(method, args) {
      const owner = this.$ownerInstance
      if (owner) {
        owner.callMethod(method, args)
      }
    },

    resolveHost() {
      const ref = this.$refs && this.$refs.host
      if (!ref) return null
      // H5/app-vue 视图层可能返回元素数组。
      return Array.isArray(ref) ? ref[0] : ref
    },
  },
}
</script>

<style scoped lang="scss">
.hw-board {
  width: 100%;
  aspect-ratio: 1 / 1;
  /* 田字格背景：外框 + 横竖中线。 */
  border: 3rpx solid #d1d5db;
  border-radius: $learnly-radius-sm;
  background:
    linear-gradient(to right, transparent calc(50% - 1rpx), #e5e7eb calc(50% - 1rpx), #e5e7eb calc(50% + 1rpx), transparent calc(50% + 1rpx)),
    linear-gradient(to bottom, transparent calc(50% - 1rpx), #e5e7eb calc(50% - 1rpx), #e5e7eb calc(50% + 1rpx), transparent calc(50% + 1rpx)),
    #fff;
  overflow: hidden;
}
/* #ifdef MP-WEIXIN */
/* 小程序部分基础库不支持 aspect-ratio，给固定高度兜底。 */
.hw-board {
  height: 560rpx;
}
/* #endif */
.hw-host {
  width: 100%;
  height: 100%;
  touch-action: none;
}
</style>
