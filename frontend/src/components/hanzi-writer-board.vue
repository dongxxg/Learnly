<!-- eslint-disable vue/no-mutating-props -->
<template>
  <view class="hw-board">
    <view
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
 * 田字格书写画板（renderjs 封装 Hanzi Writer，design D8）。
 *
 * - 逻辑层不碰 DOM：一切配置与命令经 spec prop 下发给视图层（renderjs），
 *   结果经 __on* 回调转发为组件事件（app-vue 逻辑层无法操作 DOM/SVG）。
 * - 笔顺判定严格保序保向（quiz 默认行为）；空间容差 leniency 放宽适配儿童；
 *   同一笔连错 hintAfterMisses 次后显示提示轨迹。
 * - 无笔顺数据时触发 dataMissing，页面按 spec 降级隐藏演示与书写入口。
 */
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
    }
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
      this.cmd = 'setup'
      this.rev++
    },
    mode() {
      this.cmd = 'setup'
      this.rev++
    },
  },

  mounted() {
    // 首个 spec 由 mounted 后的首次渲染下发，cmd 已是 setup。
  },

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
      this.cmd = 'animate'
      this.rev++
    },
    /** 开始书写测验。 */
    startQuiz() {
      this.cmd = 'quiz'
      this.rev++
    },
    /** 清空重写（按当前配置重建）。 */
    reset() {
      this.cmd = 'reset'
      this.rev++
    },
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
