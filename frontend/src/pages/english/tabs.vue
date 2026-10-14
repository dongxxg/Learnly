<template>
  <view class="container">
    <view class="hero">
      <text class="title">知芽英语</text>
      <text class="subtitle">选一张卡片开始吧</text>
    </view>

    <!-- 卡片列表：英语字母表为第一张，其余为预留入口 -->
    <view class="card card-main" @tap="goAlphabet">
      <view class="glyph-pair">
        <text class="glyph upper">A</text>
        <text class="glyph lower">a</text>
      </view>
      <view class="card-text">
        <text class="card-title">英语字母表</text>
        <text class="card-sub">26 个字母的读音和笔顺</text>
      </view>
      <text class="card-chevron">›</text>
    </view>

    <view class="card-grid">
      <view v-for="card in COMING_CARDS" :key="card.title" class="card card-mini" @tap="comingSoon(card.title)">
        <text class="mini-emoji">{{ card.emoji }}</text>
        <text class="card-title small">{{ card.title }}</text>
        <view class="soon-badge">
          <text class="soon-text">敬请期待</text>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
/** 知芽英语首页（卡片列表）：第一张 = 英语字母表 → 26 字母排列 → 字母详情。 */
const COMING_CARDS = [
  { emoji: '📖', title: '每日一句' },
  { emoji: '🔤', title: '单词卡' },
] as const

function goAlphabet() {
  uni.navigateTo({ url: '/pages/english/list' })
}

function comingSoon(title: string) {
  uni.showToast({ title: `${title}，敬请期待`, icon: 'none' })
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
.card {
  background: #fff;
  border-radius: $learnly-radius-lg;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
}
.card-main {
  display: flex;
  align-items: center;
  gap: 32rpx;
  padding: 40rpx 32rpx;
}
.glyph-pair {
  display: flex;
  align-items: baseline;
  gap: 8rpx;
}
.glyph {
  font-weight: 800;
  line-height: 1.2;

  &.upper {
    font-size: 96rpx;
    color: $learnly-primary;
  }
  &.lower {
    font-size: 64rpx;
    color: $learnly-text;
  }
}
.card-text {
  flex: 1;
}
.card-title {
  display: block;
  font-size: 34rpx;
  font-weight: 700;
  color: $learnly-text;

  &.small {
    font-size: 30rpx;
  }
}
.card-sub {
  display: block;
  margin-top: 8rpx;
  font-size: 24rpx;
  color: $learnly-text-light;
}
.card-chevron {
  font-size: 48rpx;
  color: $learnly-text-light;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24rpx;
  margin-top: 24rpx;
}
.card-mini {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 36rpx 24rpx 28rpx;
}
.mini-emoji {
  font-size: 56rpx;
  line-height: 1.2;
}
.soon-badge {
  margin-top: 16rpx;
  padding: 4rpx 20rpx;
  background: $learnly-bg;
  border-radius: 999rpx;
}
.soon-text {
  font-size: 20rpx;
  color: $learnly-text-light;
}
</style>
