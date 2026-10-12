<template>
  <view class="container">
    <!-- 26 字母锚点页签（横向滚动，点选滚动定位） -->
    <scroll-view class="letter-tabs" scroll-x :scroll-into-view="'tab-' + focusLetter" scroll-with-animation>
      <view
        v-for="letter in LETTERS"
        :id="'tab-' + letter"
        :key="letter"
        class="tab"
        :class="{ active: letter === focusLetter }"
        @tap="setFocus(letter)"
      >
        <text>{{ letter }}</text>
      </view>
    </scroll-view>

    <!-- 26 字母卡（大写 + 小写预览），点卡进详情 -->
    <scroll-view class="grid-scroll" scroll-y :scroll-into-view="'card-' + focusLetter" scroll-with-animation>
      <view class="grid">
        <view
          v-for="letter in LETTERS"
          :id="'card-' + letter"
          :key="letter"
          class="letter-card"
          :class="{ focused: letter === focusLetter }"
          @tap="goDetail(letter)"
        >
          <view class="glyph-pair">
            <text class="glyph upper">{{ letter }}</text>
            <text class="glyph lower">{{ toLowerLetter(letter) }}</text>
          </view>
          <text class="letter-name">{{ letter }}</text>
        </view>
      </view>
    </scroll-view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { LETTERS, toLowerLetter, toUpperLetter } from '@/utils/english'

/** 当前锚定字母（页签页带入，列表页内页签可切换）。 */
const focusLetter = ref('A')

onLoad((query) => {
  const focus = toUpperLetter(String(query?.focus ?? 'A'))
  if (LETTERS.includes(focus)) {
    focusLetter.value = focus
  }
})

function setFocus(letter: string) {
  focusLetter.value = letter
}

function goDetail(letter: string) {
  uni.navigateTo({ url: `/pages/english/detail?letter=${letter}` })
}
</script>

<style scoped lang="scss">
.container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 24rpx 0 0;
  box-sizing: border-box;
}
.letter-tabs {
  white-space: nowrap;
  padding: 0 32rpx 24rpx;
  flex-shrink: 0;
}
.tab {
  display: inline-block;
  min-width: 72rpx;
  text-align: center;
  padding: 12rpx 20rpx;
  margin-right: 16rpx;
  background: #fff;
  border-radius: 999rpx;
  font-size: 28rpx;
  font-weight: 700;
  color: $learnly-text-light;

  &.active {
    background: $learnly-primary;
    color: #fff;
  }
}
.grid-scroll {
  flex: 1;
  min-height: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24rpx;
  padding: 0 32rpx 48rpx;
}
.letter-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 28rpx 0 20rpx;
  background: #fff;
  border: 4rpx solid transparent;
  border-radius: $learnly-radius-lg;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);

  &.focused {
    border-color: $learnly-primary;
  }
}
.glyph-pair {
  display: flex;
  align-items: baseline;
  gap: 12rpx;
}
.glyph {
  font-weight: 800;
  line-height: 1.2;

  &.upper {
    font-size: 88rpx;
    color: $learnly-primary;
  }
  &.lower {
    font-size: 64rpx;
    color: $learnly-text;
  }
}
.letter-name {
  margin-top: 8rpx;
  font-size: 24rpx;
  color: $learnly-text-light;
}
</style>
