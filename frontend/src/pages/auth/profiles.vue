<template>
  <view class="container">
    <text class="section-title">选择孩子</text>
    <text class="section-desc">每个孩子有独立的学习进度</text>

    <view v-if="authStore.children.length > 0" class="child-list">
      <view
        v-for="child in authStore.children"
        :key="child.id"
        class="child-card"
        :class="{ active: child.id === authStore.childId }"
        @tap="onSelect(child.id)"
      >
        <text class="avatar">{{ child.name.slice(0, 1) }}</text>
        <text class="name">{{ child.name }}</text>
        <text v-if="child.id === authStore.childId" class="badge">当前</text>
      </view>
    </view>

    <view class="create">
      <text class="section-title">创建新档案</text>
      <input
        v-model="newName"
        class="input"
        maxlength="20"
        placeholder="孩子的昵称"
      />
      <button class="btn-primary" :disabled="!newName.trim() || creating" @tap="onCreate">
        {{ creating ? '创建中…' : '创建档案' }}
      </button>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const newName = ref('')
const creating = ref(false)

async function onSelect(childId: number) {
  try {
    await authStore.switchChild(childId)
    uni.reLaunch({ url: '/pages/index/index' })
  } catch (err) {
    uni.showToast({ title: (err as Error).message || '切换失败', icon: 'none' })
  }
}

async function onCreate() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    await authStore.createChild(name)
    newName.value = ''
    uni.showToast({ title: '创建成功', icon: 'success' })
  } catch (err) {
    uni.showToast({ title: (err as Error).message || '创建失败', icon: 'none' })
  } finally {
    creating.value = false
  }
}
</script>

<style scoped lang="scss">
.container {
  padding: 48rpx 32rpx;
  min-height: 100vh;
  background: $learnly-bg;
}
.section-title {
  display: block;
  font-size: 40rpx;
  font-weight: 700;
  color: $learnly-text;
}
.section-desc {
  display: block;
  margin: 12rpx 0 32rpx;
  font-size: 26rpx;
  color: $learnly-text-light;
}
.child-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24rpx;
  margin-bottom: 56rpx;
}
.child-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40rpx 0;
  background: #fff;
  border: 4rpx solid transparent;
  border-radius: $learnly-radius-lg;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);

  &.active {
    border-color: $learnly-primary;
  }
}
.avatar {
  width: 96rpx;
  height: 96rpx;
  line-height: 96rpx;
  text-align: center;
  border-radius: 50%;
  background: rgba($learnly-primary, 0.12);
  color: $learnly-primary;
  font-size: 44rpx;
  font-weight: 700;
  margin-bottom: 16rpx;
}
.name {
  font-size: 30rpx;
  color: $learnly-text;
}
.badge {
  position: absolute;
  top: 16rpx;
  right: 16rpx;
  padding: 4rpx 16rpx;
  background: $learnly-primary;
  color: #fff;
  font-size: 22rpx;
  border-radius: 999rpx;
}
.create {
  padding-top: 32rpx;
  border-top: 2rpx solid #e5e7eb;

  .section-title {
    margin-bottom: 24rpx;
  }
}
.input {
  height: 96rpx;
  padding: 0 32rpx;
  margin-bottom: 32rpx;
  background: #fff;
  border-radius: $learnly-radius-md;
  font-size: 32rpx;
}
.btn-primary {
  height: 96rpx;
  line-height: 96rpx;
  background: $learnly-secondary;
  color: #fff;
  font-size: 32rpx;
  border-radius: $learnly-radius-md;

  &[disabled] {
    opacity: 0.5;
    background: $learnly-secondary;
    color: #fff;
  }
}
</style>
