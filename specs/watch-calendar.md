# 追番日历需求

> 文件: features/watch-calendar/

## 功能

- 按 `createdAt`（首刷时间 YYYY-MM-DD）年月分组
- 支持最新/最早排序
- 每组显示番剧标题、海报缩略图
- 点击跳转到番剧详情

## 数据

- 数据源: AnimeEntry.createdAt（来自 Excel "首刷时间"列）
- 空日期条目显示在"未知时间"分组
