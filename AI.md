# AI 集成 — 架构设计

> **状态**：一期已完成（2026-06-16）  
> **原则**：重计算留前端，LLM 只做它擅长的最后一公里。

---

## 一、总体架构

```
┌──────────────────────────────────────────────────┐
│  UI 层                                           │
│  - 设置面板：API Key / Base URL / 模型名          │
│  - 品味报告 Modal                                │
│  - 推荐面板（侧栏/弹窗）                          │
│  - 图谱优化建议条                                │
│  - 智能打 tag 按钮（详情面板）                    │
├──────────────────────────────────────────────────┤
│  Skill 层（src/services/aiSkills.ts）             │
│                                                   │
│  每个 skill 做三件事：                             │
│   1. 数据准备 —— 纯计算，从 animeList 中提取       │
│   2. 组装 Prompt —— 把数据填入模板                │
│   3. 调用 LLM → 解析结构化输出 → 返回             │
├──────────────────────────────────────────────────┤
│  LLM 服务层（src/services/llmService.ts）          │
│                                                   │
│  - chat(prompt, { schema?, stream? })             │
│  - 多 provider 适配（OpenAI 兼容格式）             │
│  - JSON Schema 约束输出                            │
│  - 错误重试 + 超时                                │
├──────────────────────────────────────────────────┤
│  API Key 管理（src/services/aiConfig.ts）          │
│                                                   │
│  - 读/写 localStorage                             │
│  - 字段：baseUrl, apiKey, model                   │
│  - 支持 DeepSeek / OpenAI / Ollama / 通义千问     │
└──────────────────────────────────────────────────┘
```

---

## 二、LLM 服务层

### 2.1 统一接口

```typescript
// src/services/llmService.ts

interface LLMConfig {
  baseUrl: string;   // 默认 https://api.deepseek.com/v1
  apiKey: string;
  model: string;     // 默认 deepseek-chat
}

interface LLMCallOptions {
  /** 最大 token 数 */
  maxTokens?: number;
  /** JSON Schema 约束输出格式 */
  schema?: object;
  /** 是否流式返回 */
  stream?: boolean;
  /** 超时（ms） */
  timeout?: number;
}

/**
 * 调用 LLM，自动拼接 /chat/completions
 * provider 只要兼容 OpenAI 格式即可
 */
async function chat(
  systemPrompt: string,
  userPrompt: string,
  options?: LLMCallOptions,
): Promise<string>;
```

### 2.2 Provider 兼容性

所有兼容 OpenAI `/v1/chat/completions` 格式的 provider 都能用：

| Provider | baseUrl | model |
|----------|---------|-------|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5:7b` |

### 2.3 关键实现细节

```typescript
// 非流式调用（skill 专用）
async function chat(systemPrompt, userPrompt, options) {
  const config = loadAIConfig();
  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: options?.maxTokens ?? 1000,
      temperature: 0.3,  // skill 场景偏确定性
      // JSON Schema 约束
      ...(options?.schema ? {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'output', schema: options.schema },
        },
      } : {}),
    }),
    signal: AbortSignal.timeout(options?.timeout ?? 30000),
  });
  // 错误处理 + 解析
}
```

---

## 三、API Key 配置

### 3.1 存储

```typescript
// src/services/aiConfig.ts

const CONFIG_KEY = 'anime_diary_ai_config';

interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_CONFIG: AIConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
};

