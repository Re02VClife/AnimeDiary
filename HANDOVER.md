# AnimeDiary 进度与交接

> 最后更新：**2026-11-17** · 当前版本 **1.3.46**
>
> ⚠️ **从 1.3.36 起热更新不够用了**：新增的「拉片分析 / AI 影评」插件带 `plugins/`
> 和 `dsh-video-storyboard` 依赖，**热更新 zip 里没有这些**。每次升级必须覆盖整个
> 程序目录（详见 §0.2），只发热更新会看到新界面但没有 `/api/watch/*` 路由。
>
> 这份文档面向"接手的人 / 下一个 AI 会话"，只写**当前状态、怎么发版、坑在哪**。
> 2026-06 那次架构重构的完整记录在 [`progress.md`](progress.md) —— 那是历史存档，不要改写它。

---

## 0. 2026-11 大更新：拉片分析 + AI 影评

### 0.1 新增了什么

`plugins/watch-analysis/` —— 自包含插件，两个入口（都在番剧详情页的按钮行）：

- **📽️ 拉片分析**：切镜扫描 → 2×3 六格宫格图（1280×1080）→ 弹幕聚合 → 预算记账
- **🎬 AI 影评**：分镜图 + 你自己的 8 维评分 + 弹幕 →  multimodal 模型 → 图文影评 + 时间轴

插件内部严格单向分层：`core → ports → adapters → runtime → server → ui`。
六个 Port（Cut/Transcript/Motion/Music/Sheet/Vision）都可换 adapter，pipeline 不动。
主应用只在 `server/api-routes.ts` 接触它一处（`registerWatchRoutes` + 注入 `resolveLocalFile`）。

### 0.2 部署方式变了（**这是最容易踩的**）

热更新 zip 只含 `dist/` + `server/`，**不含 `plugins/` 和 `node_modules/dsh-video-storyboard`**。
所以升级必须覆盖整个程序目录：

```powershell
Get-Process AnimeDiary | Stop-Process -Force
robocopy release\win-unpacked E:\AnimeDiary /E
# 关键：清掉旧前端缓存，否则启动仍优先加载 web-update 里的旧 dist
Remove-Item "$env:APPDATA\anime-diary\web-update" -Recurse -Force
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 见 §0.5 第 7 条
Start-Process E:\AnimeDiary\AnimeDiary.exe
```

> 用户实际跑的是 **`E:\AnimeDiary` 绿色版目录**（无注册表卸载项）。旧的
> `E:\AnimeDiary.bak-1.3.6` 是回滚备份，含原 `web-update` 快照。

### 0.3 本机额外装的东西（不进仓库）

| 东西 | 位置 | 用途 |
|---|---|---|
| `dsh-video-storyboard` | `node_modules/`（package.json 依赖） | 切镜扫描 + `probeVideo`；2×3 排版**不用**它 |
| MOSS-Transcribe-Diarize | `D:\MOSS-Transcribe-Diarize`（代码）+ `D:\models\MOSS-Transcribe-Diarize`（1.71GB 权重） | 日语语音转写 + **说话人分离** |
| conda env `moss` | `C:\Users\24628\miniconda3\envs\moss` | Python 3.12 + torch 2.10.0+cu128 |
| OXR OCR（可选，不稳定） | 在线 `https://47.243.130.113/v1`，key 见其手册 | 文档/图片 OCR；502 = 显卡在跑 Qwen |

MOSS 通过 `plugins/watch-analysis/adapters/moss_bridge.py` 桥接（输入音频路径 →
stdout 一行 JSON，日志走 stderr），和 `ocr_bridge.py` 是同一个思路：

```bash
"C:\Users\24628\miniconda3\envs\moss\python.exe" \
  plugins/watch-analysis/adapters/moss_bridge.py <audio.wav> \
  --model D:\models\MOSS-Transcribe-Diarize
```

输出格式：

```json
{"ok":true,"segments":[{"start":0.0,"end":7.22,"speaker":"S01","text":"おもし満点。文学賞など多数受賞。"}]}
```

实测：加载 3.8s、推理 0.4× 实时（60s 音频 → 24s）、显存约 3–4GB。

### 0.4 数据落在哪

```text
%USERPROFILE%\Documents\AnimeDiary\
├── 番评分.xlsx         ← 唯一真源；**AI 的评分绝不写进去**
├── watch-reports/      ← 每集报告 + 分镜图（sheets/epN/*.jpg）
├── ai-reviews/         ← 影评（series.json / ep01.json …）
└── local-library.json  ← 本地番剧库绑定
```

### 0.5 这一轮踩过的坑（都修了，重做时会再遇到）

1. **Kazumi 的 HLS 分片被当成"集"**：`1/seg_00000.ts …` 共 1774 个分片，`VIDEO_EXT`
   收了 `.ts` → 一部 6 集的番变 1774 集，拉片只分析了 7 秒。修法：`isVideoFile` 里
   `HLS_SEGMENT = /^seg_?\d+\.(ts|m4s)$/i` 直接排除。整集合并：
   `ffmpeg -i playlist.m3u8 -c copy out.mp4`（0.7 秒/集）。
2. **影评 JSON 被截断**：`maxTokens=6000` 装不下 8 维度 + 正文 → 解析失败。提到 12000。
   后来又发现**上游约 140 秒会掐断长输出**（不是 maxTokens 的问题，输出才 5789 字符），
   所以提示词强制「正文 1000 字以内 / timeline ≤6 / reason ≤40 字」。
3. **请求超时**：网关默认 `timeoutMs=120000`，影评实测 110–180 秒。改了
   `ai-config.json` 的 `timeoutMs`，并在 `review.ts` 里显式传 `REVIEW_TIMEOUT_MS = 300_000`。
4. **雷达图对不齐**：Excel 里是 `plot`/`animation` 英文 key，AI 返回「剧情」「作画」，
   按名字匹配永远空。`App.tsx` 用 `DIMENSION_LABEL_MAP` 翻成中文再传进 `userContext`。
5. **正文重复图片**：模型连着引用同一张图的几个格子 → 正文出现三四张一样的图。
   同一 sheet 只插一次，重复降级成「（见上图）」。
6. **模型漏写扩展名**：写 `{{sheet:ep01-1}}` 而不是 `ep01-1.jpg` → 一张图都插不进去。
   替换时按「原样 → 补 `.jpg` → 补 `.png`」依次找。
7. **`ELECTRON_RUN_AS_NODE` 污染**：从 DSH（本身是 Electron 应用）的 shell 里启动
   AnimeDiary，会继承 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成纯 Node，`app` 为
   undefined 直接静默退出。启动前必须 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。
   **用户自己双击启动不受影响**，只有脚本/agent 会踩。
8. **换渲染器后旧图残留**：storyboard 出 PNG（49 张）→ 换 grid6 出 JPG（18 张），
   旧 PNG 留在目录里。worker 渲染前用 `cleanPreviousSheets` 清同前缀旧文件。
9. **弹幕找不到文件**：合并后的 `01.mp4` 在番剧根目录，而 `danmaku.json` 在
   `1/` 子目录。`findDanmakuFile` 要按集号推导：`01.mp4` → `1/danmaku.json`。
10. **弹幕广告**：每集开头刷几十条「交流群1047615969 欢迎加入（打扰致歉）」，
    过滤规则：含「群/交流/欢迎加入/打扰」且有 5 位以上数字 → 丢弃。

### 0.6 台词兜底：MOSS 本地 ASR（2026-11-16 加）

没有外挂字幕的番，以前报告里只有画面和弹幕、**一句台词都没有**。现在多了一条本地兜底：

| 台词来源 | 优先级 | 什么时候用 |
|---|---|---|
| 内嵌字幕轨 | 0 | 还没实现（storyboard 那边固定 `transcript: 'off'`） |
| 同目录 `.ass/.srt/.vtt` | 1 | 默认（`transcript: 'auto'`） |
| **MOSS 本地 ASR** | 2 | 只有用户在拉片面板上选「语音识别」（`transcript: 'asr'`） |

**默认不跑 ASR**：一集 24 分钟大约 10 分钟（实测 RTF ≈ 0.4），不能让"顺手拉个片"变成等十分钟。
没字幕又想要台词，必须显式选。

