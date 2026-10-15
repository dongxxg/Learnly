<template>
  <view class="container">
    <view class="hero">
      <text class="title">知芽数学</text>
      <text class="subtitle">选一张卡片开始吧</text>
    </view>

    <!-- 卡片列表：加减法为第一张，其余为预留入口 -->
    <view class="card card-main" @tap="goArithmetic">
      <view class="glyph-pair">
        <text class="glyph plus">＋</text>
        <text class="glyph minus">－</text>
      </view>
      <view class="card-text">
        <text class="card-title">加减法</text>
        <text class="card-sub">10～1000 以内的口算练习</text>
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
/** 知芽数学首页（卡片列表）：第一张 = 加减法 → 难度选择 → 口算练习。 */
const COMING_CARDS = [
  { emoji: '🔺', title: '认图形' },
  { emoji: '⚖️', title: '比大小' },
] as const

function goArithmetic() {
  uni.navigateTo({ url: '/pages/math/ranges' })
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

  &.plus {
    font-size: 88rpx;
    color: $learnly-primary;
  }
  &.minus {
    font-size: 64rpx;
    color: $learnly-secondary;
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
