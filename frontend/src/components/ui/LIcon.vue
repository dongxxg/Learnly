<template>
  <!-- #ifdef MP-WEIXIN -->
  <image class="l-icon" :src="dataUrl" :style="sizeStyle" mode="aspectFit" />
  <!-- #endif -->
  <!-- #ifndef MP-WEIXIN -->
  <view class="l-icon" :style="sizeStyle" v-html="inlineSvg" />
  <!-- #endif -->
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { iconSvg, svgDataUrl } from './icons'

// 默认色与令牌 $learnly-text 同值（TS 侧无法引用 SCSS，改色需同步此处）
const DEFAULT_COLOR = '#1F2937'

const props = withDefaults(
  defineProps<{ name: string; size?: number; color?: string }>(),
  { size: 48, color: DEFAULT_COLOR },
)

const sizeStyle = computed(() => ({ width: `${props.size}rpx`, height: `${props.size}rpx` }))
const inlineSvg = computed(() => iconSvg(props.name, props.color))
const dataUrl = computed(() => svgDataUrl(props.name, props.color))
</script>

<style scoped lang="scss">
.l-icon {
  display: inline-block;
  flex-shrink: 0;
}
</style>
