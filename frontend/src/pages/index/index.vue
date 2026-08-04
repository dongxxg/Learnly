<template>
  <view class="container">
    <view class="hero">
      <text class="title">知芽</text>
      <text class="subtitle">知识萌芽，AI 陪伴成长</text>
    </view>

    <view class="modules">
      <view v-for="m in modules" :key="m.key" class="module-card" @tap="onTap(m)">
        <text class="module-emoji">{{ m.emoji }}</text>
        <text class="module-name">{{ m.name }}</text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
interface LearnlyModule {
  key: string
  name: string
  emoji: string
}

const modules: LearnlyModule[] = [
  { key: 'literacy', name: '知芽识字', emoji: '字' },
  { key: 'english', name: '知芽英语', emoji: 'A' },
  { key: 'math', name: '知节数学', emoji: '数' },
  { key: 'ai-teacher', name: '知芽AI老师', emoji: '师' },
  { key: 'parent', name: '知芽家长助手', emoji: '家' },
]

function onTap(m: LearnlyModule) {
  uni.showToast({ title: `${m.name}（待开发）`, icon: 'none' })
}
</script>

<style scoped lang="scss">
@use '@/uni.scss' as *;

.container {
  padding: 48rpx 32rpx;
}
.hero {
  text-align: center;
  margin: 60rpx 0;
}
.title {
  display: block;
  font-size: 72rpx;
  font-weight: 800;
  color: $learnly-primary;
}
.subtitle {
  display: block;
  margin-top: 16rpx;
  font-size: 28rpx;
  color: $learnly-text-light;
}
.modules {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24rpx;
}
.module-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48rpx 0;
  background: #fff;
  border-radius: $learnly-radius-md;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
}
.module-emoji {
  width: 80rpx;
  height: 80rpx;
  line-height: 80rpx;
  text-align: center;
  border-radius: 50%;
  background: rgba($learnly-primary, 0.12);
  color: $learnly-primary;
  font-weight: 700;
  margin-bottom: 16rpx;
}
.module-name {
  font-size: 30rpx;
  color: $learnly-text;
}
</style>
