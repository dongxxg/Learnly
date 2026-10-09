<template>
  <view class="container">
    <view class="hero">
      <text class="logo">知芽</text>
      <text class="slogan">知识萌芽，AI 陪伴成长</text>
    </view>

    <view class="form">
      <input
        v-model="phone"
        class="input"
        type="number"
        maxlength="11"
        placeholder="家长手机号"
      />
      <input
        v-model="password"
        class="input"
        password
        maxlength="32"
        placeholder="密码（至少 6 位）"
      />
      <button class="btn-primary" :disabled="!canSubmit || submitting" @tap="onLogin">
        {{ submitting ? '登录中…' : '登录' }}
      </button>
      <view class="links">
        <text class="link" @tap="goRegister">没有账号？去注册</text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const phone = ref('')
const password = ref('')
const submitting = ref(false)

const canSubmit = computed(() => phone.value.length === 11 && password.value.length >= 6)

async function onLogin() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    await authStore.login(phone.value, password.value)
    // 登录后统一去档案页选择儿童（后端登录态 childId=0）。
    uni.reLaunch({ url: '/pages/auth/profiles' })
  } catch (err) {
    uni.showToast({ title: (err as Error).message || '登录失败', icon: 'none' })
  } finally {
    submitting.value = false
  }
}

function goRegister() {
  uni.navigateTo({ url: '/pages/auth/register' })
}
</script>

<style scoped lang="scss">
.container {
  padding: 48rpx 48rpx;
  min-height: 100vh;
  background: $learnly-bg;
}
.hero {
  text-align: center;
  margin: 120rpx 0 80rpx;
}
.logo {
  display: block;
  font-size: 88rpx;
  font-weight: 800;
  color: $learnly-primary;
}
.slogan {
  display: block;
  margin-top: 16rpx;
  font-size: 28rpx;
  color: $learnly-text-light;
}
.form {
  display: flex;
  flex-direction: column;
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
  background: $learnly-primary;
  color: #fff;
  font-size: 34rpx;
  border-radius: $learnly-radius-md;

  &[disabled] {
    opacity: 0.5;
    background: $learnly-primary;
    color: #fff;
  }
}
.links {
  margin-top: 32rpx;
  text-align: center;
}
.link {
  font-size: 28rpx;
  color: $learnly-primary;
}
</style>
