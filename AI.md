# AI 分析模块 — 架构与维护说明

> 更新：2026-11（重做版）。旧版文档指向的 `src/services/ai*.ts`、`src/components/AISettings.tsx`、`src/components/TasteReportModal.tsx` **已删除**（是同一功能的死副本，改它们不会生效）。

一句话原则：**本地算数，模型说话；所有模型调用都走本地网关。**

---

## 一、总体结构

```
┌──────────────────────────────────────────────┐
│ 浏览器  features/ai-analysis/                 │
│  - 6 个 Skill：算统计 → 拼 prompt → 校验输出   │
│  - llm-service.ts：/api/ai 客户端 + aiJSON 契约│
│  - AISettings / TasteReportModal：UI          │
└───────────────┬──────────────────────────────┘
                │ POST /api/ai/chat（JSON 或 SSE）
┌───────────────▼──────────────────────────────┐
│ 本地服务  server/ai-gateway.ts + ai-routes.ts │
│  - provider 预设 / 密钥落盘 / 模型列表         │
│  - 重试退避 / 超时 / 取消 / 用量记账           │
└───────────────┬──────────────────────────────┘
                │ HTTPS
        ┌───────▼────────┐
        │ OpenCode Go /  │
        │ DeepSeek / ... │
        └────────────────┘
```

## 二、为什么必须走本地代理（实测结论，别再改回浏览器直连）

| 事实 | 后果 |
|---|---|
| `opencode.ai/zen/go` 的 `OPTIONS` 预检直接 **404** | 浏览器无法直连 OpenCode，`deepseek-v4.1-flash` 只能由本地服务代发 |
| 该网关要求请求头 `x-opencode-session`，缺了 **400 MissingSessionID** | 浏览器侧无法注入（也不是 CORS 白名单头） |
| DeepSeek 官方允许 CORS | 老版本直连能跑，所以问题一直没暴露 |
| Key 放 localStorage | 任何脚本都能读；现在只存服务端 |

## 三、配置

真实配置在 **`{DATA_DIR}/ai-config.json`**（`dev` = 项目根，`prod` = `文档/AnimeDiary`），已加进 `.gitignore`。

```jsonc
{
  "provider": "opencode-go",              // opencode-go / deepseek / openai / ollama / custom
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "model": "deepseek-v4.1-flash",
  "apiKey": "…",
  "headers": {},                          // 自定义中转站可能需要的头
  "temperature": 0.45,
  "maxTokens": 4000,                      // 含思维链预算，推理模型要留够
  "timeoutMs": 180000,
  "jsonMode": true,                       // 是否请求 response_format=json_object
  "thinking": "auto",                     // auto | off（off 只在支持该参数的预设上生效）
  "deepMode": false                       // 深度偏好分析开关
}
```

- 也可用环境变量覆盖：`ANIMEDIARY_AI_PROVIDER / _BASE_URL / _MODEL / _API_KEY`。
- 浏览器只保留镜像 `localStorage.anime_diary_ai_mirror_v2`（不含 Key），`App` 启动时 `initAIConfig()` 同步一次。
- 旧版存在 `anime_diary_ai_config` 里的 Key 会在首次同步时自动搬到服务端并清掉。
- 设置面板：侧栏「🤖 AI 分析 → ⚙️ AI 设置」，可选预设、拉 `/models`、**真跑一次结构化请求**做测试。

## 四、结构化输出契约（`llm-service.aiJSON`）

模型输出不是接口，必须当成不可信输入处理。链路：

```
describeSchema(schema) → 请求 → parseLooseJSON → sanitizeBySchema → validateSchema
                                     ↑                                 │
                                     └────── 带着错误清单重写（≤3 轮）──┘
```

