import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

// uni-app Vue3 + TS + Vite 入口
export default defineConfig({
  plugins: [uni()],
})