链路 `plugins/watch-analysis/adapters/transcript-moss.mjs`：

```text
video.file ──spawn──> python moss_bridge.py <mp4> --model <权重目录>
   PyAV 直接解容器音轨（**不用先 ffmpeg 抽 wav**）
   ──stdout 一行 JSON──> { ok, segments:[{start,end,speaker,text}], elapsed }
```

实测（`E:\kazhumi Anime\554779_giriGiriLove\01.mp4` 截 60 秒，1080p/24fps）：
模型加载 2.4s + 推理 15.9s = **26.4s**，输出 **18 句 / 5 位说话人**（`S01`…`S05`），
时间戳与画面对得上。整集 24 分钟约 10 分钟。

环境变量（都不配也能自动探测本机默认路径）：

```text
ANIMEDIARY_MOSS_PYTHON   …\miniconda3\envs\moss\python.exe
ANIMEDIARY_MOSS_MODEL    D:\models\MOSS-Transcribe-Diarize
```

依赖自检的 `asr` 项（`server/deps.ts`）探测的是 **MOSS**：python env + 权重目录 + 包可 import。
缺了只标「可选依赖未就绪」，不影响切镜/分镜/弹幕，也不影响开始分析。

**报告与影评的连带变化**：

- `WatchReport.transcript.segments[].speaker`（只有 ASR 有）+ `transcript.speakers`（人数）
- 影评 prompt 新增「台词」小节：每集均匀抽 ≤60 句，带 `[mm:ss]` 与 `S01:` 编号，
  并明确告诉模型「编号不是角色名，别自己安」。**以前只统计 `dialogueLines` 条数，
  台词根本没进提示词** —— 报告里存着几百句，模型一句都看不到。
- 镜头清单里台词显示成 `S01: 台词`，多段拼一行。

⚠️ MOSS 权重 1.7GB、吃 3–4GB 显存，是**纯可选**：没装照样能分析，只是没字幕的番没台词。
代码在 `plugins/`，模型与 `moss_transcribe_diarize` 包在本机（`D:\MOSS-Transcribe-Diarize`，
pip install -e 进 conda env），**都不进仓库**。

### 0.7 影评的真实进度与 token 账单（2026-11-16 晚加）

以前生成影评是一次**同步请求**（一集 110–180 秒），中途什么都拿不到，面板只能按秒数轮换文案猜。
现在改成 SSE：

| 事件 | 内容 | 谁产生 |
|---|---|---|
| `phase` | `collect`（整理输入）/ `call`（交给模型，带图数与集数）/ `parse`（解析校验） | `server/review.ts` 的真实节点 |
| `delta` | `chars`（正文累计字符）/ `reasoningChars`（思维链累计）**分开** | 网关流式响应 |
| `done` / `error` | 最终影评（含 usage）/ 错误原文 | 服务端 |

- 前端进度条 = 阶段基数 + 已生成字数估算（`estimatePercent`）。**仍然是估算**，但增长由真实事件驱动，
  而且面板会显示「已生成 1,234 字」/「思考中 …」——推理模型先想几十秒时不会看着像卡死。
- `/api/watch/review` **不带** `Accept: text/event-stream` 时仍然是原来的 JSON 接口（旧前端/脚本兼容）。
- 网关若不支持「JSON 输出 + stream」（有的直接 400）：服务端**自动退回一次性生成**，前端文案变成
  「流式不可用，改用一次性生成」，功能不会因为要进度而断掉。
- `AiReview` 新增 `usage`（`promptTokens` / `completionTokens` / `reasoningTokens?` / `totalTokens`）；
  `elapsedMs` 本来就在落盘，现在历史记录也会显示「用时 116 秒」（以前一律 `—`）。
  面板底部变成：`模型 · 提示词版本 · 用时 · 输入 3,144 / 输出 13,517 / 共 16,661 token · 时间`。

**分集子任务（fanout，2026-11-17）**：用户要求「单次上限 1000、推荐 100–500」，
并希望能分给子代理、每集看完再汇总，避免上下文爆满。

- `maxSheets` 上限 48 → **1000**（默认 100，推荐 100–500）。
- `ReviewOptions.mode`：`auto`（默认，**多集且总图数 > 60 自动拆**）/ `single` / `fanout`。
- fanout 流程（`server/review-fanout.ts`）：
  1. 每集一次调用：只看这一集的图 + 报告 → 结构化小结（points / scores / quotes / caveats）；
  2. 汇总一次：**只发文字小结**（不带图）→ 整季影评 JSON。
- 代价：调用次数 = 集数 + 1，token 总量通常更高（每集都要重新描述一遍画面）；
  某一集失败只记一条 caveat，不中断整季。
- ⚠️ 单次请求的图不能真拉满：1000 张 ≈ 250MB 请求体，网关会拒收；
  想看几百张必须用 fanout（单请求只承担一集的图）。

**实测（2026-11-17，6 集 × 12 张 = 72 张）**：7 次调用、**270.7 秒**，
输入 78,855 + 输出 18,615（思维链 12,840）= **97,470 token**；每集子任务正文从 721 字涨到 9,706 字。
首次跑暴露一个坑：**没传用户分时子任务 prompt 没有维度白名单**，模型自编了
「角色 / 搞笑 / 演出」三条不存在的轴 —— 已用默认八维兜底（`FALLBACK_DIMENSIONS`）。
第二次跑又暴露：**子任务 4000 token 的输出预算被思维链吃掉**，E3/E5 返回半截 JSON
解析失败 —— 已改成 8000、失败再用 12000 重试一次。



**维度口径（2026-11-17 修）**：雷达图的轴以**番剧模板维度**为准。

用户截图暴露了两个问题：出现 `frameCount` 轴（张数在 Excel 里有列，但不是评分维度）、
「音声」和「声音」各一条轴。根因是宿主直接拿 Excel 的 `scores` 翻标签：

- 宿主 `App.tsx` 改用 `buildTemplateScores(entry.scores, getTemplateDimensions(templateId))`
  （`features/anime-data/dimension-scores.ts`）：**模板维度是权威列表**，模板里没有的 key
  自动消失、标签用模板的；`overall` 跳过（它由其它维度加权算出来）。
- 插件侧 `buildScoreRows`：有用户分时**只列模板维度**，AI 多编出来的维度不显示；
  并把旧名「声音」归一到「音声」（老影评是按旧兜底列表生成的）。
- `review.ts` 的兜底维度列表也从「声音」改成「音声」，新生成的影评直接对齐模板。

**实测（2026-11-16，第一次跑通整季六集影评）**：`学生会也有洞！` E1–E6，648 个镜头 / 6 张图，总耗时 **99.8 秒** —— 其中**思维链 86 秒**（10,306 字符）、正文只用了 13 秒（3,243 字符）。
token：**输入 18,489 / 输出 8,344（含思维链 6,596）/ 共 26,833**。
这个比例正好说明「按秒数猜进度」以前几乎全程都在骗人：前 87 秒一个字都没写到正文里。

### 0.8 拉片参数：分镜图张数上下限 + 读取字幕开关（2026-11-16）

拉片面板上现在能直接调这三项（**只影响下一次「开始分析」**，不改已有报告）：

| 参数 | 范围 | 语义 |
|---|---|---|
| 分镜图张数 | 0–10000 张，留空 = 自动 | 实际张数 = `clamp(ceil(时长 / 80), 下限, 上限)`。设 100–1000 时，24 分钟的片出 **100 张**（自动只有 18） |
| 读取字幕 | 开 / 关 | 关 = `transcript: 'off'`，完全不碰字幕 |
| 语音识别兜底 | 开 / 关 | 找不到字幕文件时才跑本地 MOSS（一集 24 分钟约 10 分钟） |

实现位置：`ui/WatchTab.tsx`（控件）→ `runtime/protocol.ts` 的 `minSheets` / `maxSheets`
→ `adapters/render-grid23.mjs` 的 `planGrid23()`（纯函数，有 13 个用例钉时间轴）。

- **上下限写反**（把 1000 填在左边）按「下限优先」纠正，不返回空计划。
- 超过 10000 会被夹到 10000。
- ⚠️ **1000 张 ≈ 3–4 分钟**（6000 次 ffmpeg 抽帧 + 1000 次拼图）；10000 张还会占 **2–3GB 磁盘**
  （每张 JPEG 约 250KB）。面板上有「超过 200 张会明显变慢」的提示。
