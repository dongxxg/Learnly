<template>
  <view class="container">
    <!-- 字母卡头部：大小写 + 读音 -->
    <view class="hero">
      <view class="glyph-display">
        <text class="glyph">{{ letter }}{{ lower }}</text>
      </view>
      <view class="meta">
        <text class="letter-title">字母 {{ letter }}</text>
        <text class="letter-tip">读作 “{{ letter }}”，点一下听读音</text>
        <button class="btn-audio" :disabled="audioBroken" @tap="playAudio">
          🔊 {{ audioBroken ? '读音不可用' : '听读音' }}
        </button>
      </view>
    </view>

    <!-- 笔顺字帖（img.png 样式）：大小写并排共享四线格 + 序号 + 方向箭头 -->
    <template v-if="hasCopybook">
      <view class="section-title-bar">
        <text class="section-label">笔顺字帖</text>
      </view>
      <view class="board-wrap">
        <letter-copybook :letter="letter" />
      </view>
      <text class="copybook-hint">数字是笔顺、箭头指方向，伸出小手跟着写吧</text>
    </template>

    <!-- 大写：四线三格演示 + 书写 -->
    <template v-if="hasUpperData">
      <view class="section-title-bar">
        <text class="section-label">大写 {{ letter }} · 看笔顺</text>
      </view>
      <view class="board-wrap">
        <hanzi-writer-board
          ref="upperAnimBoard"
          :char="letter"
          source="letter"
          grid="fourline"
          mode="animation"
          :auto-play="true"
        />
      </view>
      <view class="board-actions">
        <button class="btn-action" @tap="replay(upperAnimBoard)">▶ 再看一遍</button>
      </view>

      <view class="section-title-bar">
        <text class="section-label">大写 {{ letter }} · 写一写</text>
      </view>
      <view class="board-wrap">
        <hanzi-writer-board
          ref="upperQuizBoard"
          :char="letter"
          source="letter"
          grid="fourline"
          mode="quiz"
          :auto-play="false"
          @stroke-result="onStrokeResult"
          @quiz-complete="onQuizComplete"
        />
      </view>
      <view class="board-actions">
        <button class="btn-action ghost" @tap="retryQuiz(upperQuizBoard)">↺ 重写</button>
        <text class="quiz-hint">按笔顺在四线格里写，写对全部 {{ upperStrokes }} 笔就成功啦</text>
      </view>
    </template>
    <view v-else class="section fallback">
      <text class="fallback-text">大写 {{ letter }} 的笔顺资料还没准备好，先听听读音、认认样子吧</text>
    </view>

    <!-- 小写：四线三格演示 + 书写 -->
    <template v-if="hasLowerData">
      <view class="section-title-bar">
        <text class="section-label">小写 {{ lower }} · 看笔顺</text>
      </view>
      <view class="board-wrap">
        <hanzi-writer-board
          ref="lowerAnimBoard"
          :char="lower"
          source="letter"
          grid="fourline"
          mode="animation"
          :auto-play="true"
        />
      </view>
      <view class="board-actions">
        <button class="btn-action" @tap="replay(lowerAnimBoard)">▶ 再看一遍</button>
      </view>

      <view class="section-title-bar">
        <text class="section-label">小写 {{ lower }} · 写一写</text>
      </view>
      <view class="board-wrap">
        <hanzi-writer-board
          ref="lowerQuizBoard"
          :char="lower"
          source="letter"
          grid="fourline"
          mode="quiz"
          :auto-play="false"
          @stroke-result="onStrokeResult"
          @quiz-complete="onQuizComplete"
        />
      </view>
      <view class="board-actions">
        <button class="btn-action ghost" @tap="retryQuiz(lowerQuizBoard)">↺ 重写</button>
        <text class="quiz-hint">按笔顺在四线格里写，写对全部 {{ lowerStrokes }} 笔就成功啦</text>
      </view>
    </template>
    <view v-else class="section fallback">
      <text class="fallback-text">小写 {{ lower }} 的笔顺资料还没准备好，先听听读音、认认样子吧</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onLoad, onUnload } from '@dcloudio/uni-app'
import { computed, ref } from 'vue'
import HanziWriterBoard from '@/components/hanzi-writer-board.vue'
import LetterCopybook from '@/components/letter-copybook.vue'
import { getLetterData, hasLetterData } from '@/hanzi-letter-data'
import { LETTERS, letterAudioPath, toLowerLetter, toUpperLetter } from '@/utils/english'

type BoardRef = InstanceType<typeof HanziWriterBoard> | null

const letter = ref('A')
const lower = computed(() => toLowerLetter(letter.value))
const audioBroken = ref(false)

const upperAnimBoard = ref<BoardRef>(null)
const upperQuizBoard = ref<BoardRef>(null)
const lowerAnimBoard = ref<BoardRef>(null)
const lowerQuizBoard = ref<BoardRef>(null)

// spec：某字形笔顺数据缺失 → 隐藏对应演示/书写入口并文案兜底，不白板、不报错。
const hasUpperData = computed(() => hasLetterData(letter.value))
const hasLowerData = computed(() => hasLetterData(lower.value))
/** 字帖卡：大小写任一有数据即展示（缺失侧自动不占位）。 */
const hasCopybook = computed(() => hasUpperData.value || hasLowerData.value)
const upperStrokes = computed(() => getLetterData(letter.value)?.strokes.length ?? 0)
const lowerStrokes = computed(() => getLetterData(lower.value)?.strokes.length ?? 0)

let audioCtx: UniApp.InnerAudioContext | null = null

function initAudio() {
  audioCtx?.destroy()
  audioCtx = uni.createInnerAudioContext()
  audioCtx.src = letterAudioPath(letter.value) ?? ''
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

function replay(board: BoardRef) {
  board?.play()
}

function retryQuiz(board: BoardRef) {
  board?.startQuiz()
}

function onStrokeResult(payload: { type: string; strokeNum: number }) {
  if (payload.type === 'mistake') {
    uni.vibrateShort?.({})
  }
}

/** v1 静态集合：书写全部通过仅给成功反馈，无进度上报。 */
function onQuizComplete() {
  uni.showToast({ title: '写对啦！🎉', icon: 'none' })
}

onLoad((query) => {
  const requested = toUpperLetter(String(query?.letter ?? 'A'))
  letter.value = LETTERS.includes(requested) ? requested : 'A'
  // initAudio()
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
.glyph-display {
  width: 200rpx;
  height: 200rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2rpx solid #e5e7eb;
  border-radius: $learnly-radius-md;
  background: #fff;
}
.glyph {
  font-size: 100rpx;
  font-weight: 800;
  color: $learnly-primary;
}
.meta {
  flex: 1;
}
.letter-title {
  font-size: 48rpx;
  font-weight: 700;
  color: $learnly-text;
}
.letter-tip {
  display: block;
  margin: 8rpx 0 20rpx;
  font-size: 26rpx;
  color: $learnly-text-light;
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
.section-title-bar {
  margin-top: 40rpx;
  margin-bottom: 16rpx;
}
.section-label {
  font-size: 30rpx;
  font-weight: 700;
  color: $learnly-text;
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
.copybook-hint {
  display: block;
  margin-top: 16rpx;
  font-size: 24rpx;
  color: $learnly-text-light;
}
.fallback-text {
  font-size: 28rpx;
  color: $learnly-text-light;
}
</style>
