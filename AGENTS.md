# AGENTS.md

> 面向在本仓库工作的 AI 编码代理。取代旧 `CLAUDE.md`。
> 最后核对：2026-11-17 · v1.3.40。细节见 `README.md` / `HANDOVER.md` / `AI.md`。
> **注意：从 1.3.36 起热更新分发不了插件功能**（`plugins/` 和 `dsh-video-storyboard` 不在
> 热更新 zip 里），改了 `plugins/` 必须覆盖整个程序目录，见 `HANDOVER.md` §0.2。

## 项目

AnimeDiary — 本地优先的番剧评分管理桌面应用。主数据是用户自己的 Excel（`番评分.xlsx`），
应用只是它的界面；换一套模板也能管理其他作品。
React 18 + TypeScript + Ant Design 5 + ECharts 5 + Vite 6 + Electron 33，测试用 Vitest。
思考、回复与注释用简体中文。

## 命令

```bash
npm run dev:web    # 浏览器开发 http://localhost:5173
npm run dev        # Electron 桌面开发（渲染进程连 5173）
npm run typecheck  # tsc --noEmit
npm test           # Vitest
npm run build:api  # server/api-routes.ts -> .cjs（Electron 生产用）
npm run build      # 安装包；build:dir 为免安装目录
```

没有 linter，门禁 = `typecheck` + `test`。`build` / `update:pack` 会自动跑 `build:api`；
只手动 `vite build` 时，改过 `server/` 要单独跑。热更新顺序：`vite build` → `update:pack`，
`version` 必须变。

## 结构与数据流

```text
electron/   主进程、本地 API 服务、热更新
server/     /api 路由与网络/文件逻辑（dev 与生产共用）
plugins/    自包含插件：watch-analysis（拉片分析，Port/Adapter 分层，见下）
features/   业务模块：anime-data、ai-analysis、ranking、search-add、
            image-management、character-*、media-complete、watch-calendar、music 等
src/        组件、主题、类型、services；src/features/ 另有 bangumi-sync 等后加模块
context/    AnimeContext（useReducer 全局状态）
core/       纯函数（总评、数学、颜色、日期、语音片段、音乐链接解析）
tests/      Vitest；specs/ 旧需求快照；docs/ 截图
```

**`features/` 与 `src/features/` 并存**，新增模块按现有引用位置放。

**插件边界**：`plugins/watch-analysis/` 是自包含插件，主应用只在 `server/api-routes.ts`
接触它一处（`registerWatchRoutes` + 注入 `resolveLocalFile`）。插件内部
`core`（纯逻辑/类型）→ `ports`（六个可替换接口）← `adapters`（引擎实现）→ `runtime`（子进程/编排）
→ `server`（路由/落盘）→ `ui`，依赖方向严格单向、adapters 互不知晓。
换切镜/字幕/动感/配乐引擎 = 只加一个 adapter，pipeline 不动。
它的 worker 是独立 ESM 子进程（`runtime/worker.mjs`），因为 `dsh-video-storyboard` 是纯 ESM
而主进程是 CJS bundle，且解码一集会吃满 CPU。打包靠 `asarUnpack`（子进程读不到 asar 内文件）。
台词来源：同目录字幕文件优先（快且准）；没有字幕时可选 **MOSS 本地 ASR**
（`adapters/transcript-moss.mjs`，需 conda env + 1.7GB 权重，一集 24 分钟约 10 分钟）——
**默认不跑**，必须在面板上显式选「语音识别」。


```text
Excel ←→ /api/excel/* ←→ excel-service ←→ AnimeContext ←→ UI
localStorage / IndexedDB ←→ storage / template service ←→ UI
Bangumi / AniList / LLM ←→ server/* ←→ feature service ←→ UI
QQ 音乐 ←→ /api/music/* ←→ server/music-qq.ts ←→ core/music-links.ts ←→ features/music ←→ UI
本地番剧库 ←→ /api/local/* ←→ server/local-library.ts ←→ core/local-library.ts
          ←→ src/features/local-library/* ←→ 设置「本地」页 / 卡片播放键 / 选集播放器
```

