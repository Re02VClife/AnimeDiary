# AI 分析模块 — 架构与维护说明

> 更新：2026-11（重做版）。旧版文档指向的 `src/services/ai*.ts`、`src/components/AISettings.tsx`、`src/components/TasteReportModal.tsx` **已删除**（是同一功能的死副本，改它们不会生效）。

一句话原则：**本地算数，模型说话；所有模型调用都走本地网关。**

---

## 一、总体结构

```
┌──────────────────────────────────────────────┐
│ 浏览器  features/ai-analysis/                 │
│  - 8 个 Skill：算统计 → 拼 prompt → 校验输出   │
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

## 五、AI 能力（Skill）

| Skill | 文件 | 输出 Schema | 关键点 |
|---|---|---|---|
| 品味分析 | `taste-analysis.ts` | `TASTE_SCHEMA` | 统计在前端算，只把摘要给模型，杜绝编数字 |
| 偏好画像 | `preference-profile.ts` | `PROFILE_SCHEMA` | 口味偏差 = (总评×0.4+电波×0.6)−BGM；深度模式并发 3 |
| 发现新番 | `smart-recommend.ts` | `RECOMMEND_SCHEMA` | AniList → Bangumi → 搜索 → 模型知识四级降级；本地粗排 24 个再让模型选；Tier 4 结果回查 Bangumi 并标 `verified` |
| 单番分析 | `single-anime-analysis.ts` | `SINGLE_ANIME_SCHEMA` | 维度百分位 + 余弦相似 + 评语，全部来自真实数据 |
| 图谱优化 | `graph-optimize.ts` | `GRAPH_SCHEMA` | Jaccard 在本地算，模型只做"该不该合并"的判断 |
| 自动打标签 | `auto-tag.ts` | `AUTO_TAG_SCHEMA` | 先取 Bangumi 社区标签做事实底座，再补本地体系缺口 |
| 检索番剧资料 | `external-skills.ts` | 无（直接返回结构化对象） | 联网查 Bangumi，失败回落 AniList；**本地没有的番也能查**，顺手带回你自己的分数做对照 |
| 查社区评论 | `external-skills.ts` | 无 | 走 `/api/bangumi/reviews`（接口自带 24h 缓存），单条限长 300 字、最多 12 条 |

维度一律通过 `getDimensionsForList()` / `getActiveDimensions()` 取**当前模板**，不再写死默认维度（角色卡会被算成 0 分）。

### 能力清单（`skill-registry.ts`）

6 个 skill 之上还有一张声明表 `AI_SKILLS`（现在共 8 个能力，含两个联网检索），
UI 与对话窗口都读它：
`id / title / description（给模型判断何时该用）/ effect / context / modelInputs / inputSchema / run / summarize`。

- **参数只放客观事实**：`modelInputs` 只允许番剧名这类定位信息。统计数字（百分位、偏差、σ）
  必须由 `run()` 内部用真实数据重算 —— 让模型传就等于允许它编。
- **`resolveEntry()` 是保守的**：精确 → 忽略大小写 → 唯一包含匹配，命中多处直接返回 null。
  宁可让用户重选，也不猜错一部番。
- **`effect` 目前全是 `read`**。将来加写能力必须标 `write`，`getSkillsFor(permission)` 会按三档权限过滤。
- `toToolSpecs()` 把清单翻译成 OpenAI 风格的 tools（id 里的 `-` 换成 `_`），对话窗口接工具调用时直接用。

registry 是**薄包装**：底层 6 个函数的签名与实现没动，`live.test.ts` 与详情面板照旧直接用它们。

### 工具调用通道（`/api/ai/chat`）

网关已支持 OpenAI 风格的 tools，对话窗口可以直接用自然语言指挥 skill。

- 请求体：`tools: AIToolSpec[]` + `toolChoice`。**tools 与 `response_format=json_object` 互斥** ——
  同时带多数网关直接 400，所以 `buildBody` 里有 tools 时不再加 `response_format`。
- 响应：`ChatResult.toolCalls`，`arguments` 保留**原始 JSON 字符串**，解析交给浏览器
  （`core/ai-tools.ts` 的 `parseToolArguments`，宽容空串 / ```json 包裹 / 前后废话）。
