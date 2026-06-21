# AI 分析套件需求

> 来源: AI.md | 状态: ✅ 三期全部完成

## 架构

```
UI 层 (TasteReportModal / AnimeDetailModal)
  → Skill 层 (features/ai-analysis/ 6个Skill文件)
    → LLM 服务层 (llm-service.ts)
      → OpenAI 兼容 API (DeepSeek / OpenAI / 通义千问 / Ollama)
```

## 6 个 AI Skill

| Skill | 文件 | 功能 |
|-------|------|------|
| **tasteAnalysis** | `taste-analysis.ts` | 维度统计 + LLM 生成品味报告 |
| **preferenceProfile** | `preference-profile.ts` | 口味偏差分析（元数据模式 + 深度模式） |
| **smartRecommend** | `smart-recommend.ts` | 四层降级推荐（AniList → Bangumi v0 → Bangumi搜索 → LLM直接推荐） |
| **singleAnimeAnalysis** | `single-anime-analysis.ts` | 单番深度分析（核心吸引力+电波模式+社区差异） |
| **graphOptimize** | `graph-optimize.ts` | Jaccard 相似度发现冗余标签 + LLM 建议合并 |
| **autoTag** | `auto-tag.ts` | Bangumi 社区标签 + LLM 筛选建议 |

## 深度模式流程

1. Phase `collecting` — 调 `/api/bangumi/reviews` 采集社区评论
2. Phase `analyzing` — 逐番 LLM 提取优点/雷点（最多 20 部）
3. Phase `synthesizing` — 汇总共性提取偏好画像

## LLM 兼容性

- Provider: DeepSeek (默认) / OpenAI / 通义千问 / Ollama
- 协议: OpenAI 兼容 `/chat/completions`
- 不支持 SSE 流式（中文 UTF-8 乱码问题）
- 不支持 `response_format`（部分 provider 不兼容）
- JSON 输出通过 System Prompt 约束 + `extractJSON()` 解析
