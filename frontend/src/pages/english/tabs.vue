<template>
  <view class="container">
    <view class="hero">
      <text class="title">英语字母表</text>
      <text class="subtitle">点一个字母，去学它的笔顺和读音吧</text>
    </view>

    <!-- 26 字母页签 -->
    <view class="tabs">
      <view
        v-for="letter in LETTERS"
        :key="letter"
        class="tab-chip"
        @tap="goList(letter)"
      >
        <text class="chip-upper">{{ letter }}</text>
        <text class="chip-lower">{{ toLowerLetter(letter) }}</text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { LETTERS, toLowerLetter } from '@/utils/english'

/** 页签 → 字母列表（锚定所选字母；v1 无登录守卫，静态集合无进度上报）。 */
function goList(letter: string) {
  uni.navigateTo({ url: `/pages/english/list?focus=${letter}` })
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
  font-size: 52rpx;
  font-weight: 800;
  color: $learnly-text;
}
.subtitle {
  display: block;
  margin-top: 12rpx;
  font-size: 26rpx;
  color: $learnly-text-light;
}
.tabs {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 24rpx;
}
.tab-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28rpx 0 20rpx;
  background: #fff;
  border-radius: $learnly-radius-lg;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
}
.chip-upper {
  font-size: 64rpx;
  font-weight: 800;
  line-height: 1.2;
  color: $learnly-primary;
}
.chip-lower {
  font-size: 40rpx;
  font-weight: 700;
  color: $learnly-text-light;
}
</style>
