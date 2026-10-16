<template>
  <button class="l-btn-reset" :class="cls" :disabled="disabled" @tap="onTap">
    <slot />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { btnClass, type BtnSize, type BtnType } from './variants'

const props = withDefaults(
  defineProps<{ type?: BtnType; size?: BtnSize; disabled?: boolean }>(),
  { type: 'primary', size: 'md', disabled: false },
)
const emit = defineEmits<{ (e: 'tap'): void }>()

const cls = computed(() => btnClass(props.type, props.size, props.disabled))
function onTap() {
  if (!props.disabled) emit('tap')
}
</script>

<style scoped lang="scss">
/* mp-weixin button 默认样式 reset：外边距/边框(::after)/行高全部清零 */
.l-btn-reset {
  display: block;
  width: 100%;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: $learnly-radius-md;
  background: none;
  line-height: normal;
  font-size: $learnly-fs-md;
  transition: transform 0.1s ease;
}
.l-btn-reset::after {
  border: none;
}

.l-btn {
  color: $learnly-surface;
  text-align: center;
}
.l-btn--primary {
  background: linear-gradient(135deg, $learnly-primary 0%, $learnly-primary-deep 100%);
}
.l-btn--soft {
  background: $learnly-primary-soft;
  color: $learnly-primary-deep;
}
.l-btn--ghost {
  background: transparent;
  color: $learnly-primary;
  border: 2rpx solid $learnly-border;
}
.l-btn--danger {
  background: $learnly-danger;
}
.l-btn--disabled {
  opacity: 0.45;
}

.l-btn--lg {
  padding: 24rpx 0;
  font-size: $learnly-fs-lg;
  border-radius: $learnly-radius-lg;
}
.l-btn--md {
  padding: 18rpx 0;
}
.l-btn--sm {
  padding: 10rpx 24rpx;
  display: inline-block;
  width: auto;
  font-size: $learnly-fs-sm;
  border-radius: $learnly-radius-sm;
}

/* 按压反馈（motion-feedback：transform-only ≤100ms） */
.l-btn--pressed {
  transform: scale(0.97);
  opacity: 0.9;
}
</style>
