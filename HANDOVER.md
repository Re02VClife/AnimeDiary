# AnimeDiary 进度与交接

> 最后更新：**2026-10-11** · 当前版本 **1.0.48** · 前端已发版（`master` 尚未提交，工作区有改动）
>
> 这份文档面向"接手的人 / 下一个 AI 会话"，只写**当前状态、怎么发版、坑在哪**。
> 2026-06 那次架构重构的完整记录在 [`progress.md`](progress.md) —— 那是历史存档，不要改写它。

---

## 1. 一分钟上手

| 项 | 值 |
|---|---|
| 技术栈 | React 18 + TypeScript + Ant Design 5 + ECharts 5 + Vite 6 + Electron 33 |
| 主数据 | `%USERPROFILE%\Documents\AnimeDiary\番评分.xlsx`（**不入 git**） |
| 图片 | 同目录 `images\{番剧名}\` |
| 备份 | 同目录 `backups\`（滚动快照，当前 16 个） |
| 安装位置 | `E:\AnimeDiary\AnimeDiary.exe` |
| 热更新源 | `E:\AnimeDiary-updates`（硬编码在 `electron/main.js:77`） |
| 内置 API | 固定端口 **51730** |
| 开发 | `npm run dev:web`（浏览器 5173） / `npm run dev`（Electron） |

质量门禁只有两个，**没有 linter**：

```bash
npx tsc --noEmit    # 唯一类型检查
npx vitest run      # 321 用例 / 16 文件
```

---

## 2. 发版流程（改完代码必走这套）

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
core/                     纯工具函数（math/color/text/date/character）
features/                 11 个业务模块
  ai-analysis/            AI 分析套件（14 文件）
  anime-data/             Excel 读写 + 模板持久化
    excel-transfer.ts       导出分表 / 导入重建 / D 列公式重建
  anime-detail/           ScoreSlider
  character-complete/     角色补全 + 角色卡合并（4 文件）
  image-management/       海报 / 截图 / 去白底（5 文件）
  knowledge-graph/        力导向图
  media-complete/         数据补全面板
  ranking/                百分位排名
  search-add/             Bangumi / AniList 搜索入库
  watch-calendar/         侧栏时间轴
context/AnimeContext.tsx  useReducer 全局状态（~890 行）
src/components/           UI 组件（AnimeGrid / AnimeDetailModal ~2470 行 / Sidebar / TopBar …）
  ExcelEditor.tsx         表格视图（应用内看/改列表数据）
  excel-editor-model.ts   表格视图的数据层（列定义/读值/排序/应用编辑，可单测）
src/types/index.ts        AnimeEntry / ScoreTemplate / 两个内置模板工厂
server/api-routes.ts      共用的 /api 处理器（dev 中间件 + Electron 生产同源）
```

**评分模板**：模板存 localStorage（`anime_diary_templates`）。两个内置模板由代码里的工厂函数定义：

- `createDefaultTemplate()` → 番剧评分，9 维（含 `overall` 总评，weight 0）
- `createCharacterTemplate()` → 角色评分，**6 项**：`overall`(总评,w=0) + 角色设计 / 性格 / 声优 / 萌点电波 / 好感度（各 1/5）

> ⚠️ **用户实际用的权重可能和 `DEFAULT_DIMENSIONS` 不一样**（实测确实不一样，见第 6 节）。
> 任何"按权重算总评"的地方都必须走 `getTemplate(...)` 读 localStorage，不能用硬编码常量兜底。

---

## 5. 改代码前必读的坑

### 5.1 同名死副本（1.0.44 清理了 4 个，仍有走副本）

曾有 4 个**没有任何 import** 的历史副本，改到它们身上不会有任何效果，重新构建后**文件名 hash 都不会变**（就是这么踩进去的）。已在 1.0.44 删除：

| 已删除的死文件 | 真正生效的文件 |
|---|---|
| `src/components/WatchCalendar.tsx` | `features/watch-calendar/WatchCalendar.tsx` |
| `src/services/excelService.ts` | `features/anime-data/excel-service.ts` |
| `src/services/excelMapping.ts` | `features/anime-data/excel-mapping.ts` |
| `src/services/storageService.ts` | `features/anime-data/storage-service.ts` |

**仍在的走副本**（1.0.47 实测确认，改它们不生效）：

| 死文件 | 真正生效的文件 |
|---|---|
| `src/components/KnowledgeGraphModal.tsx` | `features/knowledge-graph/KnowledgeGraphModal.tsx` |
| `src/components/TasteReportModal.tsx` | `features/ai-analysis/TasteReportModal.tsx` |
| `src/components/DimensionManager.tsx` | 已被 `src/components/TemplateManager.tsx` 取代 |

⚠️ `src/services/` 剩下的 7 个文件**全是活的**（`aiCache` / `aiConfig` / `aiSkills` / `graphService` / `imageService` / `llmService` / `rankingService`），别再当副本删。

