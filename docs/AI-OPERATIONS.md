# AI 操作手册（AnimeDiary）

> 写给「要操作 AnimeDiary 的 AI」：内置对话窗口，以及将来接入的 DSH / 插件。
> 接口实现见 `core/app-tools.ts`（契约）与 `features/ai-analysis/app-tools.ts`（执行器）。
> 维护约定见 `AGENTS.md`。

## 1. 你能做什么

你可以通过工具读取用户的番剧数据，并在获得授权后**单条**修改它。所有写操作最终都会回到
`AnimeContext.handleSaveAnime`，也就是和用户手动点「保存」完全同一条链路：

- 按 `excelRowIndex + expectedTitle` 定位，标题对不上整批拒绝；
- 只写可编辑列，公式列（C/D/J/U/Y）不碰；
- 原子写 + 写前快照，可在「存档与回退」里撤回。

**不要**尝试绕过工具直接改文件、改 localStorage 或拼 Excel 路径。

> 唯一例外：**音乐绑定**（`app_music_bind`）写的是 `music-links.json`（侧车文件），不碰 Excel，
> 所以它走 `host.bindMusic` 而不是 `host.saveAnime`。除此之外仍只有一条 Excel 写入路径。

## 2. 调用协议

工具采用 OpenAI function calling 的标准形状：

```json
{
  "name": "app_anime_update",
  "arguments": { "title": "86 不存在的战区 part1", "category": "watched" }
}
```

- `arguments` 必须是 JSON 对象；空参数工具可传 `{}`。
- 工具名只接受小写字母、数字、下划线。
- 返回值是 JSON；失败时返回带错误码的文本（见第 5 节）。
- 一次只处理一部番。**批量任务**（「所有」「每一部」）不要逐部调用：告诉用户去侧栏
  「AI 分析 → 🏷 批量打标签」，那里支持并发、进度和一次成批写回。

## 3. 工具清单

### 3.1 `app_anime_list`（只读）

按分类 / 标签 / 关键词查询列表。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `category` | enum | 否 | `watching` / `wantToWatch` / `onHold` / `watched` / `dropped` |
| `tag` | string | 否 | 标签包含匹配 |
| `query` | string | 否 | 标题关键词 |
| `limit` | number | 否 | 默认 20，上限 100 |

返回：

```json
{
  "total": 198,
  "returned": 20,
  "items": [
    { "title": "86 不存在的战区 part1", "category": "watched", "categoryLabel": "看过",
      "overall": 8.96, "bangumiScore": 7.6, "watchDate": "2024-03-02", "tags": ["战争", "轻小说改"] }
  ]
}
```

### 3.2 `app_anime_get`（只读）

按**完整标题**读取一部番的详情。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | 是 | 必须与列表里的标题一致 |

返回 `title / category / categoryLabel / overall / scores / tags / studio / characters /
episodes / currentEpisode / bangumiScore / watchDate / notes / review`。

### 3.3 `app_tag_stats`（只读）

统计标签使用次数，用于发现长尾/孤儿标签（计数为 0 的预设标签不在工具内，需在侧栏标签编辑模式处理）。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `minCount` | number | 否 | 只返回次数 ≥ 该值的标签，默认 0 |
| `limit` | number | 否 | 默认 60，上限 200 |

返回 `{ total, returned, tags: [{ name, count }] }`，按次数降序。

### 3.4 `app_anime_update`（写）

只改传入的字段，其余保持不变。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | 是 | 完整标题 |
| `category` | enum | 否 | 新分类 |
| `notes` | string | 否 | 备注，≤ 2000 字 |
| `review` | string | 否 | 评价正文，≤ 2000 字 |
| `watchDate` | string | 否 | `YYYY-MM-DD` |
| `bangumiScore` | number | 否 | 0–10 |
| `currentEpisode` | number | 否 | 看到第几集，0 表示清空 |
| `scores` | object | 否 | 维度 key → 0–10；未知 key 会被丢弃 |

返回 `{ ok: true, title, changed: ["category", "scores"] }`；没有实际变化时 `changed` 为空。

### 3.5 `app_tag_add` / `app_tag_remove`（写）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | 是 | 完整标题 |
| `tags` | string[] | 是 | 最多 12 个；重复/同义（归一化后）自动跳过 |

返回 `{ ok: true, title, added: [...] }` 或 `{ ok: true, title, removed: [...] }`。
这两个工具只改**这一部**的标签，不动全局标签池。

### 3.6 `app_music_match`（只读）

把用户 QQ 音乐歌单里的曲目，按 QQ 音乐标的出处（`subtitle` 里的「《化物语》TV动画第10集片头曲」）
和库里的番名匹配。这是回答「歌单里哪些歌是我看过的番」唯一正确的入口 —— 一次扫全表。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `animeTitle` | string | 否 | 只看这一部；必须与列表标题一致 |
| `limit` | number | 否 | 默认 60，上限 200 |
| `onlyMatched` | boolean | 否 | 默认 true；false 时未匹配的曲目也会返回（`anime: null`） |

返回：

```json
{
  "playlist": { "title": "动漫", "count": 177 },
  "library": 168,
  "total": 177,
  "matched": 42,
  "returned": 42,
  "items": [
    { "mid": "003AGGTc2Hdyro", "name": "恋愛サーキュレーション", "singer": "花澤香菜",
      "subtitle": "《化物语》TV动画第10集片头曲", "duration": "4:15", "vip": true,
      "anime": "化物语", "matchedBy": "subtitle" }
  ]
}
```

`matchedBy` 说明依据：`subtitle`（出处，最可信）> `album` > `name`。
匹配只做「歌 → 番」的一对一归属，不判断这首歌是不是 OP（subtitle 里本来写着）。

