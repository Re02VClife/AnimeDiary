# AnimeDiary 系统概览

> 番剧评分管理系统 — "记录你与每部番的相遇"
>
> 最后核对：2026-11-05（v1.1.0）。本目录是 2026-06 的**需求**快照，
> 实现细节以 [`AI.md`](../AI.md) 与 [`HANDOVER.md`](../HANDOVER.md) 为准。

## 技术栈

- **前端**: React 18 + TypeScript + Ant Design 5 + ECharts 5
- **构建**: Vite 6
- **桌面壳**: Electron 33
- **数据存储**: Excel (.xlsx) + localStorage + IndexedDB
- **外部 API**: Bangumi、AniList、LLM (DeepSeek/OpenAI 兼容协议)

## 核心功能

1. **番剧数据管理** — Excel 双向同步、分类筛选、批量操作、导入导出
2. **多维度评分** — 8 个评分维度（音声/制作/作画/沉浸/剧情/人设/深度/电波）+ 加权总评
3. **排名系统** — 百分位排名 + 雷达图可视化
4. **知识图谱** — ECharts 力导向图，番剧/制作公司/标签/角色关系网络
5. **追番日历** — 基于首刷时间的时间轴视图
6. **AI 分析套件** — 8 个能力：品味分析 / 偏好画像 / 智能推荐 / 单番分析 / 图谱优化 /
   自动打 Tag / 联网检索番剧资料 / 查社区评论。另有对话窗口，可用自然语言调度这些能力
7. **海报管理** — AniList 搜索 + 本地存储 + Excel 持久化
8. **图片管理** — 本地图片上传/删除/设为海报
9. **存档与回退** — 写 Excel 前自动留快照 + 操作日志，可退回任意一次改动之前

## 数据流

```
Excel 文件 ←→ Vite API 中间件 ←→ features/anime-data/excel-service ←→ App State (Context) ←→ UI 组件
localStorage/IndexedDB ←→ features/anime-data/storage-service ←→ App State (Context) ←→ UI 组件
外部 API (Bangumi/AniList/LLM) ←→ server/* ←→ 各 feature service ←→ UI 组件
```
