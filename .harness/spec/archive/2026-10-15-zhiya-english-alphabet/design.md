## Context

识字模块（literacy-module）已交付完整前端模式：列表/详情页、`<hanzi-writer-board>` 书写板（H5/app renderjs + mp-weixin canvas 双分支）、`hanzi-data/` 笔顺数据（import.meta.glob 打包）、`static/audio/` 读音 mp3、进度 store。英语模块当前只有首页一个"待开发"入口。

关键约束：
- 26 字母为静态集合，验收标准不含进度上报与登录守卫
- hanzi-writer 引擎消费 HanziData（strokes + medians），社区无现成拉丁字母同构数据
- renderjs 跨逻辑层/视图层通信只能传可序列化 spec 对象，不能传函数
- mp-weixin 端 canvas 有固定高度兜底（560rpx），aspect-ratio 不被全部基础库支持

## Goals / Non-Goals

**Goals:**

- 26 字母页签页 + 字母列表 + 字母详情，交互模式与识字模块对齐
- 大小写 52 字形在四线三格中笔顺演示与触屏书写判定，复用现有引擎零改动
- 字母名读音播放，构建期内嵌
- 前端 type-check（linter 零 error）+ vitest 单测通过

**Non-Goals:**

- 进度上报/登录守卫（v1，验收标准未要求；后端零改动的前提）
- phonics（字母在单词中的发音）教学，v1 只做 letter name
- 新后端实体/API、数据库 schema 变更
- 字母书写进度持久化

## Decisions

### D1: 笔顺数据 = 自产生成器，HanziData 同构

**选择**：新增 `frontend/scripts/gen-letter-data.mjs`——52 字形（A–Z 大小写）人工定义教学笔顺 median 骨架 → 定宽圆头 offsetting 生成闭合 outline path → 输出与 HanziData 同构 JSON（`frontend/src/hanzi-letter-data/lc-<cp>.json`，`lc` 前缀区分汉字 `u<cp>`）。引擎（HanziWriter create/animate/quiz）与数据加载模式（import.meta.glob）零改动复用。

**替代方案**：
- A) 寻找社区现成拉丁字母 hanzi-writer 格式数据集 —— 探索确认不存在（hanzi-writer-data 仅覆盖 CJK），手转 SVG 字形库笔顺信息缺失，质量不可控 → 不采用
- B) 引入第二套字母笔顺引擎（如 stroke-based 教学库）—— 双引擎意味着 quiz 判定/动画/容差逻辑全部重写，违背复用目标，包体积翻倍 → 不采用

**理由**：引擎的全部输入就是 HanziData，只要数据同构即可白嫖渲染、动画、严格笔顺判定、儿童容差、提示轨迹整套能力；生成器可校验（52 文件齐全、path 可渲染、medians 单调）保证质量下限。

### D2: 书写板泛化 = source/grid 字符串 props

**选择**：`<hanzi-writer-board>` 新增 `source: 'hanzi' | 'letter'`（数据加载分支）与 `grid: 'tian' | 'fourline'`（背景格线分支）两个 String prop，默认值保持现行为（hanzi/tian），识字页零改动。renderjs spec 对象与 mp 桥接 context 同步透传。

**替代方案**：
- A) 复制独立 `letter-writer-board.vue` —— 约 450 行双分支逻辑全量重复，后续修复需双改 → 不采用
- B) 传入数据加载函数 prop —— renderjs spec 跨逻辑层/视图层序列化不支持函数（架构限制）→ 不采用

**理由**：字符串 prop 天然可序列化、向后兼容（默认值即旧行为）；分支收敛在组件内部，页面无感知。

### D3: 读音 = letter name，edge-tts 英文音色构建期生成

**选择**：`gen-audio.py` 增加 `--lang en` 变体：voice `en-US-AnaNeural`（童声，适配儿童产品），文本为字母名（"A"…"Z"），产物 `static/audio/letter-<lowercase>.mp3` 共 26 个，复用现有重试/幂等跳过/缺字清单机制。前端 `utils/english.ts` 提供 `letterAudioPath(letter)`。