- dev：`vite.config.ts` 的插件挂 `createApiHandler`，数据目录 = 仓库根。
- 生产：`electron/api-server.js` 用**同一份** handler 起 `127.0.0.1:51730`，数据目录 =
  `文档/AnimeDiary`（回退 `userData/AnimeDiary`）。
- 只走相对 `/api/*`；不要前端直接读文件，也不要写两套实现。
- `xlsx` 只在服务端用；前端用 `import * as XLSX from 'xlsx'`（已配 optimizeDeps）。
- 音乐绑定**不进 Excel**：`music-links.json`（`模板::标题` → 曲目）与 `music_cache.json`
  （歌单缓存 6h）都在 DATA_DIR；key 刻意不用 `entry.id`（=`excel-行号`，插行会串台）。
  VIP 曲子靠 `music-login.json`（y.qq.com 的登录 Cookie）：优先「一键登录」——
  `server/music-login-window.ts` 在生产里用 `require('electron')`（handler 跑在主进程）
  开一个独立 session 的登录窗，轮询该 session 的 `qm_keyst`/`uin`，拿到就落盘；
  dev（纯 Node）下抛 `LoginWindowUnavailable` → 路由 501 → 前端退回手动粘贴。
  没有登录态时 vkey 对会员曲一律返回 104003 —— 这是权限校验，不做绕过。
- 本地番剧库同理**不进 Excel**：`local-library.json`（存储地址 + 卡片绑定 + Bangumi 元数据缓存）
  在 DATA_DIR，key 与音乐共用 `animeKeyFor`（`模板::标题`）。
  识别靠目录名里的 Bangumi subject id（Kazumi 存成 `<id>_<来源站>/<集号>/video.mp4`），
  按 ID 查 `/v0/subjects/{id}`，不是猜名字；集数只按磁盘真实文件列，不按 Bangumi 总集数推算
  （实测 485 有 2..28、50331 有 14..21，都跟官方集数对不上）。
  播放走 `/api/local/stream`（支持 Range 206），**不要用 `file://`**：dev 页面在 http 下拿不到。

## 铁律

- **Excel 写入**：按 `excelRowIndex` + `expectedTitle` 定位（不匹配整批拒绝）；只写
  `EDITABLE_COLS`；原子写 + 写前快照。新增用 `appendAnimeEntry`，已有用 `updateAnimeEntry`。
- 公式列 C/D/J/U/Y 不写；D 列由 `rebuildOverallColumn` 专门重建。
- 不要写 `data:` URL 或 `cover-nobg.preview.*`（单元格上限 / 文件 404）。
- **总评唯一入口**：`core/overall.ts`。`core/math.ts` 的同名旧函数仅测试引用。
  `sortByDim === 'overall'` 时不能用 `rankByDimension()`。
- 模板存 `anime_diary_templates`，当前模板 `anime_diary_active_template`；
  `TEMPLATE_JSON` 是 **42/AQ**（19/T 是历史误用列，禁写）。
- 颜色只用 CSS 变量 `var(--xxx)`，变量在 `src/theme/presets.ts`。
- **排名唯一入口**：`features/ranking/ranking-service.ts`（Sidebar / Context / RadarChart 都走它）。
  `AnimeDetailModal.nearbyRanking` 是同模板邻邻口径，语义不同、别合并。
- **AI 写工具**：契约在 `core/app-tools.ts`，执行器在 `features/ai-analysis/app-tools.ts`。
  写工具必须标 `effect: 'write'`，且只能回调 `host.saveAnime`（即 `handleSaveAnime`），
  不得另开 Excel 写入路径；音乐绑定 `app_music_bind` 是侧车数据的例外，走 `host.bindMusic`
  写 `music-links.json`。给 AI 的操作手册在 `docs/AI-OPERATIONS.md`，新增工具要同步更新。

## 坑与验证