- **坑：带工具调用的回复 `content` 是空的，这是正常现象。** 早先的
  `if (!content.trim()) throw '模型返回了空内容'` 会把每一次工具请求都打死，
  现在改成「content 空且没有 toolCalls」才算 empty。
- **流式下 tool_calls 是增量的**：按 `index` 分槽，`id` 只在首块给，`arguments` 是一段段
  JSON 文本必须拼接；`name` 只认第一次出现的值（拼接会得到 `get_weatherget_weather`）。
  这几条都有单测（`tests/server/ai-gateway-tools.test.ts`）。

实测（OpenCode Go + `deepseek-v4.1-flash`）：非流式与流式都能正确返回 `finishReason: tool_calls`，
把 `assistant.tool_calls` + `role:'tool'` 结果回传后模型能正常收尾。注意**要留足 `maxTokens`**
（预算太小时会截断成 `finish_reason: length` 并在尾巴上多带一个半截调用）。

## 六、AI 写操作权限（三档）
`core/ai-permission.ts` 定义，存服务端 `ai-config.json` 的 `permission` 字段（不是 localStorage —— 它是安全边界）。

| 档位 | AI 能做什么 | 落地行为 |
|---|---|---|
| `read` | 只出分析结果 | 批量改动入口（全是「全部采纳」这类）直接隐藏，只能逐条手点 |
| `confirm` | 可以提议，不能直接落库 | 弹出提议（带改动前后对比），点确认才执行 |
| `write` | 可以直接改数据 | 跳过确认直接执行，但写审计日志、保留一次撤销 |

- **默认 `confirm`**。`normalizeAIPermission()` 把任何非法值都收敛到 `confirm`：既不禁用功能，也不会让 AI 悄悄写数据。
- 所有判断走 `getAIPermission()` / `canAIPropose()` / `canAIAutoApply()`，不要在组件里各自读 `config.permission`。
- 改动提议的数据结构在 `core/ai-proposal.ts`：`createTagProposal` 生成、`checkProposalStale` 在落库前比对
  `before` 值（提议与落库之间用户可能自己改过，对不上就拒绝，不用过期提议覆盖新数据）。
- AI 来源的写操作通过请求头 `X-Op-Source: ai` 打到 Excel 路由，落进 `operations.jsonl` 的来源字段。

## 七、对话窗口与会话

抽屉（`src/components/AIChatDrawer.tsx`）是对话入口：右侧浮层、宽度可拖拽（340 ~ 730px），
不挤压网格 —— 189 张卡片重排 + ECharts 重算的开销比遮挡更划不来。

- **调度**：`chat-agent.ts` 的 `runChatAgent` 负责「模型说要调工具 → 本地执行 → 结果回传」的循环，
  最多 4 轮。模型不可信的那几道闸见该文件顶部注释（工具名对不上、参数非法、越权字段、
  循环止损、call id 缺失）。
- **会话**：`chat-sessions.ts`，存 `localStorage.anime_diary_ai_sessions_v1`，上限 30 个。
  存的是**模型视角的完整往返**（含 `tool_calls` / `role:'tool'`），切回来能接着聊 ——
  少一条 `role:'tool'` 模型就会重复调用同一个工具。
- **省配额**：工具记录只存摘要 `toolMeta`，原始结果从 `content` 解析还原（`chat-transcript.ts`）。
  超过 8000 字符被截断过的内容解析失败，就不提供「查看原始结果」，而不是让整个会话打不开。
- **流式**：SSE 片段按 `requestAnimationFrame` 合并刷新。逐片 `setState` 会把主线程刷爆。
- **别在 setState 的 updater 里做副作用**：项目开着 StrictMode，updater 会跑两次，
  `saveSessions` 会双写、`setActiveId` 会在渲染期更新别的组件。会话变更先用 `sessionsRef`
  算好新列表，再一次性 `setSessions`。
- **Markdown**：回答确实是 Markdown，用 `react-markdown` + `remark-gfm` 渲染（`Markdown.tsx`）。
  链接一律 `target="_blank"` —— Electron 里普通 `<a href>` 会把窗口本身导航走。

### 批量操作为什么不走对话

每个能力只处理**一部番**，所以「给所有番打标签」这类批量请求在对话里必然卡在
`maxRounds` 止损上（默认 4 轮，每轮并行 2-3 次 ≈ 8 部就停）。就算放开轮数，
189 部 × 13 秒 ≈ 40 分钟、189 次模型调用，用户体验和成本都不成立。

