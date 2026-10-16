<template>
  <view :class="cls" :hover-class="shadow === 'none' ? '' : 'l-card--pressed'" hover-stay-time="80" @tap="emit('tap')">
    <slot />
  </view>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { cardClass, type CardShadow } from './variants'

const props = withDefaults(defineProps<{ shadow?: CardShadow }>(), { shadow: 'sm' })
const emit = defineEmits<{ (e: 'tap'): void }>()

const cls = computed(() => cardClass(props.shadow))
</script>

<style scoped lang="scss">
.l-card {
  background: $learnly-surface;
  border-radius: $learnly-radius-lg;
  transition: transform 0.1s ease;
}
.l-card--shadow-sm {
  box-shadow: $learnly-shadow-sm;
}
.l-card--shadow-lg {
  box-shadow: $learnly-shadow-lg;
}
.l-card--pressed {
  transform: scale(0.98);
}
</style>
