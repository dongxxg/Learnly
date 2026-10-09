<template>
  <view class="container">
    <!-- 学习统计 -->
    <view v-if="store.stats" class="stats-bar">
      <view class="stat">
        <text class="stat-num">{{ store.stats.learned }}</text>
        <text class="stat-label">已学</text>
      </view>
      <view class="stat">
        <text class="stat-num">{{ store.stats.learning }}</text>
        <text class="stat-label">在学</text>
      </view>
      <view class="stat">
        <text class="stat-num">{{ store.stats.total }}</text>
        <text class="stat-label">总字数</text>
      </view>
    </view>

    <!-- 难度筛选 -->
    <scroll-view class="level-tabs" scroll-x>
      <view
        v-for="tab in levelTabs"
        :key="tab.value"
        class="tab"
        :class="{ active: store.level === tab.value }"
        @tap="onTab(tab.value)"
      >
        <text>{{ tab.label }}</text>
      </view>
    </scroll-view>

    <!-- 字卡网格（后端已按简单→复杂排序） -->
    <view class="grid">
      <view
        v-for="item in store.items"
        :key="item.id"
        class="char-card"
        @tap="goDetail(item.id)"
      >
        <view class="tian-grid">
          <text class="char">{{ item.char }}</text>
        </view>
        <text class="pinyin">{{ item.pinyin }}</text>
        <view class="status-badge" :class="statusClass(item.progressStatus)">
          <text>{{ statusLabel(item.progressStatus) }}</text>
        </view>
      </view>
    </view>

    <view v-if="!store.loading && store.items.length === 0" class="empty">
      <text>暂无汉字</text>
    </view>
    <view v-if="store.loading" class="loading">
      <text>加载中…</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onPullDownRefresh, onReachBottom, onShow } from '@dcloudio/uni-app'
import { useLiteracyStore } from '@/stores/literacy'
import { STATUS_CLASS, STATUS_LABEL } from '@/utils/hanzi'
import type { ProgressStatus } from '@/api/literacy'

const store = useLiteracyStore()

const levelTabs = [
  { value: 0, label: '全部' },
  { value: 1, label: '第 1 阶' },
  { value: 2, label: '第 2 阶' },
  { value: 3, label: '第 3 阶' },
]

onShow(() => {
  store.loadPage(true)
  store.loadStats()
})

onPullDownRefresh(async () => {
  try {
    await Promise.all([store.loadPage(true), store.loadStats()])
  } finally {
    uni.stopPullDownRefresh()
  }
})

onReachBottom(() => {
  store.loadMore()
})

function onTab(level: number) {
  store.setLevel(level)
}

function goDetail(id: number) {
  uni.navigateTo({ url: `/pages/literacy/detail?id=${id}` })
}

function statusLabel(status: ProgressStatus) {
  return STATUS_LABEL[status]
}

function statusClass(status: ProgressStatus) {
  return STATUS_CLASS[status]
}
</script>

<style scoped lang="scss">
.container {
  padding: 24rpx 32rpx 48rpx;
}
.stats-bar {
  display: flex;
  background: #fff;
  border-radius: $learnly-radius-lg;
  padding: 24rpx 0;
  margin-bottom: 24rpx;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
}
.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;

  & + & {
    border-left: 2rpx solid $learnly-bg;
  }
}
.stat-num {
  font-size: 44rpx;
  font-weight: 800;
  color: $learnly-primary;
}
.stat-label {
  margin-top: 4rpx;
  font-size: 24rpx;
  color: $learnly-text-light;
}
.level-tabs {
  white-space: nowrap;
  margin-bottom: 24rpx;
}
.tab {
  display: inline-block;
  padding: 12rpx 32rpx;
  margin-right: 16rpx;
  background: #fff;
  border-radius: 999rpx;
  font-size: 26rpx;
  color: $learnly-text-light;

  &.active {
    background: $learnly-primary;
    color: #fff;
  }
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24rpx;
}
.char-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20rpx 0 16rpx;
  background: #fff;
  border-radius: $learnly-radius-md;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
}
.tian-grid {
  width: 128rpx;
  height: 128rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2rpx solid #e5e7eb;
  background:
    linear-gradient(to right, transparent calc(50% - 1rpx), #e5e7eb calc(50% - 1rpx), #e5e7eb calc(50% + 1rpx), transparent calc(50% + 1rpx)),
    linear-gradient(to bottom, transparent calc(50% - 1rpx), #e5e7eb calc(50% - 1rpx), #e5e7eb calc(50% + 1rpx), transparent calc(50% + 1rpx));
  border-radius: $learnly-radius-sm;
}
.char {
  font-size: 76rpx;
  color: $learnly-text;
  font-family: 'Kaiti SC', 'KaiTi', 'STKaiti', serif;
}
.pinyin {
  margin-top: 8rpx;
  font-size: 24rpx;
  color: $learnly-text-light;
}
.status-badge {
  position: absolute;
  top: 8rpx;
  right: 8rpx;
  padding: 2rpx 12rpx;
  border-radius: 999rpx;
  font-size: 20rpx;

  &.status-unlearned {
    background: $learnly-bg;
    color: $learnly-text-light;
  }
  &.status-learning {
    background: rgba($learnly-secondary, 0.15);
    color: $learnly-secondary;
  }
  &.status-learned {
    background: rgba($learnly-primary, 0.15);
    color: $learnly-primary;
  }
}
.empty,
.loading {
  text-align: center;
  padding: 80rpx 0;
  color: $learnly-text-light;
  font-size: 28rpx;
}
</style>
