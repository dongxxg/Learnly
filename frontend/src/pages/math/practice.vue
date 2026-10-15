<template>
  <view class="container">
    <!-- 非法 range 参数时 800ms 退回窗口内不渲染，避免对空历史取属性崩溃 -->
    <template v-if="isReady">
      <view class="topbar">
        <text class="progress">第 {{ index + 1 }} 题</text>
        <text class="range-tag">{{ rangeLabel(range) }}</text>
      </view>

    <!-- 题目区：作答中白底、答对绿底、答错红底 -->
    <view class="question-card" :class="`is-${current.status}`">
      <view class="question">
        <text class="num">{{ current.problem.a }}</text>
        <text class="op">{{ current.problem.op }}</text>
        <text class="num">{{ current.problem.b }}</text>
        <text class="op">=</text>
        <text class="answer" :class="{ filled: current.input !== '' }">{{ current.input || '?' }}</text>
      </view>
      <text v-if="current.status === 'correct'" class="feedback ok">答对啦！点「下一题」继续</text>
      <text v-else-if="current.status === 'wrong'" class="feedback bad">不对哦，再试一次</text>
      <text v-else class="feedback hint">按下面的数字键作答</text>
    </view>

    <!-- 前后翻题：上一题回看历史可重答，下一题出新题 -->
    <view class="nav-row">
      <button class="nav-btn" :disabled="!canPrev" @tap="goPrev">‹ 上一题</button>
      <button class="nav-btn primary" @tap="goNext">下一题 ›</button>
    </view>

    <!-- 触屏数字键盘：⌫ 删除，✓ 判定 -->
    <view class="keypad">
      <view v-for="(row, rowIndex) in KEYPAD_ROWS" :key="rowIndex" class="key-row">
        <button
          v-for="key in row"
          :key="key"
          class="key"
          :class="{ 'key-confirm': key === KEY_CONFIRM, 'key-sub': key === KEY_BACKSPACE }"
          @tap="pressKey(key)"
        >
          {{ key }}
        </button>
      </view>
    </view>
    </template>
  </view>
</template>

<script setup lang="ts">
/** 加减法口算练习：随机出题 → 触屏键盘作答 → ✓ 自动判定 → 上一题/下一题。 */
import { computed, ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { generateProblem, judgeAnswer, maxInputLength, MATH_RANGES, rangeLabel } from '@/utils/math'
import type { MathProblem } from '@/utils/math'

/** 练习历史条目：题目 + 当前输入 + 判定状态（答错可重答）。 */
interface PracticeEntry {
  problem: MathProblem
  input: string
  status: 'answering' | 'correct' | 'wrong'
}

const KEY_BACKSPACE = '⌫'
const KEY_CONFIRM = '✓'
/** 键盘布局：末行 ⌫ / 0 / ✓。 */
const KEYPAD_ROWS: readonly string[][] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  [KEY_BACKSPACE, '0', KEY_CONFIRM],
]

const range = ref(10)
const entries = ref<PracticeEntry[]>([])
const index = ref(0)

const current = computed<PracticeEntry>(() => entries.value[index.value]!)
const isReady = computed(() => entries.value.length > 0)
const canPrev = computed(() => index.value > 0)
const inputLimit = computed(() => maxInputLength(range.value))

onLoad((query) => {
  // 输入校验：范围参数必须命中档位，非法提示后退回
  const parsed = Number(query?.range ?? NaN)
  if (!(MATH_RANGES as readonly number[]).includes(parsed)) {
    uni.showToast({ title: '没有这个难度哦', icon: 'none' })
    setTimeout(() => uni.navigateBack(), 800)
    return
  }
  range.value = parsed
  entries.value = [createEntry()]
  index.value = 0
})

function createEntry(): PracticeEntry {
  return { problem: generateProblem(range.value), input: '', status: 'answering' }
}

/** 不可变更新当前条目（map 产新数组，避免原地修改历史）。 */
function updateEntry(patch: Partial<PracticeEntry>) {
  entries.value = entries.value.map((entry, i) => (i === index.value ? { ...entry, ...patch } : entry))
}

