<template>
  <view class="container">
    <!-- hero：品牌绿渐变 + 小芽吉祥物（ui-kit：吉祥物仅 hero/庆祝/空态） -->
    <view class="hero">
      <view class="hero__text">
        <text class="hero__title">知芽</text>
        <text class="hero__subtitle">知识萌芽，AI 陪伴成长</text>
      </view>
      <Mascot class="hero__mascot" :size="128" variant="mono" color="#FFFFFF" />
    </view>

    <!-- 学习数据条：登录且有档案时展示统计，其余场景占位引导（不强制登录） -->
    <view class="stats">
      <template v-if="stats">
        <view class="stats__item">
          <text class="stats__num stats__num--learned">{{ stats.learned }}</text>
          <text class="stats__label">已学</text>
        </view>
        <view class="stats__item">
          <text class="stats__num stats__num--learning">{{ stats.learning }}</text>
          <text class="stats__label">在学</text>
        </view>
        <view class="stats__item">
          <text class="stats__num">{{ stats.total }}</text>
          <text class="stats__label">总字数</text>
        </view>
      </template>
      <text v-else class="stats__hint">{{ statsHint }}</text>
    </view>

    <!-- 模块入口：LCard + LIcon -->
    <view class="modules">
      <LCard v-for="m in modules" :key="m.key" class="module-card" @tap="onTap(m)">
        <view class="module-card__icon" :style="{ background: m.chipBg }">
          <LIcon :name="m.icon" :size="52" :color="m.color" />
        </view>
        <text class="module-card__name">{{ m.name }}</text>
        <text class="module-card__desc">{{ m.desc }}</text>
      </LCard>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import LCard from '@/components/ui/LCard.vue'
import LIcon from '@/components/ui/LIcon.vue'
import Mascot from '@/components/ui/Mascot.vue'
import { getStats, type StudyStats } from '@/api/literacy'
import { useAuthStore } from '@/stores/auth'

interface LearnlyModule {
  key: string
  name: string
  desc: string
  icon: string
  color: string
  chipBg: string
}

// 图标色全部取自令牌色系（uni.scss）；芯片底统一中性浅灰，彩色只留给图标本身
const modules: LearnlyModule[] = [
  { key: 'chinese', name: '知芽汉语', desc: '识字 · 古诗', icon: 'chinese', color: '#4CAF7A', chipBg: '#F3F4F6' },
  { key: 'english', name: '知芽英语', desc: '字母启蒙', icon: 'english', color: '#5B8DEF', chipBg: '#F3F4F6' },
  { key: 'math', name: '知节数学', desc: '口算练习', icon: 'math', color: '#E67E22', chipBg: '#F3F4F6' },
  { key: 'ai-teacher', name: '知芽AI老师', desc: '敬请期待', icon: 'ai-teacher', color: '#3E9163', chipBg: '#F3F4F6' },
  { key: 'parent', name: '知芽家长助手', desc: '敬请期待', icon: 'parent', color: '#FFB43D', chipBg: '#F3F4F6' },
]

const auth = useAuthStore()
const stats = ref<StudyStats | null>(null)
const statsHint = ref('')

onShow(() => {
  if (auth.isLoggedIn && auth.hasChild) {
    getStats()
      .then((s) => (stats.value = s))
      .catch(() => (stats.value = null)) // 统计条为非关键装饰，失败静默降级为占位
  } else {
    statsHint.value = auth.isLoggedIn ? '先创建小朋友档案吧' : '登录后记录学习进度'
  }
})

function onTap(m: LearnlyModule) {
  if (m.key === 'chinese') {
    // 汉语模块卡片列表；识字卡的登录守卫在 chinese/tabs 卡片点击时校验。
    uni.navigateTo({ url: '/pages/chinese/tabs' })
    return
  }
  if (m.key === 'english') {
    // 英语模块：静态字母集合，v1 无登录守卫、无进度上报（design D4）。
    uni.navigateTo({ url: '/pages/english/tabs' })
    return
  }
  if (m.key === 'math') {
    // 数学模块：加减法口算，纯前端本地练习，无登录守卫、无进度上报。
    uni.navigateTo({ url: '/pages/math/tabs' })
    return
  }
  uni.showToast({ title: `${m.name}（待开发）`, icon: 'none' })
}
</script>

<style scoped lang="scss">
.container {
  padding: 24rpx 32rpx 48rpx;
}

/* hero：品牌绿渐变（SCSS 编译期注入，规避 mp 端 var-in-gradient 兼容差异） */
.hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 48rpx 40rpx 40rpx;
  border-radius: $learnly-radius-lg;
  background: linear-gradient(135deg, $learnly-primary 0%, $learnly-primary-deep 100%);
  box-shadow: $learnly-shadow-lg;
}
.hero__title {
  display: block;
  font-size: $learnly-fs-3xl;
  font-weight: 800;
  color: $learnly-surface;
}
.hero__subtitle {
  display: block;
  margin-top: 12rpx;
  font-size: $learnly-fs-sm;
  color: $learnly-surface;
  opacity: 0.85;
}
.hero__mascot {
  margin-right: -8rpx;
  margin-bottom: -16rpx;
  opacity: 0.9;
}

/* 学习数据条 */
.stats {
  display: flex;
  align-items: center;
  justify-content: space-around;
  margin: 24rpx 0;
  padding: 24rpx 0;
  background: $learnly-surface;
  border-radius: $learnly-radius-md;
  box-shadow: $learnly-shadow-sm;
}
.stats__item {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.stats__num {
  font-size: $learnly-fs-xl;
  font-weight: 700;
  color: $learnly-text;
}
.stats__num--learned {
  color: $learnly-primary;
}
.stats__num--learning {
  color: $learnly-secondary;
}
.stats__label {
  margin-top: 4rpx;
  font-size: $learnly-fs-xs;
  color: $learnly-text-light;
}
.stats__hint {
  font-size: $learnly-fs-sm;
  color: $learnly-text-light;
}

/* 模块网格 */
.modules {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: $learnly-space-xs;
}
.module-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40rpx 0 32rpx;
}
.module-card__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 112rpx;
  height: 112rpx;
  border-radius: 50%;
}
.module-card__name {
  margin-top: 20rpx;
  font-size: $learnly-fs-md;
  font-weight: 600;
  color: $learnly-text;
}
.module-card__desc {
  margin-top: 8rpx;
  font-size: $learnly-fs-xs;
  color: $learnly-text-light;
}
</style>
