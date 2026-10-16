<template>
  <view class="container">
    <!-- 登录卡：未登录=点击登录占位（不发请求，无 401 兜底可言）；已登录=家长身份 -->
    <view class="card card-user" @tap="onUserCard">
      <view class="avatar">
        <text class="avatar-glyph">家</text>
      </view>
      <view class="user-text">
        <text class="user-name">{{ isLoggedIn ? parentName : '点击登录' }}</text>
        <text class="user-sub">{{ isLoggedIn ? '知芽家长中心' : '登录后同步学习进度' }}</text>
      </view>
      <text v-if="!isLoggedIn" class="card-chevron">›</text>
    </view>

    <!-- 当前儿童卡：已登录才展示，切换复用 profiles 页（switchChild 会换发 JWT 并重置识字缓存） -->
    <view v-if="isLoggedIn" class="card card-child">
      <view class="child-left">
        <view class="child-avatar">
          <text class="child-glyph">{{ currentChild ? currentChild.name.slice(0, 1) : '童' }}</text>
        </view>
        <view class="child-text">
          <text class="child-label">当前儿童</text>
          <text class="child-name">{{ currentChild ? currentChild.name : '还没有选档案' }}</text>
        </view>
      </view>
      <view class="switch-btn" @tap="goProfiles">
        <text class="switch-text">{{ currentChild ? '切换' : '去选择' }}</text>
      </view>
    </view>

    <!-- 功能列表：v1 仅占位，后续接学习报告/设置 -->
    <view class="card-grid">
      <view v-for="item in COMING_ITEMS" :key="item.title" class="card card-mini" @tap="comingSoon(item.title)">
        <text class="mini-emoji">{{ item.emoji }}</text>
        <text class="card-title small">{{ item.title }}</text>
        <view class="soon-badge">
          <text class="soon-text">敬请期待</text>
        </view>
      </view>
    </view>

    <!-- 退出登录：走 store.logout()（清 token/children/phone + 重置识字缓存），停留本页回未登录态 -->
    <button v-if="isLoggedIn" class="logout-btn" @tap="onLogout">退出登录</button>
  </view>
</template>

<script setup lang="ts">
/** 我的（家长中心）：登录入口 + 当前儿童切换 + 退出登录。双态渲染，未登录不发任何请求。 */
import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { maskPhone } from '@/utils/profile'

const COMING_ITEMS = [
  { emoji: '📊', title: '学习报告' },
  { emoji: '⚙️', title: '设置' },
] as const

const auth = useAuthStore()

const isLoggedIn = computed(() => auth.isLoggedIn)
const currentChild = computed(() => auth.children.find((child) => child.id === auth.childId))
/** 手机号脱敏展示；无号（<8 位）回退默认称谓。 */
const parentName = computed(() => maskPhone(auth.phone) || '知芽家长')

function onUserCard() {
  if (!isLoggedIn.value) {
    uni.navigateTo({ url: '/pages/auth/login' })
  }
}

function goProfiles() {
  uni.navigateTo({ url: '/pages/auth/profiles' })
}

function comingSoon(title: string) {
  uni.showToast({ title: `${title}，敬请期待`, icon: 'none' })
}

function onLogout() {
  uni.showModal({
    title: '退出登录',
    content: '确定要退出当前家长账号吗？',
    success: (res) => {
      if (res.confirm) {
        auth.logout()
      }
    },
  })
}
</script>

<style scoped lang="scss">
.container {
  padding: 48rpx 32rpx;
  min-height: 100vh;
}
.card {
  background: $learnly-surface;
  border-radius: $learnly-radius-lg;
  box-shadow: $learnly-shadow-sm;
}
.card-user {
  display: flex;
  align-items: center;
  gap: 28rpx;
  padding: 40rpx 32rpx;
}
.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 104rpx;
  height: 104rpx;
  background: $learnly-bg;
  border-radius: 50%;
}
.avatar-glyph {
  font-size: $learnly-fs-xl;
  font-weight: 800;
  color: $learnly-primary;
}
.user-text {
  flex: 1;
}
.user-name {
  display: block;
  font-size: 36rpx;
  font-weight: 800;
  color: $learnly-text;
}
.user-sub {
  display: block;
  margin-top: 8rpx;
  font-size: $learnly-fs-sm;
  color: $learnly-text-light;
}
.card-chevron {
  font-size: $learnly-fs-xl;
  color: $learnly-text-light;
}
.card-child {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 32rpx;
  margin-top: 24rpx;
}
.child-left {
  display: flex;
  align-items: center;
  gap: 24rpx;
}
.child-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 80rpx;
  height: 80rpx;
  background: $learnly-bg;
  border-radius: 50%;
}
.child-glyph {
  font-size: 36rpx;
  font-weight: 800;
  color: $learnly-secondary;
}
.child-label {
  display: block;
  font-size: $learnly-fs-sm;
  color: $learnly-text-light;
}
.child-name {
  display: block;
  margin-top: 6rpx;
  font-size: 32rpx;
  font-weight: 700;
  color: $learnly-text;
}
.switch-btn {
  padding: 12rpx 32rpx;
  background: $learnly-bg;
  border-radius: 999rpx;
}
.switch-text {
  font-size: $learnly-fs-base;
  font-weight: 700;
  color: $learnly-primary;
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
.card-title {
  display: block;
  font-size: $learnly-fs-lg;
  font-weight: 700;
  color: $learnly-text;

  &.small {
    font-size: $learnly-fs-md;
  }
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
.logout-btn {
  margin: 48rpx 0 0;
  padding: 24rpx 0;
  background: $learnly-surface;
  border-radius: $learnly-radius-md;
  box-shadow: $learnly-shadow-sm;
  font-size: $learnly-fs-md;
  font-weight: 700;
  color: $learnly-danger;
}
</style>
