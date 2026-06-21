# Excel 数据集成需求

> 文件: features/anime-data/

## 核心需求

- **双向同步**: Excel ↔ 应用内存，修改自动写回
- **列映射**: 38 列（评分/评价/海报/角色等），`excel-mapping.ts` 定义常量
- **海报持久化**: URL 写入 Excel 列 `AL`（POSTER_URL）
- **批量操作**: `batchSaveAllPosters()` 一次 API 调用持久化所有海报

## API 端点（Vite 中间件）

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/excel/read` | GET | 读取全部 Sheet 数据 |
| `/api/excel/write` | POST | 写入更新列表 |
| `/api/excel/info` | GET | 文件基本信息 |
| `/api/excel/open` | GET | 系统默认程序打开文件 |

## 数据加载流程

```
loadAnimeList()
  1. fetch /api/excel/read → 获取原始行
  2. mapRowToAnime() → Excel行 → AnimeEntry
  3. 应用用户覆盖 (分类/黑名单/海报/维度评价)
  4. AniList 海报缓存补完
  5. 返回最终列表
```

## Mock 降级

API 不可用时降级返回 2 条 Mock 数据（86不存在的战区 Part1 / 利兹与青鸟）
