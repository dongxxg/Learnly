<template>
  <view class="container">
    <template v-if="detail">
      <!-- 字卡头部：田字格 + 拼音 + 发音 -->
      <view class="hero">
        <view class="char-display">
          <text class="char">{{ detail.char }}</text>
        </view>
        <view class="meta">
          <text class="pinyin" @tap="playAudio">{{ detail.pinyin }}</text>
          <view class="meta-row">
            <text class="strokes">{{ detail.strokes }} 画</text>
            <text class="level">第 {{ detail.level }} 阶</text>
            <view class="status-badge" :class="statusClass(detail.progressStatus)">
              <text>{{ statusLabel(detail.progressStatus) }}</text>
            </view>
          </view>
          <button class="btn-audio" :disabled="audioBroken" @tap="playAudio">
            🔊 {{ audioBroken ? '读音不可用' : '听读音' }}
          </button>
        </view>
      </view>

      <!-- 释义 -->
      <view class="section">
        <text class="section-title">释义</text>
        <text class="definition">{{ detail.definition || '暂无释义' }}</text>
      </view>

      <template v-if="hasStrokeData">
        <!-- 笔顺演示 / 书写练习切换 -->
        <view class="mode-tabs">
          <view class="tab" :class="{ active: mode === 'animation' }" @tap="switchMode('animation')">
            <text>看笔顺</text>
          </view>
          <view class="tab" :class="{ active: mode === 'quiz' }" @tap="switchMode('quiz')">
            <text>写一写</text>
          </view>
        </view>

        <view class="board-wrap">
          <hanzi-writer-board
            ref="board"
            :char="detail.char"
            :mode="mode"
            :auto-play="true"
            @stroke-result="onStrokeResult"
            @quiz-complete="onQuizComplete"
          />
        </view>

        <view class="board-actions">
          <template v-if="mode === 'animation'">
            <button class="btn-action" @tap="replay">▶ 再看一遍</button>
          </template>
          <template v-else>
            <button class="btn-action ghost" @tap="retryQuiz">↺ 重写</button>
            <text class="quiz-hint">按笔顺在田字格里写，写对全部 {{ detail.strokes }} 笔就学会啦</text>
          </template>
        </view>
      </template>

      <view v-else class="section fallback">
        <text class="fallback-text">这个字的笔顺资料还没准备好，先听听读音、认认样子吧</text>
      </view>
    </template>

    <view v-else-if="loadFailed" class="empty">
      <text>汉字不存在</text>
    </view>
    <view v-else class="empty">
      <text>加载中…</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onLoad, onUnload } from '@dcloudio/uni-app'
import { computed, ref } from 'vue'
import HanziWriterBoard from '@/components/hanzi-writer-board.vue'
import { getCharacter, recordStudy, type CharacterItem, type ProgressStatus } from '@/api/literacy'
import { charAudioPath, STATUS_CLASS, STATUS_LABEL } from '@/utils/hanzi'
import { hasHanziData } from '@/hanzi-data'
import { useLiteracyStore } from '@/stores/literacy'

const detail = ref<CharacterItem | null>(null)
const loadFailed = ref(false)
const mode = ref<'animation' | 'quiz'>('animation')
const audioBroken = ref(false)
const board = ref<InstanceType<typeof HanziWriterBoard> | null>(null)

let characterId = 0
let audioCtx: UniApp.InnerAudioContext | null = null

const hasStrokeData = computed(() => (detail.value ? hasHanziData(detail.value.char) : false))

async function load(id: number) {
  try {
    const item = await getCharacter(id)
    detail.value = item
    initAudio(item.char)
    // spec：进入"未学"字详情自动上报 start。
    if (item.progressStatus === 'unlearned') {
      markStart()
    }
  } catch {
    loadFailed.value = true
  }
}

async function markStart() {
  try {
    const updated = await recordStudy(characterId, 'start')
    if (detail.value) {
      detail.value.progressStatus = updated.progressStatus
    }
    markProgressLocally(updated.progressStatus)
  } catch {
    // 上报失败不阻塞浏览（弱网兜底），书写通过时仍会上报 complete。
  }
}

function initAudio(char: string) {
  audioCtx?.destroy()
  audioCtx = uni.createInnerAudioContext()
  audioCtx.src = charAudioPath(char)
  audioCtx.onError(() => {
    // 音频缺失/损坏按 spec 降级：置灰按钮，不弹错误。
    audioBroken.value = true
  })
}

function playAudio() {
  if (audioBroken.value || !audioCtx) return
  audioCtx.stop()
  audioCtx.play()
}

function switchMode(next: 'animation' | 'quiz') {
  mode.value = next
}

function replay() {
  board.value?.play()
}

function retryQuiz() {
  board.value?.startQuiz()
}

function onStrokeResult(payload: { type: string; strokeNum: number }) {
  if (payload.type === 'mistake') {
    uni.vibrateShort?.({})
  }
}

