# literacy-module 三端冒烟清单

> 对应任务 11.3 / 14.5 / 16.3。AI 已完成降险验证：`vue-tsc` 零错误、H5 与 mp-weixin 构建成功、
> 静态资源（270 mp3 + 笔顺 JSON）已内嵌双端产物。以下全部为人工执行项。

## 0. 启动环境（三端共用）

1. **后端**（二选一）：
   - Docker：`cd deploy && docker compose up -d postgres redis backend`
     日志出现 `[seed] characters: inserted=..., skipped=...` 即启动正常（`docker logs learnly-backend`）
   - 本地：自备 postgres/redis，然后：
     ```bash
     cd backend
     SERVER_PORT=8080 SERVER_MODE=debug \
     POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5432 \
     POSTGRES_USER=learnly POSTGRES_PASSWORD=learnly POSTGRES_DBNAME=learnly \
     JWT_SECRET=<任意非空字符串> \
     go run ./cmd/server
     ```
     JWT_SECRET 为空会 fail-fast 拒绝启动（符合预期）
2. **探活**：浏览器/curl 访问 `http://localhost:8080/healthz` 返回 200
3. **前端 H5**：`cd frontend && npm run dev:h5`（`.env.development` 已指向 `http://localhost:8080`）
4. **微信小程序**：`npm run dev:mp-weixin`（watch 模式，产物在 `dist/dev/mp-weixin`）

## 1. H5 浏览器冒烟（任务 11.3 前半 + 14.5 H5 部分）

Chrome 打开 dev server 地址 → F12 切手机仿真（如 iPhone 12，触屏书写依赖 touch 模拟）：

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 注册新账号（手机号+密码）→ 登录 | 进入首页，重复注册同号提示已存在 |
| 2 | 创建儿童档案 → 切换档案 | 切换后列表/进度缓存重置 |
| 3 | 首页"知芽识字"卡片 → 进入列表 | 按 简单→复杂（先 level 后笔画）排序；下拉刷新、上拉加载更多；按难度筛选生效；每字带进度角标 |
| 4 | 点开一个"未学"字 | 详情页展示拼音/释义/笔画数；进度标识变"在学"（自动上报 start） |
| 5 | 点发音按钮 | 播放该字读音 |
| 6 | 笔顺演示区 | 逐笔动画演示，重播按钮可用 |
| 7 | "写一写"按笔顺书写 | 正确笔顺逐笔变色；故意乱序被拒；同一笔连错 2 次出现灰色提示轨迹；全部写对出现完成庆祝动效 |
| 8 | 写对后观察进度 | 自动上报 complete，详情页进度标识变"已学" |
| 9 | 返回列表 → 首页统计入口 | 该字角标已刷新；统计 learned/learning/unlearned/total 数字正确 |
| 10 | token 过期场景（可选）：改 localStorage 里 token 为乱串后请求 | 弹"登录已过期"并跳登录页 |

## 2. 微信开发者工具冒烟（任务 11.3 后半 + 14.5 微信部分）

1. 打开微信开发者工具 → 导入项目 → 目录选 `frontend/dist/dev/mp-weixin`，AppID 用测试号（或"体验模式"）
2. **详情 → 本地设置 → 勾选「不校验合法域名」**（backend 是 http://localhost，否则请求全挂）
3. 重复上表 1–10 步（书写区用鼠标模拟触屏）
4. 重点回归：mp-weixin 端 hanzi 数据为独立包 `hanzi-data/index.js`（583K），确认详情页笔顺动画/书写正常加载

## 3. app 自定义基座 + 真机冒烟（任务 14.5 app 部分 + 16.3）

前置：DCloud appid + keystore 生成，步骤见 `docs/app-packaging.md`（标注【用户操作】部分）。

1. HBuilderX 打开 `frontend` → 运行 → 运行到手机 → **制作自定义调试基座**（云打包一次）
2. 基座装到真机后：运行 → 运行到手机 → 选自定义基座 + 真机
3. **14.5 app 部分**：详情页书写区真机手指书写——重点验证 webview 内 touch 时序（与 H5 鼠标行为有差异）：落笔跟随、判定反馈、提示轨迹、庆祝动效
4. **16.3 全闭环**：注册/登录 → 建档案/切换 → 首页识字卡片 → 列表排序/分页/筛选 → 详情读音 → 笔顺演示 → 书写（乱序被拒、连错出提示、通过庆祝）→ 进度自动变"已学" → 返回列表角标刷新 → 统计数字正确
5. 后端地址注意：真机访问 `localhost` 不可达，需把 `.env` / VITE_API_BASE_URL 指向局域网 IP（如 `http://192.168.x.x:8080`）后重新打基座，或临时用 HBuilderX 内置控制台确认请求命中

## 结果回报格式

逐项回 `✓ / ✗（现象）` 即可，例如：
`H5-7 ✗ 连错 2 次未出现灰色提示轨迹`
AI 按回报结果更新 tasks.md 勾选状态；有 ✗ 则修复后回归。
