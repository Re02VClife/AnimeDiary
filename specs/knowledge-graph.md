# 知识图谱需求

> 文件: features/knowledge-graph/

## 功能

- **节点类型**: 番剧(anime) / 制作公司(studio) / 标签(tag) / 角色(character)
- **关系类型**: studio / tag / character / same_studio / shared_tags / similar_scores
- **可视化**: ECharts 力导向图，颜色传播算法

## 构建流程

1. 聚合实体节点（≥2次的制作公司/标签/角色）
2. 生成 anime→entity 边
3. 生成 anime→anime 边（同制作公司/Jaccard标签/余弦评分）
4. 度数 → 节点大小映射
5. 颜色传播（番剧吸收相连实体颜色）

## 交互

- 关系类型筛选（Checkbox 组）
- 搜索高亮节点
- 连线模式（拖拽连接番剧 → 实体节点，SVG 叠加 + RAF 磁吸检测）
- 双击还原视图
