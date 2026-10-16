<template>
  <!-- #ifdef MP-WEIXIN -->
  <image class="l-mascot" :src="dataUrl" :style="sizeStyle" mode="aspectFit" />
  <!-- #endif -->
  <!-- #ifndef MP-WEIXIN -->
  <view class="l-mascot" :style="sizeStyle" v-html="inlineSvg" />
  <!-- #endif -->
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { mascotSvg } from './mascot-svg'

const props = withDefaults(
  defineProps<{ size?: number; variant?: 'duo' | 'mono'; color?: string }>(),
  { size: 96, variant: 'duo', color: '' },
)

const sizeStyle = computed(() => ({ width: `${props.size}rpx`, height: `${props.size}rpx` }))
const inlineSvg = computed(() => mascotSvg({ variant: props.variant, color: props.color || undefined }))
const dataUrl = computed(
  () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(inlineSvg.value)}`,
)
</script>

<style scoped lang="scss">
.l-mascot {
  display: inline-block;
  flex-shrink: 0;
}
</style>
