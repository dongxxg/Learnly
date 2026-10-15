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
├── scripts/desktop/main.cjs   # Electron 桌面测试壳（加载 H5 构建产物）
└── Dockerfile                 # H5 构建产物 + nginx 反代
```

## 本地运行

```bash
npm install
npm run dev:h5            # H5 开发：http://localhost:5173
npm run dev:mp-weixin     # 微信小程序（用微信开发者工具打开 dist/dev/mp-weixin）
```

## 桌面测试壳（Electron）

Windows/Mac 桌面端跑 H5 构建产物，用于触屏/真机前的本地测试：

```bash
npm run app:desktop       # dev 模式构建 H5 + 启动桌面窗口（改动代码后用这个）
npm run desktop           # 直接用现有 dist/build/h5 启动窗口
```

原理：`scripts/desktop/main.cjs` 在本地起 `127.0.0.1` 随机端口静态服务加载 `dist/build/h5`（规避 `file://` 下 `/static` 绝对路径失效），仅绑定回环地址。dev 模式构建（`build:h5:dev`）会内嵌 `.env.development` 的 `VITE_API_BASE_URL`，API 直连局域网 backend；纯前端模块（如数学口算）不依赖 backend。

### Electron 二进制下载失败

npm 直连 GitHub Releases 下载 Electron 二进制可能失败（报 `Electron failed to install`），用镜像重装：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js
```

## 关于 uni-app 依赖版本

`@dcloudio/*` 使用**日期型 tag**（如 `3.0.0-4060620250520001`），随官方发布滚动。
若 `npm install` 报版本不存在，用官方模板刷新 `package.json` 版本即可（src/ 内容不受影响）：

```bash
npx degit dcloudio/uni-preset-vue#vite-ts /tmp/ref && \
  diff package.json /tmp/ref/package.json   # 对齐版本号
```

生产部署（H5）由 `Dockerfile` 构建，nginx 通过 `/api/` 反代到 backend、`/ai/` 反代到 ai-service（见 `nginx.conf`）。
