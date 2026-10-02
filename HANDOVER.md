# AnimeDiary 进度与交接

> 最后更新：**2026-10-02** · 当前版本 **1.0.43** · `master` 与 `origin/master` 同步
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

## 3. 数据规模（2026-10-02 实测）

| 项 | 数量 |
|---|---|
| Excel 数据行合计 | **417** |
| ├ 番剧（默认模板 `default`） | 183 |
| ├ 角色卡（`character`） | 223 |
| └ 自定义模板（2 个，`template-1782592748856` / `template-1782669675979`） | 1 + 10 |
| 检索名为空的行 | 243 |
| 带 `TEMPLATE_JSON` 的行 | 234 |

**Excel 关键列**（0-based，定义在 `features/anime-data/excel-mapping.ts`）：

| 列 | 索引 | 说明 |
|---|---|---|
| A | 0 | 检索名 SEARCH_ALIAS |
| **B** | **1** | **名字 TITLE**（写回校验的基准） |
| D | 3 | 综合(观感) OVERALL —— 公式列，**非默认模板不该写** |
| R | 17 | 首刷时间（Excel 序列号） |
| AL | 37 | 海报 URL |
| AM | 38 | 模板 ID |
| AQ | 42 | TEMPLATE_JSON（非默认模板的评分 + 自定义字段） |

---

## 4. 项目结构

```
core/                     纯工具函数（math/color/text/date）
features/                 10 个业务模块
  ai-analysis/            AI 分析套件（14 文件）
  anime-data/             Excel 读写 + 模板持久化（5 文件）
  anime-detail/           ScoreSlider
  character-complete/     角色补全 + 角色卡合并（4 文件）
  image-management/       海报 / 截图 / 去白底（5 文件）
  knowledge-graph/        力导向图
  media-complete/         数据补全面板
  ranking/                百分位排名
  search-add/             Bangumi / AniList 搜索入库
  watch-calendar/         侧栏时间轴
context/AnimeContext.tsx  useReducer 全局状态（~920 行）
src/components/           UI 组件（AnimeGrid / AnimeDetailModal ~2450 行 / Sidebar / TopBar …）
src/types/index.ts        AnimeEntry / ScoreTemplate / 两个内置模板工厂
```

**评分模板**：模板存 localStorage（`anime_diary_templates`）。两个内置模板由代码里的工厂函数定义：

- `createDefaultTemplate()` → 番剧评分，9 维（含 `overall` 总评，weight 0）
- `createCharacterTemplate()` → 角色评分，**6 项**：`overall`(总评,w=0) + 角色设计 / 性格 / 声优 / 萌点电波 / 好感度（各 1/5）

---

## 5. 改代码前必读的坑

### 5.1 同名死副本（已经坑过一次）

下面这些文件**没有任何 import**，是历史遗留的重复副本。改到它们身上不会有任何效果，而且重新构建后**文件名 hash 都不会变**：

| 死文件 | 真正生效的文件 |
|---|---|
| `src/components/WatchCalendar.tsx` | `features/watch-calendar/WatchCalendar.tsx` |
| `src/services/excelService.ts` | `features/anime-data/excel-service.ts` |
| `src/services/excelMapping.ts` | `features/anime-data/excel-mapping.ts` |
| `src/services/storageService.ts` | `features/anime-data/storage-service.ts` |

⚠️ 注意 `src/services/imageService.ts` 和 `aiSkills.ts` 是**活的**（被多处引用），别一起删。

**判断改对了没**：构建后在产物里搜一个你新写的字符串，例如

```powershell
$c = [System.IO.File]::ReadAllText('dist\assets\index-*.js', [System.Text.Encoding]::UTF8)
([regex]::Matches($c, 'category==="watched"')).Count
```

### 5.2 Excel 写入有三道保护