export function loadAIConfig(): AIConfig;
export function saveAIConfig(config: AIConfig): void;
export function hasAIConfig(): boolean; // apiKey 非空
```

### 3.2 设置面板 UI

在侧栏「⚙️ 设置」区域加一个「🤖 AI 设置」折叠区：

```
API 地址   [https://api.deepseek.com/v1    ]
API Key    [••••••••••••                    ]
模型       [deepseek-chat                   ]
连接测试   [ 测试连接 ]
```

- 三个输入框 + 一个测试按钮
- 测试按钮调 `/v1/models` 验证连接
- 保存到 localStorage

---

## 四、Skill 层

### 4.1 品味分析 `tasteAnalysis`

**定位**：用户点一下，出一份文字报告。

**前端计算**：
- 各维度百分位均值（`rankingService.buildPercentileMap`）
- 分类型（tag）的评分统计
- 月度追番密度（按 `createdAt` 算）
- 标准差最大的维度（品味是否稳定）

**Prompt 结构**：
```
System: 你是一个番剧品味分析师。根据用户的评分数据，生成一份简洁的品味报告。
不要评价用户的品味好坏，只做客观描述。

User:
- 番剧总数：200 部
- 各维度平均百分位：剧情 72% | 作画 35% | 音声 58% | ...
- 评分最集中的标签：科幻(15部,均值8.2)、日常(12部,均值7.1)
- 追番密度最高月：2024-04(7部)、2023-10(6部)
- 评分标准差最大维度：电波(σ=2.1)、沉浸(σ=1.6)

请输出 JSON：
{ "summary": "一句话总览", "highlights": ["亮点1", ...], "notes": ["有趣的发现", ...] }
```

**输出**：JSON → UI 渲染为卡片式报告。

**成本估算**：~500 input token + ~200 output token，DeepSeek 约 ¥0.001/次。

---

### 4.2 偏好画像 `preferenceProfile`

**定位**：从电波极值番 + 口味偏差值 + 用户评价中提炼用户品味模型，作为推荐的"灵魂"输入。

**核心理念**：电波是唯一完全主观的维度——高分电波="和灵魂对上了"，低分电波="设定都对但就是不来电"。这个信号比任何其他维度都更反映真实偏好。

---

#### 口味偏差值

引入一个新指标：**个人口味 vs 社区共识的偏离度**。

```
口味偏差值 = (总评 × 0.4 + 电波 × 0.6) - BGM评分
```

| 偏差值 | 含义 |
|--------|------|
| 强正值（>1.5） | 你特别喜欢但社区评价一般——**隐藏的偏好信号** |
| 强负值（< -1.5） | 社区公认好但你不太感冒——**暴露雷区** |
| 接近 0 | 口味与社区一致 |

总评权重 0.4 + 电波权重 0.6 的设计理由：总评是加权平均（偏客观），电波是纯主观。放大电波对口味偏差值的贡献，让"个人感受"主导偏离方向。

这个值会贯穿所有 skill——偏好画像用它找极值样本，推荐用它判断"这部番大概率对味"。

---

#### 模式一：元数据模式（默认，扩展样本量）

**前端计算**：
- 按口味偏差值排序，取正偏差 top-15 + 负偏差 bottom-15
- 按电波排序，取 top-10 + bottom-10
- 两组取并集去重，最终约 25-35 部番作为分析样本
- 样本的标签聚类、维度均值、制作公司分布、年代分布
- 从用户评价文本中提取关键词（简单分词 + 频次统计，不调 LLM）
- 附加统计：所有番的口味偏差值分布直方图（供 LLM 理解用户整体偏离倾向）

**Prompt 结构**：
```
System: 你是一个番剧品味分析师。根据用户的口味偏差数据和评分特征提炼偏好画像。

User:
=== 口味偏差概况 ===
用户整体倾向：正偏差番 68 部（平均偏差 +0.8），负偏差番 45 部（平均偏差 -1.2）
→ 用户总体比 BGM 社区评分更挑剔，对某些番有强烈的个人偏好

=== 强烈正偏差番（个人 >> 社区）===
86 不存在的战区 | 总评9.07 电波9.72 | BGM 7.6 | 偏差 +3.46
利兹与青鸟 | 总评8.88 电波9.27 | BGM 8.6 | 偏差 +2.83
...

=== 强烈负偏差番（社区 >> 个人）===
盾勇 | 总评6.5 电波4.2 | BGM 7.8 | 偏差 -2.62
...

=== 样本共性 ===
高偏差番共现标签：严肃向×11 催泪×6 战争×4
高偏差番维度均值：沉浸9.1 剧情8.4 深度8.5 制作8.3
低偏差番共现标签：异世界×12 轻改×8 后宫×5
低偏差番维度均值：剧情5.3 深度3.5 人设5.0
用户评价关键词：A-1巅峰、泽野弘之、情绪推到顶点、龙傲天看得累、卖肉影响观感

请输出 JSON：
{
  "likes": [{ "aspect": "", "confidence": 0.9, "evidence": "" }],
  "dislikes": [{ "aspect": "", "confidence": 0.85, "evidence": "" }],
  "preferenceProfile": "一句话总结",
  "tasteDeviation": "用户整体口味偏好的趋势描述",
  "hiddenGems": [{ "anime": "", "reason": "" }]
}
```

**样本量对比**：

| | 旧方案 | 新方案 |
|---|--------|--------|
| 选样方式 | 电波极值 | 电波极值 + 口味偏差极值 |
| 样本量 | 10 部 | 25-35 部 |
| Token 消耗 | ~1200 | ~2000 |
| 费用 | ¥0.003 | ¥0.005 |

---

#### 模式二：深度模式（Bangumi 评论挖掘，可选开关）

**触发条件**：用户在设置面板开启「🔬 深度偏好分析」

**数据采集**（后端，Vite 中间件）：
- 取口味偏差值正负各 top-10（20 部番）
- 对每部番调用 Bangumi API 获取 subject ID → 拉评论列表
- 每部最多取前 30 条有内容的评论（过滤纯打分/单句吐槽）
- 总评论量：20 部 × 30 条 = 最多 600 条
- 结果缓存到本地 JSON（`bangumi_review_cache.json`），24 小时内不重复请求

**LLM 提取**（分两步，先聚类再总结）：

**Step 1 — 逐番分析**（每部番的评论合并为一条 prompt）：
```
System: 从以下评论中提取 3 个优点和 2 个雷点，用短语概括。
User: 以下是「86 不存在的战区」的 Bangumi 评论节选：
  ...

输出：{ "strengths": [...], "weaknesses": [...] }
```

**Step 2 — 共性提取**（所有番的分析结果汇总）：
```
System: 根据多部番的优点/雷点分析结果，结合口味偏差值，提炼用户的整体偏好模型。
User:
正偏差番共性优点：...
负偏差番共性雷点：...

请输出偏好画像 JSON（同模式一格式）...
```

**成本估算**：Step 1 约 20 部 × ~2000 token = 4 万 token，Step 2 约 3000 token，总计约 **5 万 token**。DeepSeek 约 ¥0.1~0.2/次。

**安全措施**：
- Bangumi API 请求间隔 1s，避免限流
- 缓存 24 小时，同一天重复点击不消耗
- 设置面板有开关，默认关闭，用户主动触发
- 深度模式运行时显示进度条「正在分析 ××（3/20）…」
- 单次失败不影响整体，分析到哪算哪

---

#### 偏好画像的数据流

```
用户数据（本地）
  ├─ 口味偏差值排序 → top-15 + bottom-15 ─┐
  ├─ 电波排序 → top-10 + bottom-10 ────────┤
  ├─ 标签聚类 + 维度统计 + 评价关键词 ─────┤
  │                                         ├─→ 模式一 prompt → LLM → 画像
  └─ [可选] Bangumi 评论 → 逐番分析 → 共性提取 → 模式二 prompt → LLM → 画像
                                                    │
                                                    ▼
                                         喂给 smartRecommend
```

---

### 4.3 单部分析 `singleAnimeAnalysis`

**定位**：在详情面板中，点击按钮对当前番剧做深度分析——为什么这部番电波高/低，口味偏差大的原因是什么。

**触发方式**：详情面板 → 编辑模式下新增「🤖 深度分析」按钮。

**前端计算**：
- 当前番剧的全部维度分数 + 百分位排名
- 口味偏差值
- 用户对该番的评价文本
- 已有标签
- 与该番评分最相似的 3 部番（余弦相似度 top-3）

**元数据模式**（默认）：

```
System: 你是一个番剧分析专家。根据用户的评分数据，分析一部番剧为什么对用户有特别的意义（或为什么不来电）。

User:
番剧：86 不存在的战区
维度分数：总评9.07 音声9.6 制作9.3 作画8.6 沉浸10 剧情8.0 人设8.0 深度9.0 电波9.72
百分位排名：音声98% 制作95% 沉浸100% 电波99% | 剧情62% 人设55%
口味偏差值：+3.46（你远比社区更喜欢这部番）
BGM 评分：7.6

用户评价：
"A1制作巅峰，辛和蕾娜的感情线克制但动人。分镜、演出、配乐全部在线。泽野弘之的配乐把情绪推到顶点。战争残酷与人性光辉的极致对比。"

相似番剧：末日三问(余弦0.91)、利兹与青鸟(0.89)、来自深渊(0.87)

请分析：
1. 这部番打动用户的核心原因（基于维度极值 + 评价）
2. 与其他高电波番的共性
3. 为什么 BGM 社区评分偏低但用户给了超高电波（口味偏差解读）

输出 JSON：
{
  "coreAppeal": [{ "aspect": "", "evidence": "", "confidence": 0.9 }],
  "vibePattern": "与其他高电波番的共性总结",
  "communityGap": "为什么用户和社区口味有差距",
  "similarAnime": [{ "title": "", "why": "" }]
}
```

**深度模式**（可选）：额外爬取该番的 Bangumi 评论区（最多 30 条），让 LLM 对比社区观点和用户观点的差异。

```
额外分析社区观点与个人观点的对比：
- 社区普遍认为的优点 vs 你看重的优点
- 社区普遍吐槽的点 vs 你不在意的点
- 输出：{ "communityVsPersonal": { "aligned": [...], "divergent": [...] } }
```

**成本**：元数据模式 ~800 token（¥0.002），深度模式 ~5000 token（¥0.01）。

**入口位置**：番剧详情面板 → 编辑模式 → 维度评分区域底部 →「🤖 深度分析」按钮。

---

### 4.4 智能推荐 `smartRecommend`

**定位**：基于偏好画像 + 多路召回，推荐你可能喜欢的番。

**前端计算**：
1. 余弦相似度 top-15（8 维评分向量）
2. 图谱路径推荐（同公司 + 共享标签的番，且不在任何已看列表）
3. 排除已看/在看/抛弃的番
4. 并入 `preferenceProfile` 输出的 `{ likes, dislikes, preferenceProfile }`

**Prompt 结构**：
```
System: 你是一个番剧推荐引擎。根据用户偏好画像，从候选列表中挑选最匹配的番剧。

User:
=== 用户偏好画像 ===
喜欢：严肃叙事、情感密度高、制作精良、泽野弘之配乐
讨厌：龙傲天套路、异世界轻改、卖肉媚宅

=== 候选列表 ===
- 紫罗兰永恒花园 | BGM 8.7 | 京都动画 | 治愈/催泪 | 匹配点：制作顶级+情感渲染+标签重度重合
- Vivy | BGM 8.5 | WIT STUDIO | 科幻/音乐 | 匹配点：严肃叙事+制作精良+AI主题深度
- ...

请从候选列表中挑 3-5 部推荐，每部附带一句话理由（结合偏好画像说明为什么匹配）。输出 JSON：
{ "recommendations": [{ "title", "reason", "confidence": 0.8 }] }
```

**输出**：推荐卡片列表，每条有推荐理由。

**成本估算**：~800 input + ~300 output，DeepSeek 约 ¥0.002/次。

---

### 4.5 图谱优化 `graphOptimize`

**定位**：发现标签体系中的问题，建议合并/拆分/新增标签。

**前端计算**：
- Jaccard 高但名称不同的标签对（"科幻" vs "SF"）
- 使用次数 = 1 的稀有标签
- 未加标签的番剧（特别是维度评分完整的）

**Prompt 结构**：
```
System: 你是一个标签体系优化专家。分析动漫标签数据，发现可合并的冗余标签和缺失标签。

User:
疑似冗余对：
- "异世界"(15部) vs "转生"(12部) — Jaccard 0.7，语义高度重叠
- "机甲"(8部) vs "萝卜"(4部) — Jaccard 0.6

单次使用标签：同人改、OVA特别篇、...

无标签但评分完整的番剧：
- 86 不存在的战区 | 剧情9.0 沉浸10  | 现有标签：科幻/战争

请输出 JSON：
{ 
  "merges": [{ "from", "to", "reason" }],
  "newTags": [{ "anime", "tag", "reason" }],
  "issues": ["标签'SF'建议统一为'科幻'"]
}
```

**输出**：建议列表，用户可一键执行合并/添加。

---

### 4.6 智能打 tag `autoTag`

**定位**：在详情面板点击按钮，AI 搜索并调用bangumi等动漫网站的tag数据给当前番剧建议几个标签。


**输出**：标签建议列表，用户可选确认添加。

---

## 五、数据流

### 5.1 Skill 依赖关系

```
tasteAnalysis（统计 → 报告，独立运行）

preferenceProfile（口味偏差 + 电波极值 + 标签聚类 → 偏好画像）
       │
       ├── 元数据模式（默认）：25-35 部样本，~2000 token
       ├── 深度模式（可选）：+ Bangumi 评论挖掘，~5 万 token
       │
       ▼
smartRecommend（画像 + 候选集 → 推荐列表）
       │
       └── 每次都消费 preferenceProfile 的最新输出

singleAnimeAnalysis（单番 → 深度解读，独立运行）
       │
       ├── 详情面板触发，每次分析一部番
       └── 深度模式可选 + Bangumi 社区观点对比

graphOptimize（标签体系 → 优化建议，独立运行）
autoTag（单番 → 标签建议，独立运行）
```

### 5.2 品味分析流程

```
用户点击「🤖 品味分析」
  │
  ▼
tasteAnalysis(animeList)
  │
  ├─► rankingService.buildPercentileMap(animeList)
  │     → 各维度全量分布
  ├─► 聚合：各维度均值、方差、分类统计、月度密度
  │     → 纯 JS，不调 LLM
  │
  ├─► 组装 Prompt（数据填入模板）
  │
  ├─► llmService.chat(system, user, { schema })
  │     → 调用 /v1/chat/completions
  │
  └─► 解析 JSON 输出 → 渲染报告 UI
```

### 5.3 深度模式流程（Bangumi 评论挖掘）

```
用户开启「🔬 深度偏好分析」→ 点击「🤖 偏好画像」
  │
  ▼
后端 Vite 中间件 /api/bangumi/reviews
  │
  ├─► 取电波 top-10 / bottom-10 的番剧标题
  ├─► 依次调 Bangumi API 搜 subject → 拉评论
  ├─► 每部 < 30 条，过滤短评（字数小于30），写入 bangumi_review_cache.json
  └─► 返回 { anime: { strengths[], weaknesses[] } }
       │
       ▼
 前端逐番调 LLM 提取优点/雷点（20 部 × 1 prompt = 20 次调用）
       │
       ▼
 汇总 20 份结果 → 再次调 LLM 提取共性（1 次调用）
       │
       ▼
 输出 preferenceProfile JSON → 渲染 + 缓存供推荐使用
```

---

## 六、实现分期

### 第一期（核心链路）✅ 已完成

| 文件 | 计划内容 | 实际实现 |
|------|----------|----------|
| `src/services/aiConfig.ts` | API 配置读/写 | ✅ localStorage 存储 baseUrl / apiKey / model / deepMode |
| `src/services/llmService.ts` | `chat()` 函数 + 错误处理 | ✅ `chat()` 非流式 + `chatStream()` SSE 流式；频率/存在惩罚（`frequency_penalty: 0.5`, `presence_penalty: 0.3`）；支持标记提取 JSON |
| `src/components/AISettings.tsx` | 设置面板（含深度模式开关） | ✅ Modal 表单：Base URL / API Key / 模型 / 连接测试 / 深度模式开关 |
| `src/services/aiSkills.ts` | `tasteAnalysis()` + `preferenceProfile(mode)` | ✅ 两个 skill + 独立的 `buildTasteStats()` / `buildDeviationData()` 供 UI 展示中间统计 |
| `src/components/TasteReportModal.tsx` | 品味报告 + 偏好画像面板 | ✅ 双 Tab 三阶段：Phase 1 前端统计（进度条/标签云/偏差分布）→ Phase 2 加载 → Phase 3 文本报告 + Token 用量条 |
| `src/components/Sidebar.tsx` | — | ✅ 新增「🤖 AI 分析」折叠区：品味分析入口 + AI 设置入口 |

#### 与计划差异

| 项目 | 计划 | 实际 | 原因 |
|------|------|------|------|
| 输出模式 | JSON Schema 约束 | System prompt 中内联 JSON 格式要求 | 用户 provider 不支持 `response_format: json_schema` |
| 实时流式 | SSE 逐 token 展示 | 非流式 `chat()` 一次性返回 | SSE 解析在用户环境下不稳定（中文 UTF-8 多字节 + provider 差异导致乱码） |
| 偏好画像样本 | 25-35 部 | 按可用数据动态（BGM + 电波均有评分的番） | 实际数据量决定 |
| 费用显示 | 无 | Token 用量条（输入/输出/预估费用） | 用户体验优化 |

#### 踩坑记录

1. **SSE 流式解析不可靠**：先后尝试了行分割 `split('\n')`、事件分割 `split('\n\n')`、`TextDecoderStream` 管道，在中文环境下均出现不同程度乱码。最终改为非流式 `chat()` + 前端格式化。
2. **`response_format: json_schema` 不被所有 provider 支持**：Ollama 和部分代理会返回 `This response_format type is unavailable now`。解决方案：在 system prompt 中直接写明期望的 JSON 格式，并加 `extractJSON()` 处理 markdown 代码块包裹。
3. **LLM 重复循环**：中文长输出时模型容易陷入 token 重复。解决方案：`frequency_penalty: 0.5` + `presence_penalty: 0.3` + `temperature: 0.3` + `maxTokens` 控制在 800-1500。

### 第二期（推荐 + 深度模式）🔄 部分完成

| 任务 | 文件 | 状态 |
|------|------|------|
| `smartRecommend()` | `src/services/aiSkills.ts` | ✅ 已实现（余弦相似度 + 图谱路径候选池 → LLM 精选） |
| 偏好画像缓存 | `src/services/aiCache.ts` | ✅ localStorage + 24h 过期，供推荐消费 |
| 推荐面板 | `src/components/TasteReportModal.tsx` 第三个 Tab | ✅ 「🎁 智能推荐」Tab，金色排名卡片 |
| Bangumi 评论采集 | `vite.config.ts` → `/api/bangumi/reviews` | ❌ 待实现 |
| 深度模式偏好分析 | `src/services/aiSkills.ts` → 分两步 LLM 提取 | ❌ 待实现 |
| `RecommendPanel.tsx` 独立组件 | — | ❌ 暂集成在 TasteReportModal 中，可后续抽出 |

### 第三期（辅助 skill）

| 任务 | 文件 | 状态 |
|------|------|------|
| `singleAnimeAnalysis()` | `src/services/aiSkills.ts` | ❌ 待实现 |
| `graphOptimize()` | `src/services/aiSkills.ts` | ❌ 待实现 |
| `autoTag()` | `src/services/aiSkills.ts` | ❌ 待实现 |
| 图谱优化建议 UI | `KnowledgeGraphModal.tsx` | ❌ 待实现 |
| 详情面板「🤖 深度分析」按钮 | `AnimeDetailModal.tsx` | ❌ 待实现 |

---

## 七、成本对比

| Skill | 状态 | Token 消耗 | DeepSeek 费用 | 数据源 | 延迟 |
|-------|------|-----------|-------------|--------|------|
| 品味分析 | ✅ | ~800 | ¥0.002 | 本地统计 | < 5s |
| 偏好画像 | ✅ | ~1500 | ¥0.003 | 口味偏差+电波极值 | < 5s |
| 智能推荐 | ✅ | ~600 | ¥0.001 | 缓存画像 + 候选池 | < 5s |
| 偏好画像（深度） | ❌ | ~5 万 | ¥0.10~0.20 | + Bangumi 评论 | 30~60s |
| 单部分析 | ❌ | ~800 | ¥0.002 | 单番维度+评价 | < 5s |
| 单部分析（深度） | ❌ | ~5000 | ¥0.01 | + Bangumi 评论 | 10~15s |
| 图谱优化 | ❌ | ~2000 | ¥0.005 | 标签 Jaccard | < 5s |
| 智能打 tag | ❌ | ~500 | ¥0.001 | 单部番数据 | < 3s |

> 已实现的三个 skill 跑一轮（品味 + 画像 + 推荐）：约 ¥0.006，不到 1 分钱。

---

## 八、边界与防御

| 风险 | 措施 |
|------|------|
| 未配置 API key | 品味分析 Modal 显示引导页，提示去 AI 设置配置 |
| API 调用失败 | 分类错误提示（401/403/404/429/超时/网络），显示「重试」按钮 |
| LLM 输出格式错误 | system prompt 内联 JSON 格式声明 + `extractJSON()` 处理 markdown 包裹 |
| LLM 重复循环 | `frequency_penalty: 0.5` + `presence_penalty: 0.3` + `temperature: 0.3` + `top_p: 0.9` |
| 请求超时 | `AbortController` 双通道（超时自动 abort + 用户手动取消） |
| Token 超限 | `maxTokens` 控制在 600-1500 范围 |
| API key 明文存储 | localStorage 存，桌面端风险低 |
| 用户用本地模型 | baseUrl 支持自定义，指向 `localhost:11434` 即可用 Ollama |
| `response_format` 不支持 | 已移除该参数，改用自然语言 prompt 约束 |
