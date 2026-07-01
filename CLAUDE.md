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

数据存在本地 Excel（`番评分.xlsx`），通过 Vite 中间件读写的单页应用。支持全局主题、评分模板、知识图谱、AI 分析套件等。

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
