<template>
  <!-- 字帖卡（img.png 样式）：大写+小写并排共享一条四线三格，每笔带
       行笔方向箭头 + 起笔序号。几何由 letter-copybook-model 输出，
       本组件只做三端绘制（H5 SVG / mp canvas）。绘制异常整区隐藏。 -->
  <view v-if="!renderBroken && glyphs.length > 0" class="copybook" :style="copybookStyle">
    <!-- #ifdef MP-WEIXIN -->
    <canvas v-if="isMpWeixin" :id="canvasId" type="2d" class="copybook-canvas" :style="mpCanvasStyle" />
    <!-- #endif -->
    <!-- #ifndef MP-WEIXIN -->
    <view v-if="!isMpWeixin" class="copybook-svg" v-html="svgHtml" />
    <!-- #endif -->
  </view>
</template>

<script lang="ts">
// @ts-nocheck
// 组件走 options API + 条件编译分支（同 stroke-strip 模式）；契约由模型对象收敛。
import { getLetterData } from '@/hanzi-letter-data'
import { toLowerLetter, toUpperLetter } from '@/utils/english'
import {
  buildCopybookGlyph,
  parsePath,
  COPYBOOK,
  COPYBOOK_LABEL_FONT,
  type CopybookGlyph,
} from './letter-copybook-model'

/** 视觉常量：字形描边填充 + 深色箭头/序号（中心线箭头压在实心字上不可见，故字形用浅底描边）。 */
const GLYPH_FILL = '#F3F4F6'
const GLYPH_STROKE = '#4B5563'
const GLYPH_STROKE_W = 6
const MARK_COLOR = '#1F2937'
const ARROW_STROKE_W = 10

/** mp 端实测失败时的宽度兜底（rpx，≈详情页内容宽 686rpx - 字帖卡内边距 48rpx）。 */
const MP_FALLBACK_WIDTH_RPX = 638

let copybookInstanceCount = 0