/** spec：书写全部通过 → 自动上报 complete，无需手动按钮。 */
async function onQuizComplete() {
  if (!detail.value || detail.value.progressStatus === 'learned') return
  uni.showToast({ title: '写对啦！🎉', icon: 'none' })
  try {
    const updated = await recordStudy(characterId, 'complete')
    detail.value.progressStatus = updated.progressStatus
    markProgressLocally(updated.progressStatus)
  } catch (err) {
    uni.showToast({ title: (err as Error).message || '进度上报失败', icon: 'none' })
  }
}

function markProgressLocally(status: ProgressStatus) {
  // 列表缓存同字卡状态联动，返回列表无需刷新。
  useLiteracyStore().applyProgress(characterId, status)
}

function statusLabel(status: ProgressStatus) {
  return STATUS_LABEL[status]
}

function statusClass(status: ProgressStatus) {
  return STATUS_CLASS[status]
}

onLoad((query) => {
  characterId = Number(query?.id ?? 0)
  if (characterId > 0) {
    load(characterId)
  } else {
    loadFailed.value = true
  }
})

onUnload(() => {
  audioCtx?.destroy()
  audioCtx = null
})
</script>

<style scoped lang="scss">
.container {
  padding: 32rpx;
  min-height: 100vh;
}
.hero {
  display: flex;
  align-items: center;
  gap: 40rpx;
  background: #fff;
  padding: 40rpx;
  border-radius: $learnly-radius-lg;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
}
.char-display {
  width: 200rpx;
  height: 200rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2rpx solid #e5e7eb;
  border-radius: $learnly-radius-md;
  background:
    linear-gradient(to right, transparent calc(50% - 1rpx), #e5e7eb calc(50% - 1rpx), #e5e7eb calc(50% + 1rpx), transparent calc(50% + 1rpx)),
    linear-gradient(to bottom, transparent calc(50% - 1rpx), #e5e7eb calc(50% - 1rpx), #e5e7eb calc(50% + 1rpx), transparent calc(50% + 1rpx)),
    #fff;
}
.char {
  font-size: 120rpx;
  color: $learnly-text;
  font-family: 'Kaiti SC', 'KaiTi', 'STKaiti', serif;
}
.meta {
  flex: 1;
}
.pinyin {
  font-size: 56rpx;
  font-weight: 700;
  color: $learnly-primary;
}
.meta-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin: 12rpx 0 20rpx;
}
.strokes,
.level {
  font-size: 26rpx;
  color: $learnly-text-light;
}
.status-badge {
  padding: 2rpx 16rpx;
  border-radius: 999rpx;
  font-size: 22rpx;

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
.btn-audio {
  margin: 0;
  height: 72rpx;
  line-height: 72rpx;
  background: rgba($learnly-primary, 0.12);
  color: $learnly-primary;
  font-size: 28rpx;
  border-radius: $learnly-radius-md;

  &[disabled] {
    opacity: 0.5;
    background: rgba($learnly-primary, 0.12);
    color: $learnly-primary;
  }
}
.section {
  margin-top: 32rpx;
  background: #fff;
  padding: 32rpx;
  border-radius: $learnly-radius-lg;
}
.section-title {
  display: block;
  font-size: 30rpx;
  font-weight: 700;
  color: $learnly-text;
  margin-bottom: 12rpx;
}
.definition {
  font-size: 30rpx;
  color: $learnly-text;
  line-height: 1.6;
}
.mode-tabs {
  display: flex;
  gap: 16rpx;
  margin-top: 32rpx;
}
.tab {
  flex: 1;
  text-align: center;
  padding: 20rpx 0;
  background: #fff;
  border-radius: 999rpx;
  font-size: 30rpx;
  color: $learnly-text-light;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);

  &.active {
    background: $learnly-primary;
    color: #fff;
  }
}
.board-wrap {
  margin-top: 32rpx;
  padding: 24rpx;
  background: #fff;
  border-radius: $learnly-radius-lg;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
}
.board-actions {
  display: flex;
  align-items: center;
  gap: 24rpx;
  margin-top: 24rpx;
}
.btn-action {
  margin: 0;
  height: 80rpx;
  line-height: 80rpx;
  padding: 0 40rpx;
  background: $learnly-primary;
  color: #fff;
  font-size: 28rpx;
  border-radius: $learnly-radius-md;

  &.ghost {
    background: #fff;
    color: $learnly-primary;
    border: 2rpx solid $learnly-primary;
  }
}
.quiz-hint {
  flex: 1;
  font-size: 24rpx;
  color: $learnly-text-light;
}
.fallback-text {
  font-size: 28rpx;
  color: $learnly-text-light;
}
.empty {
  text-align: center;
  padding: 120rpx 0;
  color: $learnly-text-light;
  font-size: 28rpx;
}
</style>
