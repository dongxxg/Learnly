<template>
  <view class="container">
    <view class="hero">
      <text class="title">知芽汉语</text>
      <text class="subtitle">选一张卡片开始吧</text>
    </view>

    <!-- 识字：原首页"知芽识字"入口，登录守卫随卡片迁移至此 -->
    <view class="card card-row" @tap="goLiteracy">
      <view class="glyph-box">
        <text class="glyph">字</text>
      </view>
      <view class="card-text">
        <text class="card-title">识字</text>
        <text class="card-sub">汉字学习与笔顺拆解</text>
      </view>
      <text class="card-chevron">›</text>
    </view>

    <!-- 古诗背诵：收录小学必背古诗，静态数据 -->
    <view class="card card-row" @tap="goPoem">
      <view class="glyph-box alt">
        <text class="glyph">诗</text>
      </view>
      <view class="card-text">
        <text class="card-title">古诗背诵</text>
        <text class="card-sub">收录小学必背古诗 {{ POEM_COUNT }} 首</text>
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
import { POEM_COUNT } from '@/utils/poems'
import { useAuthStore } from '@/stores/auth'

/** 知芽汉语首页（卡片列表）：识字 → 字库列表 → 汉字详情；古诗背诵 → 诗列表 → 诗详情。 */
const COMING_CARDS = [
  { emoji: '📖', title: '成语故事' },
  { emoji: '🔤', title: '拼音启蒙' },
] as const

const authStore = useAuthStore()

function goLiteracy() {
  // 登录守卫：未登录去登录页；未选儿童去档案页；否则进字库列表。
  if (!authStore.isLoggedIn) {
    uni.navigateTo({ url: '/pages/auth/login' })
    return
  }
  if (!authStore.hasChild) {
    uni.navigateTo({ url: '/pages/auth/profiles' })
    return
  }
  uni.navigateTo({ url: '/pages/literacy/list' })
}

function goPoem() {
  uni.navigateTo({ url: '/pages/poem/list' })
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
.card {
  background: $learnly-surface;
  border-radius: $learnly-radius-lg;
  box-shadow: $learnly-shadow-sm;
}
.card-row {
  display: flex;
  align-items: center;
  gap: 32rpx;
  padding: 40rpx 32rpx;

  & + .card-row {
    margin-top: 24rpx;
  }
}
.glyph-box {
  width: 96rpx;
  height: 96rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: $learnly-radius-md;
  background: rgba($learnly-primary, 0.12);

  &.alt {
    background: $learnly-secondary-soft;
  }
}
.glyph {
  font-size: $learnly-fs-xl;
  font-weight: 800;
  color: $learnly-primary;

  .alt & {
    color: $learnly-warning;
  }
}
.card-text {
  flex: 1;
}
.card-title {
  display: block;
  font-size: $learnly-fs-lg;
  font-weight: 700;
  color: $learnly-text;

  &.small {
    font-size: $learnly-fs-md;
  }
}
.card-sub {
  display: block;
  margin-top: 8rpx;
  font-size: $learnly-fs-sm;
  color: $learnly-text-light;
}
.card-chevron {
  font-size: $learnly-fs-xl;
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
  font-size: $learnly-fs-3xl;
  line-height: 1.2;
}
.soon-badge {
  margin-top: 16rpx;
  padding: 4rpx 20rpx;
  background: $learnly-bg;
  border-radius: 999rpx;
}
.soon-text {
  font-size: $learnly-fs-xs;
  color: $learnly-text-light;
}
</style>
