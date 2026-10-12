import { defineConfig } from 'vitest/config'

// 仅测逻辑层纯模块（node 环境），组件/canvas/触屏行为由构建 + 人工冒烟覆盖。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