### 3.7 `app_music_search`（只读）

按歌名/歌手搜 QQ 音乐，用来找歌单里没有的曲子。返回条数少（接口只给精确命中），不要指望翻页。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 歌名或歌手 |
| `limit` | number | 否 | 默认 8，上限 20 |

### 3.8 `app_music_bind`（写）

把歌单里的一首歌绑定到某部番的卡片上（就是卡片「音声」里看到的那份列表）。
写 `music-links.json`，**不动 Excel**；同一首重复绑定自动跳过。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `animeTitle` | string | 是 | 完整标题 |
| `mid` | string | 否 | 歌曲 songmid，推荐（来自 `app_music_match` 的结果） |
| `songName` | string | 否 | 没有 mid 时按歌名找；多首同名会报 `AMBIGUOUS` |

返回 `{ ok: true, anime, track: { mid, name, singer, ... } }`。

## 4. 权限与授权

当前档位来自「AI 设置 → 🛡 AI 写操作权限」：

| 档位 | 只读工具 | 写工具 | 写工具执行前 |
|---|---|---|---|
| `read` 只读 | ✅ | ❌ 不会注册 | — |
| `confirm` 提议后确认 | ✅ | ✅ | 弹窗列出参数，用户点「允许」 |
| `write` 直接写入 | ✅ | ✅ | 直接执行（仍有写前快照） |

行为约定：

- `read` 档下你**看不到**写工具，不要声称自己可以改数据；
- `confirm` 档下用户可能拒绝，拒绝后不要重试同一操作，改为说明或给出手动步骤；
- 无论哪档，写操作都留快照，用户可以在「存档与回退」里撤回。

## 5. 错误码

工具失败时返回的文本形如 `[NOT_FOUND] 列表里没有标题匹配「…」的条目`。

| 错误码 | 含义 | 建议动作 |
|---|---|---|
| `INVALID_ARGS` | 参数缺失或类型不对 | 修正参数后重试一次 |
| `NOT_FOUND` | 标题匹配不到 | 先用 `app_anime_list` 查准确标题 |
| `AMBIGUOUS` | 标题匹配到多部 | 改用完整标题，不要猜 |
| `FORBIDDEN` | 当前权限不允许 / 用户取消 | 不要重试；说明原因 |
| `WRITE_FAILED` | Excel 写入失败（文件被占用、标题快照不一致等） | 转述错误，让用户处理后再试 |

## 6. 硬约束

1. **先读后写**：不确定标题时先 `app_anime_list` / `app_anime_get`，不要凭记忆拼标题。
2. **单条操作**：不要在一轮里循环改几十部；批量请引导用户用专门入口。
3. **不编造数据**：所有统计、分数、排名必须来自工具结果。
4. **不改公式列**：D 列总评由应用重建，不要试图写它。
5. **评分范围**：0–10；维度 key 必须是当前模板里的 key，否则会被静默丢弃。
6. **标签归一化**：`科幻` 与 `科幻 ` 视为同一个；删除按归一化匹配。
7. **音乐绑定**：只能绑歌单里已有的曲目（优先传 `mid`）；写 `music-links.json`，不写 Excel。
8. **写失败要如实转述**：不要假装成功。

## 7. 典型流程

### 找出长尾标签

1. `app_tag_stats({ minCount: 1, limit: 30 })`
2. 把 `count` 为 1–2 的标签列给用户，说明哪些像人名/公司名/单场景词。
3. 不要直接删全局标签；删除只在单部上用 `app_tag_remove`，或让用户去侧栏标签管理。

### 给某部番改分类并补两个标签

1. `app_anime_get({ title: "…" })` 确认现状；
2. `app_anime_update({ title: "…", category: "watched" })`；
3. `app_tag_add({ title: "…", tags: ["战争", "轻小说改"] })`；
4. 汇报 `changed` / `added`，并提示可在「存档与回退」撤回。

### 标题有歧义

1. 返回 `AMBIGUOUS` 时，把候选标题原样列给用户；
2. 用户选定后再调用，不要自己挑一个。

### 按歌单给番配 OP/ED

1. `app_music_match({ limit: 200 })` 拿到「歌 → 番」全表；
2. 把 `matched` 数与前十几条按番名分组列给用户，顺便说明 `matchedBy` 的依据；
3. 用户点名要绑哪几首时，再用返回的 `mid` 调 `app_music_bind`（`confirm` 档会弹确认）；
4. 不要为了「补齐」逐首调用 `app_music_search`：歌单外的基本是翻唱/同人，绑了反而脏。

## 8. 扩展：HTTP / 插件接入

当前执行器跑在渲染进程（复用 `AnimeContext` 的写链路），工具定义与执行位置解耦。
将来接入主进程 / DSH / 插件时，保持同一套 `AppToolSpec`：

- 新增只读或写工具：在 `features/ai-analysis/app-tools.ts` 里加 `AppToolSpec` + 执行器；
- HTTP 形态（规划）：`GET /api/ai/tools` 列出定义，`POST /api/ai/tools/execute` 执行；
- 插件形态（规划）：`manifest.json` 声明 `contributions.tools`，由主进程加载器注册到同一张表。

**新增写工具时必须遵守**：

1. 声明 `effect: 'write'`，由 `createAppTools` / `canUseAppTool` 统一过滤；
2. 改 Excel 只能调用 `host.saveAnime`，不得新增第二条 Excel 写入路径；
   （音乐这类侧车数据走各自的 host 回调，如 `host.bindMusic`，同样只能有一条写入实现）
3. 在 `app-tools.test.ts` 里补「权限拒绝」和「成功写入」两类用例。