- Vite watch 已忽略 `electron/`、`server/`、`*.xlsx`、`images/`、`audio/`；别加回（EBUSY）。
- 雷达图 `symbol: 'none'` 是有意的。
- `api.bgm.tv` 在境内会被 DNS 污染（实测解析到 Facebook 的 `2a03:2880:...face:b00c` 与
  `128.242.240.61`），而 **Node 全局 fetch 不读系统代理** → 直连必然 `UND_ERR_CONNECT_TIMEOUT`。
  生产由 `net.fetch`（Chromium 栈）兜住；dev 模式走 `server/proxy-fetch.ts`
  （读环境变量 / Windows 注册表里的代理，HTTP CONNECT 隧道）。新加的服务端请求若在 dev 下需要出网，
  记得传 `fetchImpl` 或用它。
- 角色语音：B 站需 `buvid3`、WBI `w_rid`、`Referer`；依赖 ffmpeg；音频接口支持 Range 206；
  产物存 `audio/`，不进 Excel。
- QQ 音乐（全匿名只读）：歌单页 SSR **只内联前 10 首**，整份要走 `music.srfDissInfo.aiDissInfo`
  （100 首/页 + `hasmore`，带 subtitle 出处）；`musicu` 的搜索接口匿名返回空列表，只能用
  smartbox；vkey 对 **VIP 曲返回 104003**（无 purl）—— 不做绕过，前端引导跳转 QQ 音乐；
  免费曲的 m4a 有防盗链，必须服务端代挂 `Referer` 并透传 Range 206。
- UI 调试/截图不要弹可见窗口：优先离屏 Electron（`show:false` + `offscreen:true`；只隐藏窗口
  会停掉 rAF/CSS 动画，截到空白）或 CDP；`ELECTRON_RUN_AS_NODE=1` 时先清空。
- 开发时安装版占用单实例锁，用 `--user-data-dir` 隔离。
- 热更新只换前端；改 `electron/` 或依赖须重打安装包。

## 交付（每次改完必做）

不要只把改动留在工作区：`typecheck` + `test` 通过后，**必须**同时完成下面两件事。

**1. 提交并推 GitHub**（本机直连 github.com 会被 TLS 重置，必须走 Clash 代理 `127.0.0.1:7897`）：

```bash
git add -A
git commit -m "feat: 简述这次改动"
git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin master
```

**2. 打热更新包并推到桌面端更新源**（版本号必须变，否则应用认为已是最新、不会下载）：

```bash
node .review/bump-version.js <新版本号>   # 只是改 package.json 的 version；手改也一样
npx vite build                            # update:pack 不构建前端，必须先跑，否则打进去的是旧 dist
npm run update:pack                       # → release/web-update/AnimeDiary-web-<v>.zip + latest.json
Copy-Item release\web-update\*.zip E:\AnimeDiary-updates\ -Force
Copy-Item release\web-update\latest.json E:\AnimeDiary-updates\ -Force
```

桌面端要**启动两次**才生效：第一遍下载、第二遍才跑新版本；重启前先确认 `AnimeDiary` 进程数为 0，
否则单实例锁会让第二遍直接不启动（跑的还是第一遍的旧代码）。

> **热更新覆盖不到的改动一律要重打安装包**：`electron/`、`preload.js`、依赖、
> **以及 `plugins/`**（它要 `asarUnpack` 和 `dsh-video-storyboard`）。插件改动还必须
> **覆盖整个程序目录**并清掉旧前端缓存：
>
> ```bash
> npm run build
> Get-Process AnimeDiary | Stop-Process -Force
> robocopy release\win-unpacked E:\AnimeDiary /E
> Remove-Item "$env:APPDATA\anime-diary\web-update" -Recurse -Force   # 否则仍加载旧 dist
> ```
>
> 细节见 `HANDOVER.md` §0.2。

## 维护

改动后自检并更新本文，同步头部日期/版本：模块或目录变化、数据流或 Excel 约束变化、
文档与实际不符、命令/端口/版本变化。只写长期有效的约定，细节留给 README / HANDOVER / AI.md。
