<template>
  <view class="container">
    <view class="hero">
      <text class="title">加减法口算</text>
      <text class="subtitle">选个难度，随机出题</text>
    </view>

    <!-- 难度卡片：点击即进入对应档位的口算练习 -->
    <view class="range-grid">
      <view v-for="r in MATH_RANGES" :key="r" class="range-card" @tap="goPractice(r)">
        <text class="range-value">{{ rangeLabel(r) }}</text>
        <text class="range-sub">得数不超过 {{ r }}</text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
/** 加减法难度选择：10/20/50/100/1000 以内五档，点击进入练习页。 */
import { MATH_RANGES, rangeLabel } from '@/utils/math'

function goPractice(range: number) {
  uni.navigateTo({ url: `/pages/math/practice?range=${range}` })
}
</script>

<style scoped lang="scss">
.container {
  padding: 48rpx 32rpx;
  min-height: 100vh;
}
.hero {
  text-align: center;
  margin-bottom: 48rpx;
}
.title {
  display: block;
  font-size: $learnly-fs-xl;
  font-weight: 800;
  color: $learnly-text;
}
.subtitle {
  display: block;
  margin-top: 12rpx;
  font-size: $learnly-fs-base;
  color: $learnly-text-light;
}
.range-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24rpx;
}
.range-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 44rpx 24rpx 36rpx;
  background: $learnly-surface;
  border-radius: $learnly-radius-lg;
  box-shadow: $learnly-shadow-sm;
}
.range-value {
  font-size: 44rpx;
  font-weight: 800;
  color: $learnly-primary;
}
.range-sub {
  margin-top: 12rpx;
  font-size: $learnly-fs-sm;
  color: $learnly-text-light;
}
</style>