- ⚠️ **分镜图多 ≠ AI 看得多**：发给模型的是另一个配额 —— 影评配置页的「AI 看图数量」
  （默认 **100 张**、上限 1000，推荐 100–500；整部番按集数平分；6 集 × 100 → 每集 16 张）。
  上下文不是瓶颈（模型 1M），限制来自**请求体大小**（每张 1280×1080 约 250KB）；
  想看几百张要用「分集收集」（见 §0.7 的 fanout）。

**实测（2026-11-16，E02 24 分钟）**：设 `minSheets=100, maxSheets=1000` → 出了 **100 张 / 600 格**，
每格 2.37 秒，首格 `0–2.37`、末格 `1417.83–1420.2`（覆盖全片），`transcript: 'off'` 时
报告里 `engine.transcript = none`、没有 `transcript` 字段。渲染 100 张约 20 秒（600 次抽帧 + 100 次拼图）。

### 0.9 分析挂后台 + 性能预留（2026-11-16 晚）

**拉片分析本来就在后台跑**（worker 是独立子进程，关面板只断轮询、不杀进程），
但以前关了就看不到、重新打开也不知道任务还在。现在补上了「接回来」：

- `GET /api/watch/jobs`：列出进行中 + 30 分钟内结束的任务；
- 拉片面板打开时自动查一次，**把这一集还在跑的任务接回来**（继续显示进度、能取消）；
- 任务在内存里保留 30 分钟（`FINISHED_TTL_MS`），供关/开面板之间来回。

**影评改成后台任务**（以前是同步请求，关面板 = 取消 = 白花一次钱）：

| 端点 | 作用 |
|---|---|
| `POST /api/watch/review/run` | 立即返回 `runId`，生成在服务端继续 |
| `GET /api/watch/review/run?id=` | 快照（阶段 / 已生成字数 / 结果） |
| `GET /api/watch/review/runs?key=&kind=` | 找这一部番还在跑的任务（面板打开时恢复） |
| `POST /api/watch/review/cancel` | 真取消（abort 生成） |

面板每秒轮询快照；**关掉面板不取消**，重新打开自动接回进度。
原来的 SSE 接口（`Accept: text/event-stream`）保留，但 UI 已经不用 —— 流会随连接断开。

**性能预留**：`{DATA_DIR}/watch-settings.json`，面板上改完即时 PUT：

| 设置 | 作用 | 实测映射 |
|---|---|---|
| CPU 上限 25 / 50 / 75 / 100% | 抽帧 ffmpeg 的 `-threads` + 并发 | 16 核 50% → 8 线程 / 4 并发 |
| 进程优先级 normal / below-normal / low | worker 子进程（Windows 上 ffmpeg 子进程继承） | 低于普通 = 前台应用优先 |

⚠️ **扫描阶段不受 CPU 上限控制**：那一段的 ffmpeg 由 `dsh-video-storyboard` 内部启动，
我们拿不到命令行、加不了 `-threads`。这一阶段靠「进程优先级」降低对前台的影响。
⚠️ **GPU 没法"预留显存"**：MOSS 转写是单卡 CUDA 推理，只能靠串行 + 低优先级；`asrLowMemory`
字段已预留但当前版本不生效。

---

## 1. 一分钟上手

| 项 | 值 |
|---|---|
| 技术栈 | React 18 + TypeScript + Ant Design 5 + ECharts 5 + Vite 6 + Electron 33 |
| 主数据 | `%USERPROFILE%\Documents\AnimeDiary\番评分.xlsx`（**不入 git**） |
| 图片 | 同目录 `images\{番剧名}\` |
| 备份 | 同目录 `backups\`（滚动快照，当前 16 个） |
| 安装位置 | `E:\AnimeDiary\AnimeDiary.exe` —— **绿色版目录**（无注册表卸载项），升级靠覆盖 |
| 热更新源 | `E:\AnimeDiary-updates`（硬编码在 `electron/main.js:77`）；**但插件功能热更新分发不了**，见 §0.2 |
| 内置 API | 固定端口 **51730** |
| 插件 | `plugins/watch-analysis/`（拉片 + AI 影评），自带 ESM worker 子进程 |
| 开发 | `npm run dev:web`（浏览器 5173） / `npm run dev`（Electron） |

质量门禁只有两个，**没有 linter**：

```bash
npx tsc --noEmit    # 唯一类型检查（注意：不覆盖 plugins/*.mjs，那些用 node --check）
npx vitest run      # 994 通过 / 66 个文件（另有 6 个跳过：需 AI_LIVE=1 才跑）
```

---

## 2. 发版流程（改完代码必走这套）

> **1.3.36 之后有两种情况，别弄混：**
>
> | 改了什么 | 怎么发 |
> |---|---|
> | 只改前端 / `server/` | 热更新（下面这套） |
> | **改了 `plugins/`、依赖、`electron/`、`preload.js`** | **必须重打安装包并覆盖程序目录（§0.2）** |
>
> 热更新 zip 里没有 `plugins/` 和 `dsh-video-storyboard`，发了也跑不起来。

前端走"热更新包"分发，**不是重新打包 Electron**：

```bash
# 1. 改版本号（就是改 package.json 的 version；vite build 会据此生成 version.json）
node .review/bump-version.js 1.0.44

# 2. 构建 + 打包
npx vite build
npm run update:pack          # 产出 release/web-update/AnimeDiary-web-<v>.zip + latest.json

# 3. 部署到更新源
Copy-Item release\web-update\AnimeDiary-web-1.0.44.zip E:\AnimeDiary-updates\ -Force
Copy-Item release\web-update\latest.json              E:\AnimeDiary-updates\ -Force

# 4. 重启应用两次：第一次下载更新，第二次才真正跑新版本
Get-Process AnimeDiary | Stop-Process -Force
Start-Process 'E:\AnimeDiary\AnimeDiary.exe'          # 第一遍：下载
Start-Sleep 22; Get-Process AnimeDiary | Stop-Process -Force
Start-Process 'E:\AnimeDiary\AnimeDiary.exe' -ArgumentList '--remote-debugging-port=9222'   # 第二遍：运行
```

**关键点**

- **版本号必须变**，否则 `latest.json` 版本相同，应用认为"已是最新"不会下载。
- `--remote-debugging-port=9222` 只在需要 CDP 验证时加；不带也能正常跑。
- `.review/` 是本地工具目录（**已 gitignore**），新环境里没有 `bump-version.js` / `cdp.js`。
  前者只是把 `package.json` 的 `version` 改掉（用 Node 写以保留 UTF-8），手动改也一样。

**GitHub 发布**（1.3.6 起，安装包也挂到 Releases）：本机直连 github.com / api.github.com 会被 TLS 重置，
必须走 Clash 代理 `127.0.0.1:7897`：

```powershell
git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin master
# 上传 release 资产用 curl：不加 --ssl-no-revoke 会因吊销检查离线报 CRYPT_E_REVOCATION_OFFLINE
curl.exe --ssl-no-revoke -x http://127.0.0.1:7897 -X POST -H "Authorization: Bearer <token>" `
  -H "Content-Type: application/octet-stream" --data-binary "@release\AnimeDiary-Setup-1.3.6.exe" `
  "https://uploads.github.com/repos/Re02VClife/AnimeDiary/releases/<id>/assets?name=AnimeDiary-Setup-1.3.6.exe"
```

token 在 Windows 凭据管理器里（`git credential fill` 可取）。GitHub API 创建 release 时
`target_commitish=master` 会自动建 tag；删旧 release 不会删 tag。

**验证方式**：用 CDP 挂到跑起来的页面读 DOM，比截图可靠（Electron 的 GPU 合成窗口截图有时是空白）：

```bash
node .review/cdp.js .review/steps-xxx.json      # 自定义 steps：eval / wait / click / hover / shot
```

---

## 3. 数据规模（2026-10-11 实测）

| 项 | 数量 |
|---|---|
| Excel 数据行合计 | **486**（`!ref` = A1:AQ487） |
| ├ 番剧（默认模板 `default`） | 185 条 + 64 行垃圾 |
| ├ 角色卡（`character`） | 222 |
| └ 自定义模板（2 个，`template-1782592748856` / `template-1782669675979`） | 1 + 10 |
| 源表里名字为空的行 | **64**（其中 4 行还剩半截数据：203/205 只剩 AniList 分、229 只剩一串数字） |

