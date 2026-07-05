# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 核心原则（继承自上层 CLAUDE.md）

**Tradeoff:** 这些原则偏向谨慎而非速度。简单任务自行判断。

1. **先想再写** — 不确定就问，有多种理解就列出来
2. **简单至上** — 只写解决需求的最少代码，不做未要求的抽象/灵活性/错误处理
3. **精准改动** — 只改相关的，不改相邻代码/格式/注释，不重构没坏的东西
4. **目标驱动** — 先写验证标准再实现，多步任务列出步骤+验证方式
5. **强制中文输出** — 思考过程、对话、代码注释全部简体中文；只有代码本身（变量名、函数名等）保持英文

---

## 项目概述

AnimeDiary — 番剧评分管理系统。React 18 + TypeScript + Ant Design 5 + ECharts 5 + Vite 6 + Electron 33。

数据存在本地 Excel（`番评分.xlsx`），通过 Vite 中间件读写的单页应用。支持全局主题、评分模板、知识图谱、AI 分析套件等。也适配除了番剧以外的其他作品评分。

## 常用命令

```bash
npm run dev:web     # 纯 Web 开发（浏览器 http://localhost:5173）
npm run dev         # 完整 Electron 桌面开发
npx tsc --noEmit    # TypeScript 类型检查（唯一验证手段，无 lint/test 要求）
npm test            # Vitest 单元测试
```

## 架构分层

```
src/theme/          — 全局主题系统（ThemeContext + CSS变量 + 猫娘模式 + 图标接口）
context/             — AnimeContext（useReducer 全局状态，约 800 行）
src/components/      — UI 组件（TopBar / Sidebar / AnimeGrid / AnimeDetailModal ~1750 行 / 等）
src/types/           — 核心类型定义（AnimeEntry / ScoreTemplate / Dimension / 等）
src/App.tsx          — 薄编排器，组合布局 + 弹窗
features/
  anime-data/        — Excel 读写（excel-service）+ 模板持久化（template-service）
  ai-analysis/       — LLM 调用 + 6 个分析 Skill
  knowledge-graph/   — 力导向知识图谱
  ranking/           — 百分位排名计算
  search-add/        — Bangumi/AniList 搜索入库
  anime-detail/      — ScoreSlider 评分滑块
  watch-calendar/    — 追番日历
  image-management/  — 海报/截图管理
core/                — 纯工具函数（数学/颜色/文本/日期）
```

## 关键数据流

```
Excel(番评分.xlsx) ←→ Vite 中间件(/api/excel/*) ←→ excel-service ←→ AnimeContext ←→ UI组件
localStorage ←→ template-service / ThemeContext / storage-service ←→ UI组件
外部API(Bangumi/AniList/LLM) ←→ 各 Service ←→ UI组件
```

**重要：** Excel 读写走 Vite 中间件（vite.config.ts 中 `excelApiPlugin`），不是前端直接操作文件。`appendAnimeEntry` 追加新行，`updateAnimeEntry` 按 `excelRowIndex` 定位写回。

## 状态管理（AnimeContext.tsx）

全局状态 `AnimeState` 使用 `useReducer`，主要字段：

- `animeList` — 全部条目（从 Excel 加载后常驻内存）
- `activeCategory` / `activeTag` / `searchText` — 筛选条件
- `activeDim` / `sortByDim` / `sortOrder` — 排序维度
- `activeTemplateId` — 当前模板（**持久化到 localStorage**）
- `radarMode` / `radarMin` — 雷达图配置

`filteredAnime`（useMemo）按 模板→分类→搜索→标签→排序 流水线过滤条目。

## 评分模板系统

核心类型：`ScoreTemplate { id, dimensions: Dimension[], fieldConfig, categoryLabels, layoutConfig }`

- 模板存 localStorage（key: `anime_diary_templates`），`loadTemplates()` / `saveTemplates()` 读写
- `getTemplate(id)` 按 ID 查找模板，未找到回退默认模板
- 条目通过 `entry.templateId` 关联模板，缺省 = `'default'`
- 非默认模板的维度分数序列化到 Excel 的 `TEMPLATE_JSON` 列（JSON 格式），而非独立列
- 分类标签留空 = 隐藏该分类 tab，全部留空 = 不按分类筛选

## 总评计算（多处重复，修改需同步）

```typescript
// 总评 = 加权平均，不存于 entry.scores 中
// calcOverall 出现在三处，逻辑必须一致：
// 1. AnimeGrid.tsx calcOverall
// 2. Sidebar.tsx calcOverall
// 3. AnimeContext.tsx filteredAnime 的 overall 排序分支
// 核心：getTemplate(entry.templateId).dimensions → 过滤 overall → 等权重兜底 → 加权求和
```

**关键坑：** `sortByDim === 'overall'` 时不能用 `rankByDimension()`，因为总评是计算值不存在于 `scores` 数组，`rankByDimension` 会把所有条目过滤掉。

## 主题系统

- `ThemeContext` 管理 `themeMode`（dark/light）、`customColors`、`catgirlMode`、`customIcons`
- 所有组件颜色使用 CSS 变量（`var(--brand-primary)` 等），定义在 `src/theme/presets.ts` → `colorsToCSSVariables()` 注入 `document.documentElement.style`
- `main.tsx` 的 `ConfigProvider` 同步 antd token 与 CSS 变量
- antd 组件内联 style 也用 `var(--xxx)` 而非硬编码色值
- 猫娘模式：`catgirlfy()` 文本转换 + `catgirlMessage` 替换 antd message 调用

