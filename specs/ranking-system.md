# 排名系统需求

> 文件: features/ranking/

## 功能

- **百分位排名**: 每部番剧在每个维度上的分数在所有番剧中的位置
- **维度排序**: 按任意维度分数排序列表
- **BGM 排序**: 按 Bangumi 社区评分排序
- **雷达图可视化**: ECharts 雷达图以百分位值为轴

## 核心函数

| 函数 | 说明 |
|------|------|
| `buildPercentileMap()` | 构建各维度百分位分布 |
| `getPercentileScores()` | 获取某番剧的百分位排名 |
| `rankByDimension()` | 按维度分数排序 |
| `getTopN()` | 获取某维度 Top N |