1. **写前校验**：`/api/excel/write` 每条更新都带 `expectedTitle`，与目标行 B 列不符就整体拒绝并返回 409（`{conflicts:[…]}`），**一个字节都不写**。所以"改了名存不进去"通常意味着前面某次写入没落盘。
2. **`EDITABLE_COLS` 白名单**：编辑路径只写这些列，公式列（含 D 列 OVERALL）碰不到。
3. **原子写 + 快照**：`writeFileAtomic()` 走 `snapshotExcel()`；内容 hash 与最新快照相同则**不产生新备份**（所以"写了一样的内容"看不到新备份是正常的）。

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

---

## 6. 本阶段完成（2026-09 ~ 2026-10）

| 版本 | 提交 | 内容 |
|---|---|---|
| 1.0.36 | `3c69e12` | 角色模板 v6：删「能力设定」「成长弧光」，加「好感度」，「外观」→「角色设计」 |
| 1.0.37 | `ec495e1` `c40be7d` | 去白底面板：勾选随时可用；只处理勾选项；缩略图显示去底结果 |
| 1.0.38 | `85fd041` | **修复改名 409 死循环**：`mapAnimeToUpdates` 从来没写过 B 列标题 |
| 1.0.39 | `cca8d06` | 角色评分模板补上 `overall`「总评」维度（v6→v7），与番剧模板对齐 |
| 1.0.40~42 | `8b5e51f` | 按「改进.doc」修 5 处：时间轴只显示「看过」、海报轮播越界、上/下一张顺序跟随网格排序、侧栏滚动劫持、设置项分组整理 |
| 1.0.43 | `0c114cc` | 侧栏板块改为「默认 20 名 / 6 个月 + 展开全部」，避免全铺开 |

**同阶段的数据维护**（不进 git，直接写 Excel）：

- 修正 35 条错配的检索名（AniList 对中文标题的 top-1 命中率低，改用 Bangumi 复核）
- 回滚 37 行被误写成 `cover-nobg.png` 的海报 URL
- 清理角色卡里已废弃的 `char_ability` / `char_growth` 维度

---

## 7. 待办

### 高优先级

- [ ] **清理 4 个同名死副本**（见 5.1）。已确认无人引用，但属于删除文件，动手前先确认一次。
- [ ] **`handleFixSearchAlias` 会污染数据**（`context/AnimeContext.tsx:667`）：它拿 `data.list[0].name`（AniList top-1）**无条件覆盖**每一条有 `excelRowIndex` 的检索名，不管当前值对不对 —— 之前那 35 条错配就是这么来的。建议改成 Bangumi 优先 + 要求 `name_cn` 与标题相似度过阈值才写。

### 数据清理

- [ ] 243 行检索名为空（会影响海报自动搜索的命中率）
- [ ] 3 个标题错别字：`AngleBeats!` → `Angel Beats!`、`党大胆` → `胆大党`、`党大胆2` → `胆大党2`
- [ ] 26 个残留的 `*.preview.png`（去底过程的暂存文件，`images/` 下）
- [ ] 2 行海报 URL 仍指向 `cover-nobg.png`（「星野爱」，该目录没有原图可回退）

### 待定口味

- [ ] 侧栏折叠默认值（排行榜 20 名 / 时间轴 6 个月）目前是我选的，可调
- [ ] 顶栏把「数据补全 / 角色补全 / 去白底」收进了「批量工具」下拉，也可改回平铺

---

## 8. 验证手段速查

```bash
npx tsc --noEmit                 # 类型
npx vitest run                   # 单测（321）
node .review/check-poster.js     # 抽查 Excel 的 posterUrl
node .review/check-category.js   # 看 category 的派生结果
```

CDP steps 支持的动作：`eval` / `wait`（轮询直到真值）/ `waitMs` / `click` / `hover` / `key` / `shot`。
它还会汇报**网络失败、慢请求（>3s）、console 报错**，这三项为空才算验干净。

**发版后必查**：

1. 服务器返回的 `index-*.js` 文件名变了（说明真的换了 bundle）
2. `http://127.0.0.1:51730/version.json` 的 version 等于新版本号
3. CDP 跑一遍受影响界面，确认网络失败 / 慢请求 / 控制台三栏都为空