⚠️ 另有两组**并存的两套实现**（不是副本，不同组件各用一套，别误合并）：
`src/services/rankingService.ts` ↔ `features/ranking/ranking-service.ts`；
`src/services/graphService.ts` ↔ `features/knowledge-graph/`。

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
| `calcOverall` | 5+ 处 | `AnimeGrid` / `Sidebar` / `AnimeDetailModal`（两份）/ `ai-helpers` / `core/math` |
| `round2` | 曾有 2 份 | `excel-transfer` 里的副本缺 nudge → `.5` 边界少 0.01（1.0.48 删除） |
| `formatScore` / `fmt2` | `core/math` | 统一入口，别再自己写 |

**动手前先 grep 函数名，确认有几份、哪份真的被 import。**

### 5.8 PowerShell 改文件会把编码搞坏

**不要**用 `(Get-Content -Raw) -replace ... | Set-Content` 改含中文的文件 —— `Set-Content` 默认用系统 ANSI，
会把中文写成 `?` 且**不可逆**（1.0.48 期间就把本文件搞坏过一次，只能 `git checkout` 整份恢复后重改）。
要改文本用编辑工具；要在命令行处理，必须显式 `-Encoding utf8`。

---

## 6. 总评（综合观感）的口径 —— 三处必须一致

这是 1.0.47 修的那个 bug 的完整背景，**改任何一处都要回来看这一节**。

### 6.1 谁在算总评

| 位置 | 用的维度来源 | 说明 |
|---|---|---|
| 网格卡片 `AnimeGrid.calcOverall` | `getTemplate(entry.templateId)` | ✅ 正确 |
| 侧栏排行榜 `Sidebar.calcOverall` | 同上 | ✅ 正确 |
| 详情面板 `AnimeDetailModal.overallScore` | **曾经是 `DEFAULT_DIMENSIONS`** | ❌ 1.0.47 修好 |
| AI 套件 `ai-helpers.calcOverall` | `DEFAULT_DIMENSIONS`（不传参时） | 独立实现，**未统一** |
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
表格视图所有数字列、详情面板加权值、雷达图 tooltip、知识图谱 BGM、品味报告 σ/偏差、角色补全标题分全部走它。

⚠️ **两个改这块时容易踩的坑**（都有单测锁住）：

1. `Number('')` 是 **0** 不是 NaN —— 排序里判空必须先判空串，否则「没填的」会被当成 0 排到最前面
2. 只读列里可能装的是**公式串**（「内容」列实测有 `=IF(...)`）。对它做数字格式化会得到空串，
   等于让那个单元格凭空消失。`displayValue` 里转不成数字就原样显示

### 已完成（1.0.47 / 1.0.48）——总评口径统一（「两个总评」那个 bug）

**症状**：同一部番，网格卡片一个总评、点开详情面板另一个（实测 `轻音少女 剧场版`：卡片 9.14 / 详情 9.09）。

**根因**：见 **第 6 节**。用户那套权重是 `音声.10 制作.10 作画.10 沉浸.12 剧情.15 人设.15 深度.15 电波.13`，
和代码 `DEFAULT_DIMENSIONS` 的 `.12/.15/.13/.15/.20/.10/.10/.05` 完全不同 —— 所以卡片用前者、详情用后者。

**验证**：打包版实测 卡片 = 文件 D 列 = 详情面板（多条一致）；D 列 188 行逐行校验 0 不一致。

---

## 8. 待办

### 已完成（1.0.44）

- [x] 删掉 4 个同名死副本（见 5.1）
- [x] **`handleFixSearchAlias` 重写**：只处理番剧 → 查 Bangumi → `pickBestMatch`（季数消歧 + 年份修正）打分
      → **分数 < `LOW_CONFIDENCE`(0.6) 一律跳过不写**，写入的是原名（日文）。
      实测 183 条：**写入 45、已正确 129、拿不准跳过 9**；抽查 12 条全部正确，续作没错配到相邻季度
- [x] 26 个残留 `*.preview.png` 已删（备份在 `.review/removed-previews/`，需要可还原）
- [x] 3 个标题错别字已修：`AngleBeats!`→`Angel Beats!`、`党大胆`→`胆大党`、`党大胆2`→`胆大党 第二季`
      （顺手修掉「胆大党2」那条错配到「辉夜大小姐」的检索名）

### 仍待处理

- [ ] 番剧里还有 **4 条检索名为空**：`记忆管理局`、`21世纪电气目录`、`无职转生2上半`、`无职转生3上半`。
      前两条是 Bangumi 匹配分数不够被主动跳过；后两条是用户自己拆的上/下半，源站没有对应条目。
      留着不影响使用 —— 检索名为空时会回退用标题去搜。
- [ ] 2 行海报 URL 仍指向 `cover-nobg.png`（「星野爱」，该目录没有原图可回退）
- [ ] 上面 5.1 提到的两组「并存实现」可以合并，但属于重构，动手前先逐条确认两边行为一致
- [ ] **`calcOverall` 还有 5 份实现没统一**（见 5.7）。最值得合的是 `ai-helpers.calcOverall` ——
      它不传 `dimensions` 时永远用 `DEFAULT_DIMENSIONS`，和界面口径不一致（AI 分析算出来的总评会偏）
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
npx tsc --noEmit                 # 类型
npx vitest run                   # 单测（384）
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