**Excel 关键列**（0-based，定义在 `features/anime-data/excel-mapping.ts`）：

| 列 | 索引 | 说明 |
|---|---|---|
| A | 0 | 检索名 SEARCH_ALIAS |
| **B** | **1** | **名字 TITLE**（写回校验的基准） |
| C | 2 | 赋分 —— 公式列 `=(D-2.5)*10/(10-3.6)` |
| **D** | **3** | **综合(观感) OVERALL —— 公式列**，见第 6 节 |
| E/F/G/H | 4~7 | 音 / 制作 / 张数 / 作画 |
| I | 8 | 制作组 |
| J | 9 | 内容 —— **也是个公式列** `=0.1*K+0.3*L+0.3*M+0.3*N` |
| K~O | 10~14 | 沉浸感 / 剧情 / 人设 / 深度 / 电波 |
| R | 17 | 首刷时间（Excel 序列号） |
| U | 20 | 偏差值 —— 公式列 `=(D+O)-2*W` |
| AL | 37 | 海报 URL |
| AM | 38 | 模板 ID |
| AQ | 42 | TEMPLATE_JSON（非默认模板的评分 + 自定义字段） |

> ⚠️ `EDITABLE_COLS` 白名单**不含** C/D/J/U/Y —— 公式列一律不写。唯一的例外见第 6 节。

---

## 4. 项目结构

```
plugins/watch-analysis/   自包含插件：拉片分析 + AI 影评（详见 §0）
  core/                   纯逻辑与类型（Port 契约、预算、报告 schema）
  ports/                  六个可替换接口（Cut/Transcript/Motion/Music/Sheet/Vision）
  adapters/               引擎实现（cut-hsv / render-grid23 / danmaku-kazumi / transcript-subtitle …）
  runtime/                worker ESM 子进程 + job 管理 + 协议
  server/                 13 个路由 / 落盘 / 影评生成
  ui/                     面板组件（WatchTab / StoryboardViewer / AiReviewModal / WatchPanel）
core/                     纯工具函数（math/color/text/date/character）
  voice-clips.ts             语音：静音检测解析 + 片段挑选（纯函数，可单测）
  voice-search.ts            语音：B 站候选打分排序（纯函数，可单测）
features/                 12 个业务模块
  ai-analysis/            AI 分析套件（14 文件）
  anime-data/             Excel 读写 + 模板持久化
    excel-transfer.ts       导出分表 / 导入重建 / D 列公式重建
  anime-detail/           ScoreSlider
  character-complete/     角色补全 + 角色卡合并（4 文件）
  character-voice/        角色原声语音抓取（语音面板 + 角色卡播放条）
  image-management/       海报 / 截图 / 去白底（5 文件）
  media-complete/         数据补全面板
  ranking/                百分位排名
  search-add/             Bangumi / AniList 搜索入库
  watch-calendar/         侧栏时间轴
context/AnimeContext.tsx  useReducer 全局状态（~890 行）
src/components/           UI 组件（AnimeGrid / AnimeDetailModal ~2490 行 / Sidebar / TopBar …）
  ExcelEditor.tsx         表格视图（应用内看/改列表数据）
  excel-editor-model.ts   表格视图的数据层（列定义/读值/排序/应用编辑，可单测）
src/types/index.ts        AnimeEntry / ScoreTemplate / 两个内置模板工厂
server/api-routes.ts      共用的 /api 处理器（dev 中间件 + Electron 生产同源）
server/character-voice.ts 语音抓取：B 站搜索/下载 + ffmpeg 切片拼接
```

**评分模板**：模板存 localStorage（`anime_diary_templates`）。两个内置模板由代码里的工厂函数定义：

- `createDefaultTemplate()` → 番剧评分，9 维（含 `overall` 总评，weight 0）
- `createCharacterTemplate()` → 角色评分，**6 项**：`overall`(总评,w=0) + 角色设计 / 性格 / 声优 / 萌点电波 / 好感度（各 1/5）

> ⚠️ **用户实际用的权重可能和 `DEFAULT_DIMENSIONS` 不一样**（实测确实不一样，见第 6 节）。
> 任何"按权重算总评"的地方都必须走 `getTemplate(...)` 读 localStorage，不能用硬编码常量兜底。

---

## 5. 改代码前必读的坑

### 5.1 同名死副本（1.1.0 已清干净）

曾经有多份**没有任何 import** 的历史副本：改到它们身上不会有任何效果，重新构建后
**文件名 hash 都不会变**（就是这么踩进去的）。

1.0.44 删了 4 个（`src/components/WatchCalendar.tsx`、`src/services/excelService.ts`、
`excelMapping.ts`、`storageService.ts`）；1.1.0 又用「全仓库扫一遍 import 图」的方式
查出并删掉 5 个：

| 已删除的死文件 | 真正生效的 |
|---|---|
| `features/image-management/ImageManager.tsx` | `src/components/ImageManager.tsx` |
| `src/components/SearchAddModal.tsx` | `features/search-add/SearchAddModal.tsx` |
| `src/components/DimensionManager.tsx` | 早被 `src/components/TemplateManager.tsx` 取代 |
| `src/components/EpisodeReview.tsx` | 无对应实现：分集评论 UI 从未挂载（数据层仍在，`storage-service` 的 `*EpisodeReview` 被 shift-refs 依赖） |

另外 `src/components/TasteReportModal.tsx` 随 1.1.0 的 AI 重构一并删除
（AI 分析已并入对话窗口）。

⚠️ `src/services/` 现在只剩 **1 个文件**：`imageService`（活）。
（`rankingService` 已于 2026-11-16 合并掉 —— 它和 `features/ranking/ranking-service.ts`
是**逐行副本**，只差 2 行 import 路径；雷达图改用 features 版后旧文件已删。
`aiCache` / `aiConfig` / `aiSkills` / `llmService` 随 1.1.0 的 AI 重构删除，
`graphService` 随后续模块清理删除。）

**排名唯一入口**：`features/ranking/ranking-service.ts`。别再复制一份到别处。
合并前做过对拍：230 次边界输入 + 1512 个真实单元（189 条 × 8 维）逐位相同 ——
"双份"从来没换来任何东西，只换来"改一份忘另一份"的风险。
⚠️ `AnimeDetailModal.nearbyRanking` 是**同模板邻邻**口径（不是全表百分位），语义不同、仍内联，别合并。

**排查方法**（想再确认有没有新的死副本时用）：扫全仓库的相对 import，
把「没有任何非测试文件引用」的源文件列出来即可。1.1.0 那次的结果就是上面 5 个。

**判断改对了没**：构建后在产物里搜一个你新写的字符串，例如

```powershell
$c = [System.IO.File]::ReadAllText('dist\assets\index-*.js', [System.Text.Encoding]::UTF8)
([regex]::Matches($c, 'category==="watched"')).Count
```

### 5.2 Excel 写入有三道保护

1. **写前校验**：`/api/excel/write` 每条更新都带 `expectedTitle`，与目标行 B 列不符就整体拒绝并返回 409（`{conflicts:[…]}`），**一个字节都不写**。所以"改了名存不进去"通常意味着前面某次写入没落盘。
2. **`EDITABLE_COLS` 白名单**：编辑路径只写这些列，公式列（含 D 列 OVERALL）碰不到。⚠️ 这个白名单**只在客户端生效**，服务端没有白名单。
3. **原子写 + 快照**：`writeFileAtomic()` 走 `snapshotExcel()`；内容 hash 与最新快照相同则**不产生新备份**（所以"写了一样的内容"看不到新备份是正常的）。

⚠️ `/api/excel/write` 只写单元格的 `v`（用 `sheet_add_aoa`，会**整格覆盖**）。要连公式一起写，
必须带可选的 `formula` 字段（1.0.47 加的），否则原公式会被抹掉。

写回入口：`updateAnimeEntry()`（已有行）/ `appendAnimeEntry()`（新行）。**两条路径都要照顾到** —— 曾经 `mapAnimeToUpdates` 漏写 B 列标题，导致改名后下次保存必然 409 死循环。