## 模板 Excel 导入

支持两种格式自动识别：

- **列式布局**（首列为空/综合）：维度在列上，权重从"综合"列公式提取
- **行式布局**（首列=名称）：每行一个维度定义

导入操作同时：创建模板 + 创建条目 + 保存到 Excel + 自动切换模板。

## 雷达图

- 两种模式：`percentile`（百分位 0-100）/ `fixed`（固定值 0-10，超出溢出）
- ECharts radar `trigger: 'item'` 时 `params.value` 是数组，tooltip 需遍历
- 最小值默认 0，可自定义（`radarMin`）

## 注意事项

- **没有 linter** — `npx tsc --noEmit` 是唯一质量检查
- xlsx 库在 Vite 中需 `import * as XLSX from 'xlsx'`（namespace import），并配置 `optimizeDeps.include: ['xlsx']`
- 新增非默认模板的条目时，`excelRowIndex` 为 undefined → 调用 `appendAnimeEntry` 而非 `updateAnimeEntry`
- `AnimeDetailModal` 是最大组件（~1750 行），拖拽排序使用 HTML5 Drag API + CSS `order`
- Electron 主进程在 `electron/` 目录，仅做窗口管理

## 卡片毛玻璃信息区

卡片底部 `.card-info` 使用海报图对应位置做毛玻璃背景：

- **机制**：AnimeGrid 将海报 URL 以 CSS 变量 `--poster-url` 注入 card-info
- **CSS**：`.card-info.has-poster-bg::before` — 伪元素取海报底部区域，`filter: blur(8px) brightness(0.7)` 模糊+加暗
- **兜底**：无海报图时 fallback 到 `var(--bg-secondary)` 纯色背景
- 文字改白色 `#fff` + `text-shadow` 确保暗底可读

## 侧栏收起

- Sider `collapsedWidth={0}`（收起时不占布局空间）
- 左上角 60×60 浮动方块（`position: absolute`），悬停展开侧栏
- TopBar 单独包裹 `<div marginLeft={60}>`，仅顶栏右移，网格不动

## 海报共享元素过渡（FLIP 动画）

打开/关闭详情面板时，海报从网格位置飞入 Modal 位置：

- **PosterFlipOverlay.tsx** — Portal 渲染 `<img>` 到 `document.body`（z-index: 10000），CSS transition 同步过渡 left/top/width/height/border-radius/object-position
- **捕获时机**：点击卡片 → `getBoundingClientRect()` + `getComputedStyle().objectPosition` 捕获网格位置；50ms 后捕获 Modal 海报位置；关闭时反向捕获
- **时序**：Modal 用 `transitionName=""` 瞬时到位 → 克隆飞入(350ms) + 面板淡入(150ms延迟, 200ms过渡) 同时完成
- **降级**：无海报时直接弹 Modal，无过渡

## 面板淡入时序

点击卡片后：150ms 延迟 → 200ms 淡入（与海报飞入 350ms 同时完成）。`App.tsx` 中 `contentRevealReady` 状态 + `setTimeout(150ms)` 控制。

## 在线截图/录制功能

ImageManager 工具栏"在线截图"按钮 → ScreenCapture 悬浮窗（840px 宽，可拖拽+边框调整大小）：

### 截图 Tab
- `screenshot-desktop`（OS 原生 API）截取全屏，返回 PNG dataUrl
- 打开即自动截全屏预览
- 四边像素值裁剪（上/下/左/右 `InputNumber`）
- 框选区域：全屏浮层拖拽选区 → 自动换算像素值

### 录制 Tab
- `getDisplayMedia()` + `MediaRecorder` → webm（GPU 加速，60fps）
- `electron/main.js` 同时设置 `setPermissionRequestHandler` + `setDisplayMediaRequestHandler`
- 录制前倒计时（默认 3 秒，0-10 可调），屏幕左上角红色圆形显示
- 录制中：ESC 或面板 [停止] 按钮结束
- 录制后：`<video>` 预览（裁剪区间强制、clip-path 可视化裁剪）
- 片头片尾裁剪（百分比滑块）+ 调速（0.25x-3x）
- 保存 webm 视频（IPC `capture:saveVideo` → `images/{番剧名}/`）
- 转 GIF：从 webm 提取帧 → 裁剪 + 调速 → gifenc 编码（可调 fps/尺寸/色彩）
- `extractFrames()` 用 `recordingDurationRef` 回退 MediaRecorder 缺失的 duration 元数据

### 技术栈
| 组件 | 技术 |
|------|------|
| 截图 | `screenshot-desktop`（Windows: GDI+, macOS: screencapture, Linux: scrot） |
| 录制 | `getDisplayMedia` + `MediaRecorder`（GPU 加速） |
| GIF 编码 | `gifenc`（纯 JS，无原生依赖） |
| 视频保存 | Electron IPC `capture:saveVideo` → `fs.writeFileSync` |

### Electron IPC 新增
- `capture:getSources` — `desktopCapturer.getSources()` 获取屏幕/窗口列表
- `capture:takeScreenshot` — `screenshotDesktop()` OS 原生全屏截图
- `capture:saveVideo` — 保存 webm 到 `images/{番剧名}/`

### 新增依赖
- `gifenc` — 纯 JS GIF 编码
- `screenshot-desktop` — 跨平台原生截图
- 类型声明：`src/types/gifenc.d.ts`