- `parseLooseJSON`：去 ```json 代码块、去前后废话、按括号配对截取、容忍尾逗号与中文引号。
- `sanitizeBySchema`：标量自动包成数组、`"0.9"` 转数字、按 min/max 夹紧、删未声明字段、补空数组。
- `validateSchema`：报错带路径（`$.likes[2].confidence`），错误原样回传给模型自纠。
- **推理模型预算升级**：`finish_reason=length` 且正文为空（钱全花在思维链上）时，`max_tokens` 翻倍重来，最多 3 次、封顶 16000；不消耗重写轮次。
  —— 这是 DeepSeek v4.1 这类模型最容易踩的坑：给 500 token 会稳定返回空字符串。

## 五、6 个 Skill

| Skill | 文件 | 输出 Schema | 关键点 |
|---|---|---|---|
| 品味分析 | `taste-analysis.ts` | `TASTE_SCHEMA` | 统计在前端算，只把摘要给模型，杜绝编数字 |
| 偏好画像 | `preference-profile.ts` | `PROFILE_SCHEMA` | 口味偏差 = (总评×0.4+电波×0.6)−BGM；深度模式并发 3 |
| 发现新番 | `smart-recommend.ts` | `RECOMMEND_SCHEMA` | AniList → Bangumi → 搜索 → 模型知识四级降级；本地粗排 24 个再让模型选；Tier 4 结果回查 Bangumi 并标 `verified` |
| 单番分析 | `single-anime-analysis.ts` | `SINGLE_ANIME_SCHEMA` | 维度百分位 + 余弦相似 + 评语，全部来自真实数据 |
| 图谱优化 | `graph-optimize.ts` | `GRAPH_SCHEMA` | Jaccard 在本地算，模型只做"该不该合并"的判断 |
| 自动打标签 | `auto-tag.ts` | `AUTO_TAG_SCHEMA` | 先取 Bangumi 社区标签做事实底座，再补本地体系缺口 |

维度一律通过 `getDimensionsForList()` / `getActiveDimensions()` 取**当前模板**，不再写死默认维度（角色卡会被算成 0 分）。

## 六、运行遥测与缓存

- `beginAIRun()` 开一次运行 → 每个 Skill 内部自动记账 → `getAIRunSummary()` 拿总用量。
  一次深度画像可能是 20+ 次调用，UI 不必逐层传 usage。
- 面板展示的是**真实 token / 推理 token / 耗时 / 重试次数**；OpenCode 网关会返回 `usage.cost`，直接显示美元，其余 provider 不显示金额（不猜价格）。
- `setAIStreamListener()` 把 SSE 的思维链片段喂给面板，长任务不再白屏。
- 缓存：`buildListFingerprint()` 对「条目/分数/标签/评语长度/模板/模型」做指纹，TTL 12h；数据或模型变了自动失效。

## 七、测试

```bash
npx vitest run tests/core/ai-json.test.ts tests/server/ai-gateway.test.ts   # 离线，假 fetch
npm run dev:web                                                             # 另开一个终端
$env:AI_LIVE='1'; npx vitest run tests/features/ai-analysis/live.test.ts     # 真实模型 + 真实 Excel
```

联调测试读真的 `番评分.xlsx`，把 6 个 Skill 全跑一遍，报告写到 `.review/ai-live-report.md`。

> 联调测试必须跑在 **node 环境**（文件头 `@vitest-environment node`）：jsdom 的 `AbortController`
> 和 Node fetch(undici) 的 `AbortSignal` 不是同一个类，传 signal 会报
> `Expected signal to be an instance of AbortSignal`。这是测试环境问题，浏览器里不存在。

## 八、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 空字符串 / 只返回思维链 | 推理模型 `max_tokens` 太小。`aiJSON` 会自动翻倍，仍失败就把设置里的「输出上限」调大 |
| `400 MissingSessionID` | 请求没带 `x-opencode-session`，检查 provider 是否为 `opencode-go` |
| `404` + 提示检查 Base URL | 少了 `/v1`，或网关路径不同 |
| 模型列表拉不到 | `/models` 不可用会回落到预设列表，不影响调用 |
| 分析结果与数据对不上 | 清缓存：设置里没有就不必清，指纹会自动失效；必要时 `clearAICache()` |
| 想换模型试效果 | AI 设置里直接选；模型名也进了指纹，换模型不会复用旧缓存 |
