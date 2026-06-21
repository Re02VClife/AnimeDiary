# AnimeDiary 系统概览

> 番剧评分管理系统 — "记录你与每部番的相遇"

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
6. **AI 分析套件** — 6 个 AI Skill（品味分析/偏好画像/智能推荐/单番分析/图谱优化/自动打Tag）
7. **海报管理** — AniList 搜索 + 本地存储 + Excel 持久化
8. **图片管理** — 本地图片上传/删除/设为海报

## 数据流

```
Excel 文件 ←→ Vite API 中间件 ←→ excelService ←→ App State (Context) ←→ UI 组件
localStorage/IndexedDB ←→ storageService ←→ App State (Context) ←→ UI 组件
外部 API (Bangumi/AniList/LLM) ←→ 各 Service ←→ UI 组件
```
