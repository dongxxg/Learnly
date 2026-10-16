<template>
  <view class="l-page-header">
    <text class="l-page-header__title">{{ title }}</text>
    <text v-if="subtitle || $slots.default" class="l-page-header__subtitle">
      <slot>{{ subtitle }}</slot>
    </text>
  </view>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ title: string; subtitle?: string }>(), { subtitle: '' })
</script>

<style scoped lang="scss">
.l-page-header {
  text-align: center;
  padding: 48rpx 0 40rpx;
}
.l-page-header__title {
  display: block;
  font-size: $learnly-fs-3xl;
  font-weight: 800;
  color: $learnly-text;
}
.l-page-header__subtitle {
  display: block;
  margin-top: 12rpx;
  font-size: $learnly-fs-sm;
  color: $learnly-text-light;
}
</style>
