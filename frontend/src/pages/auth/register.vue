<template>
  <view class="container">
    <view class="hero">
      <text class="logo">注册账号</text>
      <text class="slogan">为孩子开启识字之旅</text>
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
      <input
        v-model="confirmPassword"
        class="input"
        password
        maxlength="32"
        placeholder="确认密码"
      />
      <button class="btn-primary" :disabled="!canSubmit || submitting" @tap="onRegister">
        {{ submitting ? '注册中…' : '注册并开始' }}
      </button>
      <view class="links">
        <text class="link" @tap="goLogin">已有账号？去登录</text>
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
const confirmPassword = ref('')
const submitting = ref(false)

const canSubmit = computed(
  () => phone.value.length === 11 && password.value.length >= 6 && password.value === confirmPassword.value,
)

async function onRegister() {
  if (!canSubmit.value || submitting.value) return
  if (password.value !== confirmPassword.value) {
    uni.showToast({ title: '两次密码不一致', icon: 'none' })
    return
  }
  submitting.value = true
  try {
    await authStore.register(phone.value, password.value)
    uni.showToast({ title: '注册成功', icon: 'success' })
    // 注册后去档案页创建第一个儿童。
    setTimeout(() => uni.reLaunch({ url: '/pages/auth/profiles' }), 600)
  } catch (err) {
    uni.showToast({ title: (err as Error).message || '注册失败', icon: 'none' })
  } finally {
    submitting.value = false
  }
}

function goLogin() {
  uni.navigateBack()
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
  margin: 80rpx 0 64rpx;
}
.logo {
  display: block;
  font-size: 56rpx;
  font-weight: 800;
  color: $learnly-text;
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