export default {
  props: {
    /** 大写字母（'A'–'Z'），大小写并排展示。 */
    letter: { type: String, required: true },
  },

  data() {
    return {
      isMpWeixin: false,
      /** mp 端实测内容宽（px），0 = 未就绪。 */
      widthPx: 0,
      renderBroken: false,
      canvasId: 'copybook-canvas',
      redrawSeq: 0,
      mpTornDown: false,
    }
  },

  created() {
    // #ifdef MP-WEIXIN
    this.isMpWeixin = true
    this.canvasId = `copybook-canvas-${++copybookInstanceCount}`
    // #endif
  },

  computed: {
    /** 有数据的字形并排（大写在前）；单个缺失时可用侧独占整条四线格。 */
    glyphs(): Array<{ glyph: CopybookGlyph; offsetX: number }> {
      const upper = getLetterData(toUpperLetter(this.letter))
      const lower = getLetterData(toLowerLetter(this.letter))
      return [upper, lower]
        .filter((data) => data !== null)
        .map((data, i) => ({ glyph: buildCopybookGlyph(data, i * COPYBOOK.FRAME)!, offsetX: i * COPYBOOK.FRAME }))
        .filter((entry) => entry.glyph !== null)
    },

    /** 幅面总宽（数据空间）：字形数 × 半格宽。 */
    frameWidth(): number {
      return COPYBOOK.FRAME * this.glyphs.length
    },

    copybookStyle(): Record<string, string> {
      // 幅面比例随字形数变化（1 字 1024/1124、2 字 2048/1124），内联下发；
      // mp 基础库不支持 aspect-ratio，再叠加实测高度兜底。
      const style: Record<string, string> = {
        'aspect-ratio': `${this.frameWidth} / ${COPYBOOK.HEIGHT}`,
      }
      if (this.isMpWeixin && this.widthPx > 0) {
        style.height = this.mpHeightPx + 'px'
      }
      return style
    },

    mpCanvasStyle(): Record<string, string> {
      if (this.widthPx > 0) {
        return { width: this.widthPx + 'px', height: this.mpHeightPx + 'px' }
      }
      return {}
    },

    mpHeightPx(): number {
      return Math.round((this.widthPx * COPYBOOK.HEIGHT) / this.frameWidth)
    },

    /** H5/app：整条字帖 SVG（数据为构建期内嵌本地字库，无用户输入）。 */
    svgHtml(): string {
      const glyphSvg = this.glyphs
        .map(
          ({ glyph, offsetX }) =>
            `<g transform="translate(${offsetX} ${COPYBOOK.PAD_TOP + 900}) scale(1 -1)">` +
            glyph.paths
              .map((d) => `<path d="${d}" fill="${GLYPH_FILL}" stroke="${GLYPH_STROKE}" stroke-width="${GLYPH_STROKE_W}"/>`)
              .join('') +
            '</g>',
        )
        .join('')
      const markSvg = this.glyphs
        .flatMap(({ glyph }) => glyph.marks)
        .map((mark) => {
          const shaft = `<polyline points="${mark.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${MARK_COLOR}" stroke-width="${ARROW_STROKE_W}" stroke-linecap="round" stroke-linejoin="round"/>`
          const arrow = mark.arrow
            ? `<polygon points="${[mark.arrow.tip, mark.arrow.left, mark.arrow.right].map((p) => `${p.x},${p.y}`).join(' ')}" fill="${MARK_COLOR}"/>`
            : ''
          const label = `<text x="${mark.label.x}" y="${mark.label.y}" font-size="${COPYBOOK_LABEL_FONT}" font-weight="700" fill="${MARK_COLOR}" text-anchor="middle" dominant-baseline="central">${mark.num}</text>`
          return shaft + arrow + label
        })
        .join('')
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.frameWidth} ${COPYBOOK.HEIGHT}">${glyphSvg}${markSvg}</svg>`
    },
  },

  watch: {
    letter() {
      if (this.isMpWeixin) {
        this.redrawMp()
      }
    },
  },

  beforeUnmount() {
    this.mpTornDown = true
  },

  mounted() {
    if (this.isMpWeixin) {
      this.redrawMp()
    }
  },

  methods: {
    // ---- mp-weixin：静态绘制（同 stroke-strip 模式）----
    async redrawMp() {
      const seq = ++this.redrawSeq
      try {
        let width = await this.measureWidth()
        if (width <= 0) {
          width = uni.upx2px(MP_FALLBACK_WIDTH_RPX)
        }
        const inner = Math.floor(width) - uni.upx2px(4)
        if (inner <= 0) return
        this.widthPx = inner
        await this.$nextTick?.()
        for (let attempt = 0; attempt < 5; attempt += 1) {
          if (this.mpTornDown || seq !== this.redrawSeq) return
          const nodeInfo = await this.getCanvasNode()
          if (!nodeInfo) {
            await this.delay(50)
            continue
          }
          this.draw(nodeInfo.node)
          return
        }
      } catch (err) {
        console.error('[letter-copybook] mp 绘制失败，整区隐藏', err)
        this.renderBroken = true
      }
    },

    measureWidth(): Promise<number> {
      return new Promise((resolve) => {
        uni
          .createSelectorQuery()
          .in(this)
          .select('.copybook')
          .boundingClientRect((rect) => {
            resolve((rect as { width?: number } | null)?.width ?? 0)
          })
          .exec()
      })
    },

    getCanvasNode(): Promise<{ node: unknown } | null> {
      return new Promise((resolve) => {
        uni
          .createSelectorQuery()
          .in(this)
          .select(`#${this.canvasId}`)
          .fields({ node: true }, (res) => {
            const info = res as { node?: unknown } | null
            resolve(info && info.node ? { node: info.node } : null)
          })
          .exec()
      })
    },

    delay(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms))
    },

    /** 指令式绘制整条字帖（dpr 高清适配；坐标系与 H5 SVG 同一模型输出）。 */
    draw(node: { width: number; height: number; getContext(kind: '2d'): CanvasRenderingContext2D | null }) {
      const dpr = uni.getSystemInfoSync().pixelRatio || 1
      const w = this.widthPx
      const h = this.mpHeightPx
      node.width = w * dpr
      node.height = h * dpr
      const ctx = node.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)
      const k = w / this.frameWidth
      const toPx = (p: { x: number; y: number }) => ({ x: p.x * k, y: p.y * k })

      // 字形：浅底描边（翻转 y_s = PAD_TOP + 900 - y_data）。
      for (const { glyph, offsetX } of this.glyphs) {
        for (const d of glyph.paths) {
          ctx.beginPath()
          for (const { cmd, params } of parsePath(d)) {
            const px = (x: number) => (x + offsetX) * k
            const py = (y: number) => (COPYBOOK.PAD_TOP + 900 - y) * k
            if (cmd === 'M') ctx.moveTo(px(params[0]), py(params[1]))
            else if (cmd === 'L') ctx.lineTo(px(params[0]), py(params[1]))
            else if (cmd === 'Q') ctx.quadraticCurveTo(px(params[0]), py(params[1]), px(params[2]), py(params[3]))
            else if (cmd === 'C') ctx.bezierCurveTo(px(params[0]), py(params[1]), px(params[2]), py(params[3]), px(params[4]), py(params[5]))
            else if (cmd === 'Z') ctx.closePath()
          }
          ctx.fillStyle = GLYPH_FILL
          ctx.fill()
          ctx.strokeStyle = GLYPH_STROKE
          ctx.lineWidth = GLYPH_STROKE_W * k
          ctx.stroke()
        }
      }

      // 箭杆 + 箭头 + 序号（模型输出的屏幕坐标直接缩放）。
      ctx.strokeStyle = MARK_COLOR
      ctx.fillStyle = MARK_COLOR
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const { glyph } of this.glyphs) {
        for (const mark of glyph.marks) {
          ctx.beginPath()
          mark.points.forEach((p, i) => {
            const { x, y } = toPx(p)
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          })
          ctx.lineWidth = ARROW_STROKE_W * k
          ctx.stroke()
          if (mark.arrow) {
            ctx.beginPath()
            ;[mark.arrow.tip, mark.arrow.left, mark.arrow.right].forEach((p, i) => {
              const { x, y } = toPx(p)
              if (i === 0) ctx.moveTo(x, y)
              else ctx.lineTo(x, y)
            })
            ctx.closePath()
            ctx.fill()
          }
          const { x, y } = toPx(mark.label)
          ctx.font = `700 ${COPYBOOK_LABEL_FONT * k}px sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(mark.num), x, y)
        }
      }
    },
  },
}
</script>

<style scoped lang="scss">
.copybook {
  position: relative;
  width: 100%;
  /* 幅面比例内联下发（随字形数变化），见 copybookStyle。 */
  border: 2rpx solid $learnly-border;
  border-radius: $learnly-radius-sm;
  background:
    linear-gradient(to bottom, transparent calc(100% * 0.1192149 - 1rpx), $learnly-border calc(100% * 0.1192149 - 1rpx), $learnly-border calc(100% * 0.1192149 + 1rpx), transparent calc(100% * 0.1192149 + 1rpx)),
    linear-gradient(to bottom, transparent calc(100% * 0.4030249 - 1rpx), $learnly-border calc(100% * 0.4030249 - 1rpx), $learnly-border calc(100% * 0.4030249 + 1rpx), transparent calc(100% * 0.4030249 + 1rpx)),
    linear-gradient(to bottom, transparent calc(100% * 0.6859431 - 1rpx), $learnly-border calc(100% * 0.6859431 - 1rpx), $learnly-border calc(100% * 0.6859431 + 1rpx), transparent calc(100% * 0.6859431 + 1rpx)),
    linear-gradient(to bottom, transparent calc(100% * 0.9697156 - 1rpx), $learnly-border calc(100% * 0.9697156 - 1rpx), $learnly-border calc(100% * 0.9697156 + 1rpx), transparent calc(100% * 0.9697156 + 1rpx)),
    $learnly-surface;
  overflow: hidden;
}
/* #ifdef MP-WEIXIN */
.copybook-canvas {
  display: block;
}
/* #endif */
.copybook-svg :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
