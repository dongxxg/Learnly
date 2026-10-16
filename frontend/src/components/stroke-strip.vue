<template>
  <!-- 拆解区（design D13）：总笔画标题 + 逐笔拆解格。
       strokeNames 缺失/长度不符时 tiles 为空、mp 绘制异常时 renderBroken，
       两种情况整区隐藏（spec 降级，不渲染半残、不弹错误）。 -->
  <view v-if="tiles.length > 0 && !renderBroken" class="stroke-strip">
    <text class="strip-title">总笔画{{ tiles.length }}笔：</text>
    <view class="strip-grid">
      <view v-for="tile in tiles" :key="tile.num" class="strip-cell">
        <!-- mp：正方形格子由外层 cell-box 撑起（position:relative 包含块），canvas 绝对定位填充。
             不可把 cell-box 直接挂在 canvas 上：cell-canvas 的 absolute 在无定位祖先时
             包含块上浮到页面根，padding-bottom:100% 按页宽解析，
             canvas 会飞到页首拉成竖条盖住整页。 -->
        <!-- #ifdef MP-WEIXIN -->
        <view v-if="isMpWeixin" class="cell-box">
          <canvas :id="canvasId(tile.num)" type="2d" class="cell-canvas" :style="mpCanvasStyle" />
        </view>
        <!-- #endif -->
        <!-- #ifndef MP-WEIXIN -->
        <view v-if="!isMpWeixin" class="cell-box cell-svg-host" v-html="tileSvg(tile)" />
        <!-- #endif -->
        <text class="cell-label">{{ tile.num }}.{{ tile.name }}</text>
      </view>
    </view>
  </view>
</template>

<script lang="ts">
/**
 * 笔顺拆解条（design D13）：第 k 格呈现已写笔（黑）+ 当前笔（红）+ 未写笔（浅灰幽灵），
 * 格下标注「N.笔画名」。只读静态组件，不复用 hanzi-writer-board（无动画/判定需求）。
 *
 * - H5 / app-vue：v-html 注入内联 SVG（数据为构建期内嵌本地字库，无用户输入）。
 * - mp-weixin：每格 canvas 2d 指令式绘制（无 Path2D，复用 stroke-tiles.parsePath）；
 *   y 轴翻转与 SVG 同变换：y_screen = 900 - y_data（数据空间 y∈[-124,900]）。
 */
import { getHanziData } from '@/hanzi-data'
import { buildStrokeTiles, parsePath, TILE_COLORS, type StrokeTile } from './stroke-tiles'

/** cell 宽占比，与样式 .strip-cell{width:18%} 同源（5 列，参考 笔顺.jpg）。 */
const CELL_WIDTH_RATIO = 0.18

/** mp 端 grid 宽度实测失败时的 cell 边长兜底（rpx，≈内容宽 638rpx × 0.18）。 */
const MP_FALLBACK_CELL_RPX = 115

/** mp 端 cell 画布 id 实例级唯一（同页可能与演示/书写板共存）。 */
let stripInstanceCount = 0