### 5.3 分类不是存在 Excel 里的

`mapRowToAnime` 派生 `category`：**有评分且有评价 → `watched`，否则 → `watching`**。用户在前端改分类走 `saveCategory()`，存在 localStorage 的 `anime_diary_categories`（按 `excel-<行号>` 为 key），加载时覆盖派生值。

**行删除会让 id 漂移**（`anime.id === 'excel-' + excelRowIndex`），`shiftCategoryMap` 负责迁移。

### 5.4 角色模板种子版本

`features/anime-data/template-service.ts` 里的 `CHARACTER_SEED_VERSION`（当前 **`'7'`**）是版本化种子：

- flag 记录已种子版本 → 用户删掉模板后**不会复活**
- 版本升级时**整体覆盖 `dimensions`**（只补缺 fieldConfig / layoutConfig）

**改 `createCharacterTemplate()` 的维度就必须 bump 这个版本号**，否则已有安装看不到变化；反之要注意它会覆盖用户手动改过的维度名/权重。

### 5.5 海报与去底

- 去底图约定文件名 `cover-nobg.png`。`applyCutout()` 只在**渲染时**替换 src，**绝不写回 state/Excel** —— 否则撤销去底后海报会指向不存在的文件。
- 图片加载失败先由 `fallbackPosterUrl()` 退回同目录 `cover.jpg`；退回也失败才会露出占位（面板底是 `linear-gradient(135deg,#1a1030,#2d1a2c)` + 浏览器画的 alt 文字，看着像"默认图"）。
- 详情面板的海报**轮播**跟着 `allImages.length` 启停。**不要**用闭包里的长度开定时器 —— 从多图条目切到单图条目后 `slideIdx` 会越界，`allImages[slideIdx]` 变 `undefined`，表现就是"海报看几秒后变成默认图"。

### 5.6 侧栏滚动

侧栏整体滚动（`.app-sidebar { overflow-y:auto }`）。三个板块（时间轴 / 排行榜 / 标签）**刻意不设内层滚动条**：内层 `overflow` 会吃掉滚轮，侧栏只剩右侧十几像素的缝能滚。长度靠**默认只显示一部分 + 「展开全部」按钮**控制，别再往回加 `maxHeight + overflowY`。

### 5.7 同一逻辑多份实现 —— 本项目最高频的坑

已经栽过好几次，都是"改了一份、另一份没动"或"两份口径悄悄漂移"：

| 逻辑 | 有几份 | 说明 |
|---|---|---|
| `calcOverall` | **已统一** | 2026-11-16 起唯一实现是 `core/overall.ts`（`calcOverall` / `calcEntryOverall`）。`core/math.ts` 里那个同名旧函数只剩测试引用，待删 |
| `round2` | 曾有 2 份 | `excel-transfer` 里的副本缺 nudge → `.5` 边界少 0.01（1.0.48 删除） |
| `formatScore` / `fmt2` | `core/math` | 统一入口，别再自己写 |

**动手前先 grep 函数名，确认有几份、哪份真的被 import。**

### 5.8 PowerShell 改文件会把编码搞坏

**不要**用 `(Get-Content -Raw) -replace ... | Set-Content` 改含中文的文件 —— `Set-Content` 默认用系统 ANSI，
会把中文写成 `?` 且**不可逆**（1.0.48 期间就把本文件搞坏过一次，只能 `git checkout` 整份恢复后重改）。
要改文本用编辑工具；要在命令行处理，必须显式 `-Encoding utf8`。

### 5.9 `tsc --noEmit` 的覆盖范围（2026-11-16 核对）

`tsconfig.json` 的 `include` 现在是 `src / core / features / context / tests / server / plugins`，
**包含 `server/`**（这条曾经写成"不含 server"，已过时）。但仍然：

- `plugins/**/*.mjs` **不在**检查范围（没开 allowJs、也没写 d.ts）→ 改过 worker/adapter 要跑
  `node --check <file>.mjs`，或者靠一次真实分析验证。
- `server/*.ts` 虽然被 tsc 检查，`npm run build:api` 的 esbuild 仍是检查语法/导入的第一道门，
  改过 `server/` 之后至少跑一次：

```bash
npm run build:api     # esbuild 打包，顺带做语法检查
npm run typecheck     # tsc --noEmit（覆盖 src/core/features/context/tests/server/plugins 的 ts/tsx）
```


### 5.10 桌面壳层的四个约定（2026-11 加，改弹窗/主题/侧栏前必读）

1. **标题栏右上角的系统按钮不吃 CSS**。`titleBarOverlay` 由 Electron 独立绘制，
   页面里的变量影响不到它 —— 主题一变必须主进程改色。现在 `ThemeContext` 会自动发
   IPC `window:set-titlebar-overlay`，主进程 `applyTitleBarOverlay()` 会校验 `#RRGGBB`
   并回退默认值。**新增主题相关的颜色时别忘了这条**。

   ⚠️ **热更新改不了它**。IPC 处理在 `electron/main.js`、桥接在 `electron/preload.js`，
   这两个文件在 app.asar 里，只有重装安装包才会更新。1.3.5 之前装过旧壳的机器上，
   浅色主题下右上角会一直留一块深色，页面侧无解 —— 别在渲染层找补。
   主进程另存 `userData/window-appearance.json`（`applyTitleBarOverlay` 每次写、启动时读），
   这样窗口创建的第一帧就是对的，不会先闪一下深色标题栏。

2. **Modal 的 `top` 不能再用 antd 默认的 100**。顶部有 36px 自定义标题栏，`App.css`
   末尾统一给了 `top: calc(var(--app-titlebar-height,0px) + 12px)`，并给
   `.ant-modal-content` 限高 + flex 列布局让 body 自己滚。新建弹窗**不要再写
   `style={{ top: ... }}`**（除了 ExcelEditor 那种确实要贴顶的特例）。
   ⚠️ 选择器是 `.ant-modal-content`（后代匹配），**不能写 `> .ant-modal-content`** ——
   antd 5 在这两者中间还套了一层无 class 的 div，带 `>` 的规则一条都不生效（实测踩过）。

3. **侧栏是浮层，不是布局的一部分**。`.app-sidebar` 用 `position: absolute` 盖在
   主内容上（z-index 200，低于 Modal 的 1000），展开时**不改变网格列数**。
   `top` 从顶栏下沿算起（`var(--topbar-height, 68px)`，由 `TopBar` 用 ResizeObserver
   实测写入）—— 写死 0 会盖住搜索框，实测踩过。
   `App.tsx` 里原来的 `with-sidebar` class 已删，CSS 里对应的 4 条收缩规则也删了 ——
   别加回来；顶栏现在是按**视口宽度**断点收缩（`.search-kbd` / `.category-tab`）。

   ⚠️ **侧栏里不要再放设置项**：外观/数据/工具/关于已经收进 `SettingsModal`
   （`App.tsx` 挂载），侧栏只留浏览与筛选。往里加东西会把刚瘦下来的 1880px 又顶回去。

4. **截图 IPC 有并发互斥**。`capture:takeScreenshot` 用 in-flight Promise 合并并发请求
   + 失败重试一次。原因：`screenshot-desktop` 在 Windows 上要把 `screenCapture.bat`
   解压到**固定的**临时目录再 `cmd /c`，并发时必有一个失败（React StrictMode 会把
   自动截图的 effect 跑两遍，实测打开面板就红字报错）。错误信息只写主进程日志，
   界面只给一句人话。

---

## 6. 总评（综合观感）的口径 —— 三处必须一致

这是 1.0.47 修的那个 bug 的完整背景，**改任何一处都要回来看这一节**。

### 6.1 谁在算总评

| 位置 | 用的维度来源 | 说明 |
|---|---|---|
| 网格卡片 `AnimeGrid.calcOverall` | `getTemplate(entry.templateId)` | ✅ 正确 |
| 侧栏排行榜 `Sidebar.calcOverall` | 同上 | ✅ 正确 |
| 详情面板 `AnimeDetailModal.overallScore` | **曾经是 `DEFAULT_DIMENSIONS`** | ❌ 1.0.47 修好 |
| AI 套件 `ai-helpers.calcOverall` | `getTemplateDimensions(entry.templateId)`（2026-11-16 统一） | ✅ 已修 |
| Excel D 列 | 自己的手工公式 | 见 6.3 |