function pressKey(key: string) {
  if (key === KEY_BACKSPACE) {
    pressBackspace()
    return
  }
  if (key === KEY_CONFIRM) {
    pressConfirm()
    return
  }
  pressDigit(key)
}

function pressDigit(digit: string) {
  const entry = current.value
  if (entry.status === 'correct' || entry.input.length >= inputLimit.value) {
    return
  }
  // 答错后首次按键直接重开新答案（免连按退格）；首位 0 后按数字为替换（防前导零，得数 0 按 ✓ 判定）
  const base = entry.status === 'wrong' ? '' : entry.input === '0' ? '' : entry.input
  updateEntry({ input: base + digit, status: 'answering' })
}

function pressBackspace() {
  const entry = current.value
  if (entry.status === 'correct') {
    return
  }
  updateEntry({ input: entry.input.slice(0, -1), status: 'answering' })
}

function pressConfirm() {
  const entry = current.value
  if (entry.status === 'correct' || entry.input === '') {
    return
  }
  updateEntry({ status: judgeAnswer(entry.problem, entry.input) ? 'correct' : 'wrong' })
}

function goPrev() {
  if (canPrev.value) {
    index.value -= 1
  }
}

function goNext() {
  // 翻回历史后再前进：回到已浏览的题，不重复出题；已在末尾才出新题
  if (index.value < entries.value.length - 1) {
    index.value += 1
    return
  }
  entries.value = [...entries.value, createEntry()]
  index.value = entries.value.length - 1
}
</script>

<style scoped lang="scss">
.container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  padding: 24rpx 32rpx 32rpx;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.progress {
  font-size: 28rpx;
  font-weight: 700;
  color: $learnly-text;
}
.range-tag {
  padding: 6rpx 24rpx;
  background: #fff;
  border-radius: 999rpx;
  font-size: 24rpx;
  color: $learnly-primary;
}
.question-card {
  margin-top: 24rpx;
  padding: 56rpx 32rpx 40rpx;
  background: #fff;
  border-radius: $learnly-radius-lg;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
  text-align: center;
  transition: background-color 0.2s ease;

  &.is-correct {
    background: #e8f6ee;
  }
  &.is-wrong {
    background: #fdecec;
  }
}
.question {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 20rpx;
}
.num {
  font-size: 88rpx;
  font-weight: 800;
  color: $learnly-text;
  font-variant-numeric: tabular-nums;
}
.op {
  font-size: 64rpx;
  font-weight: 700;
  color: $learnly-text-light;
}
.answer {
  min-width: 120rpx;
  font-size: 88rpx;
  font-weight: 800;
  color: $learnly-text-light;
  font-variant-numeric: tabular-nums;

  &.filled {
    color: $learnly-primary;
  }
}
.is-correct .answer,
.is-correct .feedback.ok {
  color: $learnly-primary;
}
.is-wrong .answer,
.is-wrong .feedback.bad {
  color: #e05252;
}
.feedback {
  display: block;
  margin-top: 24rpx;
  font-size: 26rpx;

  &.hint {
    color: $learnly-text-light;
  }
}
.nav-row {
  display: flex;
  gap: 24rpx;
  margin-top: 24rpx;
}
.nav-btn {
  flex: 1;
  margin: 0;
  padding: 20rpx 0;
  background: #fff;
  border-radius: $learnly-radius-md;
  font-size: 30rpx;
  font-weight: 700;
  color: $learnly-text;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);

  &.primary {
    background: $learnly-primary;
    color: #fff;
  }
  &[disabled] {
    opacity: 0.4;
    color: $learnly-text;
    background: #fff;
  }
}
.keypad {
  margin-top: auto;
  padding-top: 24rpx;
}
.key-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16rpx;

  & + .key-row {
    margin-top: 16rpx;
  }
}
.key {
  margin: 0;
  padding: 24rpx 0;
  background: #fff;
  border-radius: $learnly-radius-md;
  box-shadow: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
  font-size: 44rpx;
  font-weight: 800;
  color: $learnly-text;

  &.key-sub {
    color: $learnly-text-light;
  }
  &.key-confirm {
    background: $learnly-primary;
    color: #fff;
  }
}
</style>