export default {
  props: {
    char: { type: String, required: true },
  },
  data() {
    return {
      isMpWeixin: false,
      /** mp 端实测 cell 逻辑边长（px），0 = 未就绪。 */
      cellPx: 0,
      instanceSeq: 0,
      mpTornDown: false,
      /** mp 绘制链路异常 → 整区隐藏（同 spec 数据降级，不渲染半残）。 */
      renderBroken: false,
      /** redraw 令牌：char 热切换时作废在-flight 绘制循环。 */
      redrawSeq: 0,
    }
  },

  created() {
    // #ifdef MP-WEIXIN
    this.isMpWeixin = true
    // #endif
    this.instanceSeq = ++stripInstanceCount
  },

  computed: {
    tiles(): StrokeTile[] {
      return buildStrokeTiles(getHanziData(this.char) ?? { strokes: [], medians: [] })
    },
    mpCanvasStyle(): Record<string, string> {
      return this.cellPx > 0 ? { width: this.cellPx + 'px', height: this.cellPx + 'px' } : {}
    },
  },

  watch: {
    char() {
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
    /** H5/app：整格 SVG（田字格为容器 CSS 背景；y 轴翻转映射数据空间）。 */
    tileSvg(tile: StrokeTile) {
      const paths = tile.paths
        .map((p) => `<path d="${p.d}" fill="${TILE_COLORS[p.tone]}"/>`)
        .join('')
      return `<svg viewBox="0 0 1024 1024"><g transform="translate(0 900) scale(1 -1)">${paths}</g></svg>`
    },

    canvasId(num: number) {
      return `stroke-strip-${this.instanceSeq}-cell-${num}`
    },

    // ---- mp-weixin：静态绘制 ----
    /** 任何绘制链路异常 → renderBroken 整区隐藏；禁止标题+标签的半残渲染。 */
    async redrawMp() {
      const seq = ++this.redrawSeq
      try {
        let gridWidth = await this.measureGridWidth()
        if (gridWidth <= 0) {
          // 实测失败（布局未就绪等）按 rpx 兜底，对照 hanzi-writer-board 的做法。
          gridWidth = uni.upx2px(MP_FALLBACK_CELL_RPX) / CELL_WIDTH_RATIO
        }
        // 贴齐 CSS 内容区：盒宽 - 左右 2rpx 边框（upx2px 随屏宽换算）。
        const cell = Math.floor(gridWidth * CELL_WIDTH_RATIO) - uni.upx2px(4)
        if (cell <= 0) return
        this.cellPx = cell
        for (const tile of this.tiles) {
          // 异步间隙中组件可能已卸载或已换字：作废旧绘制循环。
          if (this.mpTornDown || seq !== this.redrawSeq) return
          const nodeInfo = await this.getCanvasNode(this.canvasId(tile.num))
          if (!nodeInfo) continue
          this.drawCell(nodeInfo.node as mpCanvasNode, tile, cell)
        }
      } catch (err) {
        console.error('[stroke-strip] mp 绘制失败，整区隐藏', err)
        this.renderBroken = true
      }
    },

    measureGridWidth(): Promise<number> {
      return new Promise((resolve) => {
        uni
          .createSelectorQuery()
          .in(this)
          .select('.strip-grid')
          .boundingClientRect((rect) => {
            resolve((rect as { width?: number } | null)?.width ?? 0)
          })
          .exec()
      })
    },

    getCanvasNode(id: string): Promise<{ node: unknown } | null> {
      return new Promise((resolve) => {
        uni
          .createSelectorQuery()
          .in(this)
          .select(`#${id}`)
          .fields({ node: true }, (res) => {
            const info = res as { node?: unknown } | null
            resolve(info && info.node ? { node: info.node } : null)
          })
          .exec()
      })
    },

    /** 指令式绘制一格（dpr 高清适配；y 翻转与 H5 SVG 同变换）。 */
    drawCell(node: mpCanvasNode, tile: StrokeTile, cell: number) {
      const dpr = uni.getSystemInfoSync().pixelRatio || 1
      node.width = cell * dpr
      node.height = cell * dpr
      const ctx = node.getContext('2d')
      if (!ctx) return
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, cell, cell)
      const k = cell / 1024
      for (const p of tile.paths) {
        ctx.fillStyle = TILE_COLORS[p.tone]
        ctx.beginPath()
        for (const { cmd, params } of parsePath(p.d)) {
          if (cmd === 'M') ctx.moveTo(params[0] * k, (900 - params[1]) * k)
          else if (cmd === 'L') ctx.lineTo(params[0] * k, (900 - params[1]) * k)
          else if (cmd === 'Q') ctx.quadraticCurveTo(params[0] * k, (900 - params[1]) * k, params[2] * k, (900 - params[3]) * k)
          else if (cmd === 'C') ctx.bezierCurveTo(params[0] * k, (900 - params[1]) * k, params[2] * k, (900 - params[3]) * k, params[4] * k, (900 - params[5]) * k)
          else if (cmd === 'Z') ctx.closePath()
        }
        ctx.fill()
      }
    },
  },
}

interface mpCanvasNode {
  width: number
  height: number
  getContext(kind: '2d'): CanvasRenderingContext2D | null
}
</script>

<style scoped lang="scss">
.stroke-strip {
  margin-top: 24rpx;
}
.strip-title {
  display: block;
  font-size: $learnly-fs-base;
  font-weight: 700;
  color: $learnly-text;
  margin-bottom: 16rpx;
}
.strip-grid {
  display: flex;
  flex-wrap: wrap;
  /* 挨着紧排、满行换行（列距 12rpx：5×18% + 4×12rpx = 622rpx < 638rpx 行宽，保住 5 列）；
     space-between 会把少笔画字（如九的 2 格）甩到行两端。 */
  gap: 16rpx 12rpx;
}
.strip-cell {
  width: 18%;
}
/* 田字格（与 hanzi-writer-board 同一渐变画法）+ padding-bottom 正方形兜底。 */
.cell-box {
  position: relative;
  width: 100%;
  height: 0;
  padding-bottom: 100%;
  border: 2rpx solid $learnly-border;
  border-radius: $learnly-radius-sm;
  background:
    linear-gradient(to right, transparent calc(50% - 1rpx), $learnly-border calc(50% - 1rpx), $learnly-border calc(50% + 1rpx), transparent calc(50% + 1rpx)),
    linear-gradient(to bottom, transparent calc(50% - 1rpx), $learnly-border calc(50% - 1rpx), $learnly-border calc(50% + 1rpx), transparent calc(50% + 1rpx)),
    $learnly-surface;
  overflow: hidden;
}
.cell-canvas {
  position: absolute;
  left: 0;
  top: 0;
}
.cell-svg-host :deep(svg) {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
}
.cell-label {
  display: block;
  text-align: center;
  font-size: $learnly-fs-sm;
  color: $learnly-text-light;
  margin-top: 6rpx;
}
</style>