**1.0.47 修的 bug**：

```js
// 错：templateId 为 undefined（默认模板的条目不写模板ID）时 t = null，
//     再被 || DEFAULT_DIMENSIONS 兜到代码硬编码权重上，用户改过的权重被忽略
const t = tid ? getTemplate(tid) : null;
const templateDims = t?.dimensions || DEFAULT_DIMENSIONS;

// 对：getTemplate(undefined) 本来就会回退到用户的默认模板
const templateDims = getTemplate(templateId).dimensions;
```

**教训**：`x ? f(x) : null` + `|| DEFAULT_*` 这个组合会把"自带兜底的函数"短路掉，
让兜底值反而变成错的那一份。

**2026-11-16 第二次统一**：`ai-helpers.calcOverall` 这处「不传参时用 `DEFAULT_DIMENSIONS`」
已经修掉；同时 `AnimeGrid` / `Sidebar` / `AnimeDetailModal`（两份手抄）/ `app-tools` /
`BangumiSyncModal` / `AnimeContext` 的维度来源全部收进 `getTemplateDimensions()`（= `getTemplate(id).dimensions`）。
细节面板的 `overallScore` 保留两个旧语义：`equalWeightFallback: false`（没有正权重时显示 `-`）
和「编辑中切模板即时预览」。

### 6.2 加权算法（三处一致）

```
dims = 模板.dimensions.filter(d => d.key !== 'overall')   // 排除总评自身
生效维度 = 有权重 ? 权重>0 的维度 : 全部维度等权兜底
加权 = Σ(分×权重) / Σ权重        // 只累计 >0 的分
```

### 6.3 Excel D 列

历史上是**另一套手工公式**：`E*0.13+F*0.18+H*0.15+J*0.4+O*0.15`（只用 5 个维度，
其中 J「内容」自己还是个公式 `0.1*K+0.3*L+0.3*M+0.3*N`）。实测 168/169 条与应用口径对不上，
97 条连自己的公式重算都对不上缓存值。

1.0.47 起改为按**模板权重**重建：

- `rebuildOverallFormula(ws, { templates, sheetRows })` —— 纯函数，可单测（10 个用例）
- 只处理**默认模板**的行（`模板ID` 为空或 `default`）；角色卡/自定义模板的维度没有独立列，公式表达不了
- 公式形如 `E2*0.1+F2*0.1+H2*0.1+K2*0.12+L2*0.15+M2*0.15+N2*0.15+O2*0.13/1`
- 分母**固定用模板权重和**（没打分的维度按 0 计入），语义可预期
- 同时写一份正确的缓存值：应用读缓存值（`read` 默认不开 `cellFormula`），Excel 打开后按公式自己重算
- 入口：侧栏「表格数据 → 🧮 按模板权重重建总评列」。**D 列不在 `EDITABLE_COLS` 里，
  这是唯一的显式例外**，所以只由用户主动触发，不挂在自动保存上

⚠️ **`templates` 必须显式传**。`rebuildOverallFormula` 默认会自己 `loadTemplates()`，
但实测打包后那份引用拿不到用户改过的权重，会退回代码默认值 —— 正好是要修的问题。

⚠️ **改了模板权重后要再点一次重建**，Excel 的 D 列才会跟着变。

---

## 7. 本阶段完成（2026-09 ~ 2026-10）

### 已完成（1.3.5 / 1.3.6）—— 雷达图点先落地 + 标题栏外观缓存

- **雷达图先画点、后画线**：ECharts 雷达图的入场动画里，symbol 点会直接落在最终位置，
  折线和面积却从中心慢慢展开 —— 面板打开、切换模板或雷达图模式（`notMerge` 重建）的
  前一两百毫秒，画面上只有几个孤零零的点，像没加载完。做法是**保留展开动画、去掉 symbol**
  （`symbol: 'none'`，[RadarChart.tsx](src/components/RadarChart.tsx)）：点只有 4px，去掉后
  观感几乎无差别，第一帧只剩网格 + 从中心长出来的线。**别再给雷达图系列加回 `symbol`**。
- **浅色主题下右上角那条深色块**：来自 `titleBarOverlay`，主进程新增
  `userData/window-appearance.json` —— `applyTitleBarOverlay()` 每次写、`createWindow()`
  读，窗口第一帧就是上次的主题色，`backgroundColor` 也跟着主题走。这部分在 app.asar 里，
  **热更新覆盖不到**，所以 1.3.5 起重打了安装包（最新是 `release/AnimeDiary-Setup-1.3.6.exe`）。

| 版本 | 提交 | 内容 |
|---|---|---|
| 1.0.36 | `3c69e12` | 角色模板 v6：删「能力设定」「成长弧光」，加「好感度」，「外观」→「角色设计」 |
| 1.0.37 | `ec495e1` `c40be7d` | 去白底面板：勾选随时可用；只处理勾选项；缩略图显示去底结果 |
| 1.0.38 | `85fd041` | **修复改名 409 死循环**：`mapAnimeToUpdates` 从来没写过 B 列标题 |
| 1.0.39 | `cca8d06` | 角色评分模板补上 `overall`「总评」维度（v6→v7），与番剧模板对齐 |
| 1.0.40~42 | `8b5e51f` | 按「改进.doc」修 5 处：时间轴只显示「看过」、海报轮播越界、上/下一张顺序跟随网格排序、侧栏滚动劫持、设置项分组整理 |
| 1.0.43 | `0c114cc` | 侧栏板块改为「默认 20 名 / 6 个月 + 展开全部」，避免全铺开 |
| 1.0.44 | 本次 | 删掉 4 个死副本；`handleFixSearchAlias` 改用 Bangumi + 置信度阈值；清理 26 个 preview 暂存文件；修正 3 个标题错别字 |
| 1.0.45 | - | **导出重做为分表格式**（番剧/角色卡/每模板一张/异常行）+ **导入端重写**；新增**「表格视图」**（应用内直接查看/编辑列表数据）；`readRawRows()` 抽公共读取 |
| 1.0.46 | - | 表格视图加**排序**（数值 / 首字母，跨全表）；**全应用数字统一到最多两位小数**（新增 `fmt2`，替换掉所有会给评分补零的 `toFixed`） |
| 1.0.47 | - | **修复详情面板总评用错权重**（见第 6 节）；新增**「按模板权重重建总评列」**；写接口支持带公式；D 列口径统一 |
| 1.0.48 | - | 删掉 `excel-transfer.ts` 里 `round2` 的**重复实现**（缺 nudge，`.5` 边界少 0.01），改用 `core/math` 权威版本 |

> ⚠️ **1.0.45~1.0.48 都还没提交 git**（工作区改动），上表 `提交` 列留空。

**同阶段的数据维护**（不进 git，直接写 Excel）：

- 修正 35 条错配的检索名（AniList 对中文标题的 top-1 命中率低，改用 Bangumi 复核）
- 回滚 37 行被误写成 `cover-nobg.png` 的海报 URL
- 清理角色卡里已废弃的 `char_ability` / `char_growth` 维度
- **1.0.47：按用户模板权重重写 D 列「综合(观感)」的公式 + 刷新全部缓存值**（188 行，备份在
  `Documents/AnimeDiary/番评分.rebuild-overall-*.xlsx`）

> ⚠️ **发版流程的坑（1.0.45 实测踩到）**：`npm run update:pack` **只做 `build:api` + 打包，不做前端构建**。
> 直接跑它会把**旧 dist** 打进 zip（version.json 仍是上一版），现象是"更新下载成功但版本没变"。
> 必须 `npx vite build` **先**跑，再 `npm run update:pack`。
>
> 另一个坑：`app.hasSingleInstanceLock()` 会让"重启两次"里的第二遍在第一遍没退干净时**直接不启动**，
> 于是跑的仍是第一遍的进程（而它解析 webDir 时新版本还没下载完）。稳妥做法是**确认进程数为 0 再启动**。

### 已完成（1.0.45）——「整理成表」导出重做 + 应用内表格视图

**A. 导出改成按类型分表**（`features/anime-data/excel-transfer.ts`）

旧导出是把内存条目按**内部 43 列**平铺成一张表，三类记录混在一起、非默认模板的分只存在于
「模板JSON」列里、列名还是「列1/人设4/模板JSON」这种内部占位名。现在导出 5 张表：