所以批量是**独立流程**（`src/components/BatchTagModal.tsx`）：

```
选范围 → runBatchTag（并发 4，可取消，进度实时） → 逐条勾选 → updateAnimeEntries 一次写回
```

两个关键设计：

1. **按 entry 处理，不按标题** —— 对话里的 `auto-tag` 要先 `resolveEntry(title)`，
   匹配不上就报「找不到这部番」；批量直接拿 `AnimeEntry`，没有这个不确定性。
2. **写回必须合成一次请求**。服务端每次 `/api/excel/write` 都是「读整表 → 改行 →
   写整表 → 留一份写前快照」，快照只保留 10 份。逐条写 64 次会把**批处理开始前**
   的状态挤出窗口，最该回退的那个点反而没了。`updateAnimeEntries` 把多行合并成一次
   POST，只产生一份快照、一条操作日志。

## 八、运行遥测与缓存

- 一次运行 = 一个 `AIRun` 实例（`createAIRun()`）：`run.begin()` 清零 → 每个 Skill 内部自动记账 →
  结束前 `run.summary()` 拿总用量。一次深度画像可能是 20+ 次调用，UI 不必逐层传 usage。
- **必须传 run 的场景**：并行会话、聊天 + 后台分析同时跑。`AICallOptions.run` 不传会落到
  `defaultAIRun`，也就是旧的全局行为；两个并发运行共用默认实例会**静默串账**
  （A 的 token 记到 B 头上、思考片段串到另一个画面），所以新代码一律显式传自己的实例。
- 8 个 Skill 的 options 都有 `run?: AIRun` 并原样透传给 `aiJSON`。加新 Skill 别忘了这一步。
- 面板展示的是**真实 token / 推理 token / 耗时 / 重试次数**；OpenCode 网关会返回 `usage.cost`，直接显示美元，其余 provider 不显示金额（不猜价格）。
- `run.setListener()` 把 SSE 的思维链片段喂给面板，长任务不再白屏；监听器是**每实例独立**的。
- 缓存：`buildListFingerprint()` 对「条目/分数/标签/评语长度/模板/模型」做指纹，TTL 12h；数据或模型变了自动失效。

## 九、测试

```bash
npx vitest run tests/core/ai-json.test.ts tests/server/ai-gateway.test.ts   # 离线，假 fetch
npm run dev:web                                                             # 另开一个终端
$env:AI_LIVE='1'; npx vitest run tests/features/ai-analysis/live.test.ts     # 真实模型 + 真实 Excel
```

联调测试读真的 `番评分.xlsx`，把 6 个 Skill 全跑一遍，报告写到 `.review/ai-live-report.md`。

> 联调测试必须跑在 **node 环境**（文件头 `@vitest-environment node`）：jsdom 的 `AbortController`
> 和 Node fetch(undici) 的 `AbortSignal` 不是同一个类，传 signal 会报
> `Expected signal to be an instance of AbortSignal`。这是测试环境问题，浏览器里不存在。

## 十、常见问题
| 现象 | 原因 / 处理 |
|---|---|
| 空字符串 / 只返回思维链 | 推理模型 `max_tokens` 太小。`aiJSON` 会自动翻倍，仍失败就把设置里的「输出上限」调大 |
| 带工具调用时 `content` 是空的 | **这是正常的**，不是错误。工具调用的回复本来就没有正文，看 `toolCalls` 字段 |
| 模型反复调用同一个工具 | 回传时必须把 `assistant.tool_calls` 与 `role:'tool'` 消息原样带上，且 `tool_call_id` 要对得上，否则模型以为上次没发生过 |
| `400 MissingSessionID` | 请求没带 `x-opencode-session`，检查 provider 是否为 `opencode-go` |
| `404` + 提示检查 Base URL | 少了 `/v1`，或网关路径不同 |
| 模型列表拉不到 | `/models` 不可用会回落到预设列表，不影响调用 |
| 分析结果与数据对不上 | 清缓存：设置里没有就不必清，指纹会自动失效；必要时 `clearAICache()` |
| 想换模型试效果 | AI 设置里直接选；模型名也进了指纹，换模型不会复用旧缓存 |
