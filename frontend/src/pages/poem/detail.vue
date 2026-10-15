<template>
  <view class="container">
    <template v-if="poem">
      <view class="poem-head">
        <text class="poem-title">{{ poem.title }}</text>
        <view class="author-pill">
          <text>{{ poemAuthorLine(poem) }}</text>
        </view>
      </view>

      <view class="poem-body">
        <view v-for="(line, index) in poem.lines" :key="index" class="poem-line">
          <view
            v-for="(cell, cellIndex) in poemLineCells(line, poem.linesPinyin[index])"
            :key="cellIndex"
            class="cell"
          >
            <text class="cell-pinyin">{{ cell.pinyin }}</text>
            <text class="cell-char">{{ cell.char }}</text>
          </view>
        </view>
      </view>

      <view class="translation">
        <text class="translation-label">译文</text>
        <text class="translation-text">{{ poem.translation }}</text>
      </view>
    </template>

    <view v-else class="missing">
      <text>没有找到这首古诗</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { getPoemById, poemAuthorLine, poemLineCells, type Poem } from '@/utils/poems'

/** 古诗详情：诗文 + 白话译文；非法 id 提示后返回列表。 */
const poem = ref<Poem | null>(null)

onLoad((query) => {
  const found = getPoemById(String(query?.id ?? ''))
  if (!found) {
    uni.showToast({ title: '没有找到这首古诗', icon: 'none' })
    setTimeout(() => uni.navigateBack(), 800)
    return
  }
  poem.value = found
})
</script>

<style scoped lang="scss">
.container {
  padding: 48rpx 32rpx;
  min-height: 100vh;
}
.poem-head {
  text-align: center;
  margin-bottom: 40rpx;
}
.poem-title {
  display: block;
  font-size: 44rpx;
  font-weight: 800;
  color: $learnly-text;
}
.author-pill {
  display: inline-block;
  margin-top: 20rpx;
  padding: 6rpx 28rpx;
  background: rgba($learnly-primary, 0.12);
  border-radius: 999rpx;
  font-size: 26rpx;
  color: $learnly-primary;
}
.poem-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28rpx;
  padding: 48rpx 24rpx;
  background: #fff;
  border-radius: $learnly-radius-lg;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
}
.poem-line {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0 6rpx;
}
.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 44rpx;
}
.cell-pinyin {
  font-size: 20rpx;
  line-height: 1.4;
  color: $learnly-text-light;
}
.cell-char {
  font-size: 36rpx;
  line-height: 1.5;
  color: $learnly-text;
}
.translation {
  margin-top: 24rpx;
  padding: 32rpx;
  background: rgba($learnly-primary, 0.08);
  border-radius: $learnly-radius-lg;
}
.translation-label {
  display: block;
  font-size: 24rpx;
  font-weight: 700;
  color: $learnly-primary;
  margin-bottom: 16rpx;
}
.translation-text {
  font-size: 28rpx;
  line-height: 1.8;
  color: $learnly-text;
}
.missing {
  text-align: center;
  margin-top: 200rpx;
  font-size: 28rpx;
  color: $learnly-text-light;
}
</style>
