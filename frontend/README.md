# Learnly Frontend

uni-app + Vue3 + TypeScript。一套代码多端发布（H5 / 微信小程序 / App），承载识字 / 英语 / 数学 / AI 老师 / 家长助手 5 个模块。

## 目录结构

```
frontend/
├── src/
│   ├── main.ts                # 应用入口（createSSRApp）
│   ├── App.vue                # 根组件
│   ├── pages.json             # 页面路由（uni-app）
│   ├── manifest.json          # 多端 manifest（appid 等）
│   ├── uni.scss               # 全局设计 token
│   ├── pages/index/           # 首页（5 模块入口）
│   ├── api/                   # 请求封装（uni.request）+ 各模块 API
│   ├── stores/                # Pinia 状态（待填充）
│   ├── components/            # 公共组件（待填充）
│   └── static/                # 静态资源
├── vite.config.ts
├── tsconfig.json
└── Dockerfile                 # H5 构建产物 + nginx 反代
```

## 本地运行

```bash
npm install
npm run dev:h5            # H5 开发：http://localhost:5173
npm run dev:mp-weixin     # 微信小程序（用微信开发者工具打开 dist/dev/mp-weixin）
```

## 关于 uni-app 依赖版本

`@dcloudio/*` 使用**日期型 tag**（如 `3.0.0-4060620250520001`），随官方发布滚动。
若 `npm install` 报版本不存在，用官方模板刷新 `package.json` 版本即可（src/ 内容不受影响）：

```bash
npx degit dcloudio/uni-preset-vue#vite-ts /tmp/ref && \
  diff package.json /tmp/ref/package.json   # 对齐版本号
```

生产部署（H5）由 `Dockerfile` 构建，nginx 通过 `/api/` 反代到 backend、`/ai/` 反代到 ai-service（见 `nginx.conf`）。
