<template>
  <view class="container">
    <!-- 学段页签：全部 / 1-2年级 / 3-4年级 / 5-6年级 -->
    <scroll-view class="stage-tabs" scroll-x>
      <view class="tab-row">
        <view
          v-for="tab in stageTabs"
          :key="tab.key"
          class="tab"
          :class="{ active: tab.key === stage }"
          @tap="setStage(tab.key)"
        >
          <text>{{ tab.label }}</text>
          <text class="tab-count">{{ tab.count }}</text>
        </view>
      </view>
    </scroll-view>

    <!-- 诗卡列表：标题 + 朝代作者 + 首句预览 -->
    <view class="poem-list">
      <view v-for="poem in items" :key="poem.id" class="poem-card" @tap="goDetail(poem.id)">
        <view class="poem-head">
          <text class="poem-title">{{ poem.title }}</text>
          <text class="poem-author">{{ poemAuthorLine(poem) }}</text>
        </view>
        <text class="poem-preview">{{ poem.lines[0] }}</text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { POEMS, POEM_STAGES, poemAuthorLine, poemCountByStage, poemsByStage, type PoemStage } from '@/utils/poems'

/** 古诗列表：按学段筛选，点卡进详情。静态数据，无登录守卫。 */
type StageTab = { key: 'all' | PoemStage; label: string; count: number }

const stageTabs: StageTab[] = [
  { key: 'all', label: '全部', count: POEMS.length },
  ...POEM_STAGES.map((s) => ({ key: s.key, label: s.label, count: poemCountByStage(s.key) })),
]

const stage = ref<'all' | PoemStage>('all')

const items = computed(() => (stage.value === 'all' ? POEMS : poemsByStage(stage.value)))

function setStage(key: 'all' | PoemStage) {
  stage.value = key
}

function goDetail(id: string) {
  uni.navigateTo({ url: `/pages/poem/detail?id=${id}` })
}
</script>

<style scoped lang="scss">
.container {
  padding: 24rpx 32rpx 48rpx;
  min-height: 100vh;
}
.stage-tabs {
  white-space: nowrap;
  margin-bottom: 24rpx;
}
.tab-row {
  display: inline-flex;
  gap: 16rpx;
}
.tab {
  display: inline-flex;
  align-items: baseline;
  gap: 8rpx;
  padding: 12rpx 28rpx;
  border-radius: 999rpx;
  background: $learnly-surface;
  font-size: $learnly-fs-base;
  color: $learnly-text-light;
  box-shadow: $learnly-shadow-sm;

  &.active {
    background: $learnly-primary;
    color: $learnly-surface;

    .tab-count {
      color: $learnly-surface;
      opacity: 0.75;
    }
  }
}
.tab-count {
  font-size: $learnly-fs-xs;
  color: $learnly-text-light;
}
.poem-list {
  display: flex;
  flex-direction: column;
  gap: 20rpx;
}
.poem-card {
  background: $learnly-surface;
  border-radius: $learnly-radius-lg;
  box-shadow: $learnly-shadow-sm;
  padding: 32rpx;
}
.poem-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16rpx;
}
.poem-title {
  font-size: 32rpx;
  font-weight: 700;
  color: $learnly-text;
}
.poem-author {
  font-size: $learnly-fs-sm;
  color: $learnly-primary;
}
.poem-preview {
  display: block;
  margin-top: 12rpx;
  font-size: $learnly-fs-base;
  color: $learnly-text-light;
}
</style>
