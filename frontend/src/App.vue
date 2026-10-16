<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app'

onLaunch(() => {
  // 全局初始化（埋点、登录态恢复等）
})
</script>

<style lang="scss">
/* CSS 变量双轨（运行时）：与 uni.scss 的 SCSS 变量同值，受 design-tokens.sync.test.ts 守护。
   供 keyframes/条件样式等运行时场景使用；静态样式优先用 SCSS 变量。 */
page {
  /* 品牌色 */
  --learnly-primary: #4CAF7A;
  --learnly-primary-deep: #3E9163;
  --learnly-primary-soft: #E8F6EE;
  --learnly-secondary: #FFB43D;
  --learnly-secondary-soft: #FFF3DE;
  /* 状态色 */
  --learnly-success: #4CAF7A;
  --learnly-warning: #E67E22;
  --learnly-danger: #E05252;
  --learnly-danger-soft: #FDECEC;
  --learnly-info: #5B8DEF;
  /* 中性色 */
  --learnly-surface: #FFFFFF;
  --learnly-bg: #F7F8FA;
  --learnly-text: #1F2937;
  --learnly-text-secondary: #4B5563;
  --learnly-text-light: #9CA3AF;
  --learnly-border: #E5E7EB;
  --learnly-border-light: #F3F4F6;
  /* 字阶 */
  --learnly-fs-xs: 20rpx;
  --learnly-fs-sm: 24rpx;
  --learnly-fs-base: 28rpx;
  --learnly-fs-md: 32rpx;
  --learnly-fs-lg: 36rpx;
  --learnly-fs-xl: 44rpx;
  --learnly-fs-3xl: 64rpx;
  --learnly-fs-hero: 88rpx;
  /* 间距 */
  --learnly-space-xs: 16rpx;
  --learnly-space-sm: 24rpx;
  --learnly-space-md: 32rpx;
  --learnly-space-lg: 48rpx;
  /* 圆角 */
  --learnly-radius-sm: 8rpx;
  --learnly-radius-md: 16rpx;
  --learnly-radius-lg: 24rpx;
  /* 阴影 */
  --learnly-shadow-sm: 0 2rpx 12rpx rgba(0, 0, 0, 0.05);
  --learnly-shadow-lg: 0 8rpx 32rpx rgba(31, 41, 55, 0.12);

  background-color: $learnly-bg;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
}
</style>