| 表 | 内容 | 关键点 |
|---|---|---|
| `番剧` | 默认模板记录 | 分按维度拆成真列（音/制作/…），列名中文 |
| `角色卡` | 角色记录 | 分 + `字段_char_source`/`字段_char_cv`/… 都拆成真列 |
| `模板_<模板名>` | 每个自定义模板一张 | 维度列名取模板里的中文标签；量纲不再串进番剧列 |
| `异常行` | 源表里名字为空、加载时**会静默丢弃**的行 | 附 Excel 行号 + 丢弃原因，可照着去清 |

- 文件名带日期：`番评分_导出_YYYY-MM-DD.xlsx`；数据源是 `/api/excel/read` 的**原始行**
- **导入端同步重写**：`handleFileChange` 不再把上传文件原样覆盖（旧实现既不认新格式，
  还会把公式列「赋分/偏差值」和其余工作表一起清掉），改为 `parseTransferWorkbook` 重建内部格式
- ⚠️ 列名口径：自定义字段列一律是 `字段_<原key>`。**不要改成模板里的中文标签** ——
  「标签 → key」在文件里不可逆，改了导入就会静默丢这一列。维度列用标签是安全的（key 由本地模板还原）

**B. 表格视图**（`src/components/ExcelEditor.tsx` + `excel-editor-model.ts`）

侧栏「设置 → 表格数据 → **表格视图（应用内编辑）**」。原来「查看 Excel」只是调系统程序打开文件。

- 只列**默认模板**的番剧；**32 列**，22 列可改、10 列只读（公式列 + 用户自有列，表头有 🔒 tooltip）
- 改动**先暂存**（改过的格子有底色）→ 点「保存修改」才写回
- 排序：表头点一下升序、两下降序、三下取消；**跨全表**（不是只排当前页），空值永远排最后
- `handleSaveAnime(entry, keepModal)` 的第二参数：表格视图必须传 `true`，否则每次保存都会关掉 detail 弹窗

**C. 全应用两位小数（1.0.46）**

`core/math.ts` 的 `fmt2(n, empty='')`：最多两位、**不补零**、**保留 0**（`formatScore` 是评分语义，0 → `-`）。
表格视图所有数字列、详情面板加权值、雷达图 tooltip、BGM、品味报告 σ/偏差、角色补全标题分全部走它。

⚠️ **两个改这块时容易踩的坑**（都有单测锁住）：

1. `Number('')` 是 **0** 不是 NaN —— 排序里判空必须先判空串，否则「没填的」会被当成 0 排到最前面
2. 只读列里可能装的是**公式串**（「内容」列实测有 `=IF(...)`）。对它做数字格式化会得到空串，
   等于让那个单元格凭空消失。`displayValue` 里转不成数字就原样显示

### 已完成（1.0.47 / 1.0.48）——总评口径统一（「两个总评」那个 bug）

**症状**：同一部番，网格卡片一个总评、点开详情面板另一个（实测 `轻音少女 剧场版`：卡片 9.14 / 详情 9.09）。

**根因**：见 **第 6 节**。用户那套权重是 `音声.10 制作.10 作画.10 沉浸.12 剧情.15 人设.15 深度.15 电波.13`，
和代码 `DEFAULT_DIMENSIONS` 的 `.12/.15/.13/.15/.20/.10/.10/.05` 完全不同 —— 所以卡片用前者、详情用后者。

**验证**：打包版实测 卡片 = 文件 D 列 = 详情面板（多条一致）；D 列 188 行逐行校验 0 不一致。

### 已完成（1.0.52）—— 角色卡原声语音

**需求**：角色面板里能为每个角色弄到「至少 30 秒人声音频」。方向选的是**抓角色原声台词**
（不是 TTS 合成），入口只放在角色卡详情面板。

先说清楚一条硬约束：**动漫角色的原声语音没有公开 API**。Bangumi / AniList 只给文字资料
（声优、生日、人设），实测确认没有任何音频字段。所以"原声"只能从别人剪好的视频里取。

**链路**（`server/character-voice.ts`）：

```
B 站搜索（WBI 签名）→ 用户挑一个视频 → 取 DASH 最低码率音轨 →
ffmpeg silencedetect 找人声段 → 跳过开场音乐取人声密集的一段 →
atrim + concat 拼够 35 秒 → audio/{角色名}/voice.mp3
```

**四条实测出来的硬约束**（踩过才知道）：

1. **必须带 `buvid3` cookie**：先打 `/x/frontend/finger/spi` 换匿名 buvid，不带时搜索接口直接 **412**。
2. **wbi 签名必须算**：`/x/web-interface/wbi/search/type` 缺 `w_rid` 返回 **-403**；签名用的
   `img_key`/`sub_key` 来自 `/x/nav` 且会轮换，不能写死（缓存 30 分钟）。
3. **音频流要带 `Referer`**：`bilivideo.com` 有防盗链，缺 Referer 一律 403。
4. **YouTube 走不通**：`yt-dlp` 下载直接报 `Sign in to confirm you're not a bot`，
   要登录 cookie，不能内置。所以只走 B 站，且**不用 yt-dlp**（纯 Node 就能拿流）。

**为什么音频不写进 Excel**：一张角色卡可能没有语音、也可能换过源，塞进 `TEMPLATE_JSON`
会让 222 张卡每次保存都多背一坨数据。约定「目录名 = 角色名」，存在性用文件系统判断
（与 `images/{番剧名}/` 一致）。元数据在同目录的 `voice.json`。

**同名角色消歧**：角色名重复很常见（实测搜「蕾娜 语音」，前几条全是《魔女之旅》的伊蕾娜和
《超神学院》的女神蕾娜）。所以搜索词会自动拼上角色卡的「所属作品」：
`蕾娜 86 不存在的战区 语音`。打分里作品名命中 +7/个（封顶 12）。

**依赖 ffmpeg**：本机 PATH 里有就能用；没有时面板顶部给红色提示并禁用生成按钮。
可用环境变量 `ANIMEDIARY_FFMPEG` 指向可执行文件。

**验证**（dev 模式 CDP 实测）：

- `蕾娜` 卡：自动搜索词 `蕾娜 86 不存在的战区 part1 语音`，候选全部是 86 相关；
  生成 35.0 秒、拼 1 段、mp3 24kHz 单声道 40kbps ≈ 172KB，`<audio>` `readyState=4`
- Range 请求返回 `206` + `Content-Range`，进度条可拖动
- 网络失败 / 慢请求 / 控制台报错三栏皆空

**已知局限**：视频是别人剪的，混进别的角色或旁白时工具无法自动识别，
只能靠候选列表的标题/时长/播放量人工挑、以及「换一个源」。这是这条路线的天花板。

---

### 已完成 —— AI 分析模块重做（走本地网关 + 结构化输出）

**触发原因**：想用 OpenCode 的 `deepseek-v4.1-flash` 跑分析，实测**浏览器根本调不通**：
`opencode.ai/zen/go` 的 `OPTIONS` 预检返回 404（无 CORS），且网关强制要求 `x-opencode-session`，
缺了 400 `MissingSessionID`。另外推理模型会把 `max_tokens` 全花在思维链上，
老代码给 500 token 稳定拿回空字符串，`JSON.parse` 直接抛错。

**做法**：

1. **模型调用搬到本地服务**：`server/ai-gateway.ts` + `server/ai-routes.ts`
   （`/api/ai/config|models|chat|test|usage`），重试退避、超时、取消、用量记账都在服务端；
   Key 只落 `{DATA_DIR}/ai-config.json`（已 gitignore），localStorage 里只有镜像。
2. **结构化输出契约**：`core/ai-json.ts` + `aiJSON()` ——
   去代码块/去废话/按括号配对截取 → 纠偏（数组包装、数字字符串、夹紧、删多余字段）→
   Schema 校验 → 带错误清单让模型重写（≤3 轮）；`finish_reason=length` 且正文为空时预算翻倍。
3. **6 个 Skill 全部重写**（1.1.0 起共 8 个，新增两个联网检索能力）：模板维度不再写死、支持 `AbortSignal`（老代码的"取消"只是不显示结果、
   请求还在跑）、总结用真实 usage；推荐改成三源并行 + 15 秒硬超时（原来串行失败要等 5 分钟），
   Tier 4 纯模型推荐会回查 Bangumi 并标 `未校验`。