**替代方案**：
- A) 运行时 TTS 合成（Web Speech / 云 TTS API）—— mp 端 Web Speech 支持残缺、云 API 引入网络依赖与延迟，弱网下儿童体验崩坏 → 不采用
- B) 读音用 phonics 发音 —— 验收标准"展示字母读音"以 letter name 为共识（页签教学基础），phonics 属 v2 → 不采用

**理由**：与识字读音完全同构（静态 mp3 + InnerAudioContext + onError 降级置灰），构建期产出零运行时成本。

### D4: 页面结构 = 页签页 + 字母列表 + 详情页三段式，对齐识字模式

**选择**：`pages/english/tabs.vue`（26 字母锚点页签）→ `pages/english/list.vue`（26 字母卡网格，大写+小写预览）→ `pages/english/detail.vue`（四线三格大小写演示 + 书写 + 读音按钮）。首页"知芽英语"直接 navigateTo，无登录守卫。

**替代方案**：
- A) 单页长滚动字母表（页签锚点跳转 + 展开）—— 详情级交互（演示/书写/读音）无处安放，页面过长儿童难操作 → 不采用
- B) 复用 literacy list/detail 页面加模块参数 —— 识字页深度耦合进度 API、登录守卫、store 统计，参数化会把两模块焊死 → 不采用

**理由**：与识字模块同构的页面拓扑让儿童零学习成本切换模块；静态数据使英语页无需登录/进度逻辑，页面更薄。

### D5: 数据加载 = 独立 `hanzi-letter-data/` 目录 + `getLetterData()`

**选择**：新建 `frontend/src/hanzi-letter-data/index.ts`，`import.meta.glob('./lc-*.json')` 模式与 hanzi-data 平行，导出 `getLetterData(char: 'A'|'a'|…) : HanziData | null` 与 `hasLetterData()`。组件按 `source` prop 选加载器。

**替代方案**：
- A) 混入现有 `hanzi-data/u*.json` glob —— 码点不同（41–5A/61–7A vs 4E00+）但文件名模式冲突风险与语义混淆，且 270 字全量 glob 被字母模块连带打包 → 不采用
- B) 单个大 JSON 文件（52 字形合并）—— 失去按字懒加载粒度；但 52 字形总量小（<100KB），此处损失可接受，选 glob 仅为与 hanzi-data 模式一致 → 不采用 B 是因为一致性优先

**理由**：目录隔离让 `getHanziData`/`getLetterData` 各自可独立测试与裁剪；同构类型从 hanzi-data 复用导出。

## Risks / Trade-offs

- [mp 端 canvas 兜底高度与四线三格背景错位（识字模块 MP17-07 同类问题在异形格线上的复现）] → 四线格线全部用 rpx 比例渐变绘制（与 boardSize 同源换算），三端冒烟逐端截图比对
- [人工定义的 52 条 median 骨架笔画顺序/形状与教学规范有偏差] → 生成器内置校验（笔画数符合字形常识、median 折线单调、path 可解析），52 字形逐一目测校验清单进 tasks；quiz 判定空间容差沿用 leniency 1.6 放宽
- [52 字形 JSON 使 bundle 增大] → 预估 <100KB（对照 hanzi-data 956KB/270 字），静态集合无懒加载必要，打包体积可接受
- [edge-tts 网络抖动导致音频缺失] → 复用现有 3 次重试 + 幂等跳过 + 非 0 退出缺字清单；前端 onError 降级置灰按钮
- [四线三格只对字母有意义，board 组件双格线分支增加复杂度] → grid 分支仅 CSS 背景 + padding 差异，逻辑分支数控制在 2 处以内

## Migration Plan

纯前端新增 + 组件向后兼容泛化（默认 props 即旧行为），无数据迁移、无部署顺序依赖。构建期先生成数据（gen-letter-data.mjs → gen-audio.py），再实现页面。回滚 = revert 前端提交，无残留状态。

## Open Questions

无 open P0。遗留 P1/P2（explore 已记录，非阻塞）：mp 端 board 高度换算精度、letter name 音频的语速档位（默认放慢 -20% 与中文一致，三端试听后可调）。
