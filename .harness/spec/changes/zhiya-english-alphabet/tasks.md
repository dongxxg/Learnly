## 1. 数据管线（生成器 + 读音）

- [ ] 1.1 新增 `frontend/scripts/gen-letter-data.mjs`：52 字形（A–Z 大小写）教学笔顺 median 骨架 → 定宽圆头 offsetting 生成闭合 outline path → 输出 HanziData 同构 JSON 至 `frontend/src/hanzi-letter-data/lc-<码点>.json`；内置校验（52 文件齐全、strokes/medians 数量一致、path 可解析）
- [ ] 1.2 运行生成器并对 52 字形逐一目测校验笔顺与形状（对照小学字母书写规范），偏差骨架修正后重跑
- [ ] 1.3 `frontend/scripts/gen-audio.py` 增加 `--lang en` 分支：voice `en-US-AnaNeural`、语速放慢，生成 26 个 `static/audio/letter-<lowercase>.mp3`（复用重试/幂等/缺字退出机制）
- [ ] 1.4 新增 `frontend/src/hanzi-letter-data/index.ts`：`import.meta.glob('./lc-*.json')` + `getLetterData()`/`hasLetterData()`，复用 hanzi-data 的 HanziData 类型
- [ ] 1.5 新增 vitest 单测：getLetterData 52 字形全量可取、未知字形返回 null、lc- 前缀不与 hanzi-data 交叉污染

## 2. 书写板组件泛化

- [ ] 2.1 `components/hanzi-writer-board.vue` 新增 `source`（'hanzi'|'letter'，默认 hanzi）与 `grid`（'tian'|'fourline'，默认 tian）props；H5/app renderjs 分支：spec 对象透传、按 source 选 `getHanziData`/`getLetterData`、按 grid 切四线三格背景 CSS
- [ ] 2.2 mp-weixin 分支：canvas 路径同步透传 source/grid（`createBoardContext` 加载器参数化），四线格线与 boardSize 兜底高度同源换算防错位
- [ ] 2.3 识字页回归：默认 props 下识字列表/详情行为不变（田字格、笔顺演示、书写判定冒烟）

## 3. 页面与导航

- [ ] 3.1 新增 `frontend/src/utils/english.ts`：`LETTERS`（A–Z 常量）、`letterAudioPath(letter)`、大小写字形工具
- [ ] 3.2 新增 `pages/english/tabs.vue`：26 字母页签页（锚点页签，进入字母列表）
- [ ] 3.3 新增 `pages/english/list.vue`：26 字母卡网格（大写+小写预览，A→Z 排序，点击进详情）
- [ ] 3.4 新增 `pages/english/detail.vue`：大小写四线三格笔顺演示（可重播）+ 留空书写区（quiz 判定、连错提示、成功反馈）+ 读音按钮（onError 置灰降级）+ 数据缺失兜底文案
- [ ] 3.5 `pages.json` 注册三个英语页面；`pages/index/index.vue` "知芽英语"入口改为 navigateTo（无登录守卫）
- [ ] 3.6 新增 vitest 单测：letterAudioPath 路径正确、LETTERS 顺序与数量

## 4. 质量门禁

- [ ] 4.1 eslint 零 error、type-check（vue-tsc）通过
- [ ] 4.2 vitest 全量通过（既有用例 + 新增用例）
- [ ] 4.3 三端冒烟：H5 / app 基座 / 微信开发者工具打开页签→列表→详情全流程，截图比对四线三格与字形不错位，书写判定与读音播放可用