4. **删掉死副本**：`src/services/ai{Skills,llmService,aiCache,aiConfig}.ts`、
   `src/components/{AISettings,TasteReportModal}.tsx`（与 features 版重复，且 AI.md 一直在指它们）。

**验证**：`tests/core/ai-json.test.ts`、`tests/server/ai-gateway.test.ts`（假 fetch），
以及真实模型联调 `tests/features/ai-analysis/live.test.ts`（`AI_LIVE=1`，读真 Excel 跑 6 个 Skill，
报告写 `.review/ai-live-report.md`）。在 dsv41 上 6/6 通过，输出能引用具体番剧名与分数。

详细架构见 `AI.md`。

---

## 8. 待办

### 已完成（1.1.0）

- [x] **AI 对话窗口**：右侧可拖拽抽屉（`src/components/AIChatDrawer.tsx`），
      模型用自然语言决定调哪个能力（`features/ai-analysis/chat-agent.ts`，最多 4 轮止损）
- [x] **会话管理**：多会话切换/新建/删除，存 `localStorage.anime_diary_ai_sessions_v1`，
      切回来能接着聊（存的是模型视角的完整往返，含 `tool_calls`）
- [x] **联网检索**：新增两个只读能力 `anime-lookup` / `anime-reviews`（Bangumi 优先、回落 AniList）
- [x] **存档与回退**：`operations.jsonl` 操作日志 + 快照列表/恢复；补上「回滚上次导入」
- [x] **AI 写操作三档权限**：`core/ai-permission.ts`，默认 `confirm`
- [x] **网关支持工具调用**：`tools` / `tool_calls`（含 SSE 增量拼接）
- [x] **再删 5 个死副本**（见 5.1），用「扫全仓库 import 图」的方式确认没有任何非测试引用
- [x] `ai-runtime` 从全局单例改为 `createAIRun()` 实例，为并发运行铺路

### 已完成（1.0.44）

- [x] 删掉 4 个同名死副本（见 5.1）
- [x] **`handleFixSearchAlias` 重写**：只处理番剧 → 查 Bangumi → `pickBestMatch`（季数消歧 + 年份修正）打分
      → **分数 < `LOW_CONFIDENCE`(0.6) 一律跳过不写**，写入的是原名（日文）。
      实测 183 条：**写入 45、已正确 129、拿不准跳过 9**；抽查 12 条全部正确，续作没错配到相邻季度
- [x] 26 个残留 `*.preview.png` 已删（备份在 `.review/removed-previews/`，需要可还原）
- [x] 3 个标题错别字已修：`AngleBeats!`→`Angel Beats!`、`党大胆`→`胆大党`、`党大胆2`→`胆大党 第二季`
      （顺手修掉「胆大党2」那条错配到「辉夜大小姐」的检索名）

### 仍待处理

- [ ] 4 条检索名为空，**该填什么已经查清**（2026-11-16 只读核查，差一步写 Excel）：
      `21世纪电气目录` → `二十世紀電氣目録-ユーレカ・エヴリカ-`（bgm 255209；注意它其实是《二十世纪电气目录》，
      改 B 列标题必须同步重命名 `images\21世纪电气目录\`，否则图片目录对不上）；
      `记忆管理局` → bgm 358568（不是 2020 那部同名短片）；`无职转生2上半` →
      `無職転生Ⅱ ～異世界行ったら本気だす～`（bgm 373247，第1クール）；`无职转生3上半` →
      `無職転生Ⅲ ～異世界行ったら本気だす～`（bgm 501963，整季）。检索名为空时会回退用标题去搜。
- [ ] 2 行海报 URL 仍指向 `cover-nobg.png`（2026-11-16 核查，实际是**两个角色**）：
      **星野爱**（目录里只有 `cover-nobg.png`，一旦点「撤销去底」就会退成占位图 → 需要补一张原图 `cover.jpg`）；
      **今井绿**（目录里 `cover.jpg` 在，改回原图零风险，`applyCutout` 渲染时仍会自动用去底图）。
- [ ] `辛恩·诺赞`（行 248）与 `辛・诺赞`（行 243）是同一角色的重复卡，前者的图片目录是空的 ——
      合并要么删行（走应用内删除，避免 `anime.id` 漂移），要么补图。
- [ ] **整季影评的取样会撞上 OP/ED**：每集只分到 1~2 张图时，均匀采样经常落在片头字幕/制作人员表上
      （实测六集那次，AI 自己 caveat 说「六张里五张是 OP/ED 人员表」）。改进方向：取样时跳过前 ~90 秒，
      或按「集时长前 10% 降权」。
- [ ] 同一部番连续分析多集时，相邻两集的「同一时刻」可能生成一模一样的分镜图
      （实测 ep05-1 与 ep06-1 内容相同，AI 也标了 caveat）—— 取样时要在集之间错开相位。
- [x] **两组「并存实现」已合并**（2026-11-16）：`src/services/rankingService.ts` 与
      `features/ranking/ranking-service.ts` 是逐行副本，雷达图改指向 features 后旧文件已删。
      可选后续：统一并列口径（改 mid-rank，会让每维 138–167 条百分位变动 1–11pp，**必须先补测试**）；
      把 `nearbyRanking` 收编成 `rankNeighbors()`（零 UI 变化，但当前无测试，且要保留「编辑中实时预览」）。
- [x] **`calcOverall` 已统一到 `core/overall.ts`**（2026-11-16）：5 份算法 + 5 处适配器收敛成
      `calcOverall` / `calcEntryOverall`，`ai-helpers` 不再回退 `DEFAULT_DIMENSIONS`；
      2000 组随机模板对拍逐位相等。剩下 `core/math.ts` 的同名死函数（仅测试引用）待删。
- [ ] **源表里那 64 行垃圾还没清**：程序加载时会静默丢弃，导出时进「异常行」表。
      ⚠️ 删行会让 `anime.id = 'excel-<行号>'` 漂移 —— 必须走应用里的删除
      （`deleteExcelRow` + `shiftLocalRefsAfterRowDelete` 会一起迁移 localStorage 引用），**不要在 Excel 里手工删**
- [ ] 表格视图目前**不支持新增/删除行**（只改已有行）。删除已有入口（卡片上的删除）；新增走「+ 新增」
- [ ] 表格视图**排序状态不持久化**：关掉再打开会回到 Excel 原始行序（刻意的，避免下次打开看到
      "和文件里不一样"的顺序而误判）

### 待定口味

- [ ] 侧栏折叠默认值（排行榜 20 名 / 时间轴 6 个月）
- [ ] 顶栏把三个批量工具收进「批量工具」下拉，是否保留

---

## 9. 验证手段速查

```bash
npx tsc --noEmit                 # 类型（不含 plugins/*.mjs，见 5.9）
npx vitest run                   # 单测（当前 994；完整数字以实际输出为准）
npm run build:api                # server/ 的语法检查 + 打包
node .review/check-poster.js     # 抽查 Excel 的 posterUrl
node .review/check-category.js   # 看 category 的派生结果
```

CDP steps 支持的动作：`eval` / `wait`（轮询直到真值）/ `waitMs` / `click` / `hover`（支持 x/y）/ `key` / `shot`。
它还会汇报**网络失败、慢请求（>3s）、console 报错**，这三项为空才算验干净。
`window.confirm` 会被自动确认（`cdp.js` 里加了 `Page.javascriptDialogOpening` 处理）。

**CDP 的两个实操坑**：

- 侧栏默认收起，`hover (24,30)` 那个浮动方块才会展开；**弹窗遮罩会挡住它**，
  所以点侧栏入口前先 `document.querySelectorAll('.ant-modal-close').forEach(b=>b.click())`
- 求值里用 `location.reload()` 会销毁执行上下文让 CDP 报错，要拆成两轮跑

**发版后必查**：

1. 服务器返回的 `index-*.js` 文件名变了（说明真的换了 bundle）
2. `http://127.0.0.1:51730/version.json` 的 version 等于新版本号
3. CDP 跑一遍受影响界面，确认网络失败 / 慢请求 / 控制台三栏都为空
