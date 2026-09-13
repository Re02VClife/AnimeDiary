# AnimeDiary — 番剧评分管理系统

> "记录你与每部番的相遇"

## 简介

AnimeDiary 是一款**番剧个人管理工具**，帮你记录看过的每一部番、对每个维度打分、追踪追番日历、分析看番口味。数据保存在本地的 Excel 文件中，同时支持一键备份和恢复。

本项目稍微修改一下也可以用于管理其他影视作品、文学作品、书画、游戏、论文等

> **注意**：AnimeDiary 可以联网访问 Bangumi / AniList 搜番，但评分数据始终在本地。

主界面

![主界面](image/READEME/1782305817003.png)

详情面板

![详情面板](image/READEME/1782305872695.png)

## 功能对照表

每一件事都对应一个入口：

- **番剧入库** — 搜索添加（支持 Bangumi / AniList 双源），支持分类和标签
- **多维度评分** — 8 个维度（音声 / 制作 / 作画 / 沉浸 / 剧情 / 人设 / 深度 / 电波），加权计算总评
- **排名系统** — 百分位排名 + 按维度排序筛选
- **雷达图** — 单番能力图 + 偏好画像对比
- **知识图谱** — 力导向图展示番剧 / 制作公司 / 标签 / 角色之间的关系
- **追番日历** — 按首刷时间排列的时间轴视图
- **AI 分析套件** — 6 个分析能力：
  - 品味报告 — 基于评分数据的口味分析
  - 偏好画像 — 输出你的看番偏好画像
  - 智能推荐 — 基于偏好推荐未看过的番
  - 单番分析 — 对一部番进行深度分析
  - 知识图谱优化 — AI 辅助完善关系网络
  - 自动打 Tag — 批量智能标签
- **海报管理** — AniList 搜索海报 + 本地存储 + Excel 持久化
- **图片管理** — 本地截图上传 / 删除 / 设为海报
- **Excel 双向同步** — 程序内修改自动写回 Excel，Excel 手动修改也可被程序读取
- **一键备份 / 恢复** — 导出 ZIP（含数据 + 图片），导入即可完整恢复

## 技术栈

| 层面      | 技术                                                |
| --------- | --------------------------------------------------- |
| 前端框架  | React 18 + TypeScript                               |
| UI 组件库 | Ant Design 5                                        |
| 图表      | ECharts 5                                           |
| 构建工具  | Vite 6                                              |
| 桌面壳    | Electron 33                                         |
| 数据存储  | Excel (.xlsx) + localStorage + IndexedDB            |
| 外部 API  | Bangumi、AniList、LLM（DeepSeek / OpenAI 兼容协议） |
| 测试框架  | Vitest + @testing-library/react                     |

## 架构

项目按**单点职责**分层，每个业务模块独立分管一块功能：

```
AnimeDiary/
├── core/                     (4 文件)  纯工具函数（数学/颜色/文本/日期）
├── features/                 (28 文件) 8 个业务模块
│   ├── ai-analysis/          (13 文件) AI 分析套件（6 个 Skill）
│   ├── anime-data/           (4 文件)  数据持久层
│   ├── anime-detail/         (1 文件)  ScoreSlider 评分滑块
│   ├── image-management/     (2 文件)  图片管理
│   ├── knowledge-graph/      (3 文件)  知识图谱
│   ├── ranking/              (1 文件)  排名服务
│   ├── search-add/           (1 文件)  搜索添加
│   └── watch-calendar/       (1 文件)  追番日历
├── context/                  (1 文件)  React Context + useReducer 全局状态
├── tests/                    (6 文件)  76 个单元 + 集成测试
├── specs/                    (7 文件)  功能需求文档
├── electron/                 (5 文件)  主进程 + 预加载 + 本地服务 + 热更新 + 数据初始化
├── server/                   (1 文件)  /api 路由（开发与打包后共用同一份实现）
└── src/                      (16 文件) 应用层（组件 + 页面 + 样式）
```

**数据流**：

```
Excel 文件 ←→ Vite API 中间件 ←→ excelService ←→ App State (Context) ←→ UI 组件
localStorage/IndexedDB ←→ storageService ←→ App State (Context) ←→ UI 组件
外部 API (Bangumi/AniList/LLM) ←→ 各 Service ←→ UI 组件
```

## 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装与启动

```bash
# 1. 克隆仓库
git clone <repo-url>
cd AnimeDiary

# 2. 安装依赖
npm install

# 3. 启动开发（纯 Web 模式，浏览器访问 http://localhost:5173）
npm run dev:web

# 4. 启动开发（Electron 桌面模式）
npm run dev
```

### 构建桌面应用（Windows 安装包）

```bash
npm run build          # 生成 release/AnimeDiary-Setup-<版本>.exe
npm run build:dir      # 只生成免安装目录（release/win-unpacked），便于本地验证
```

流程：`build:api`（把 `server/api-routes.ts` 编译成 Electron 可 require 的 cjs）→ `vite build` → `electron-builder`。

> 构建时若卡在下载 electron-builder 的二进制资源（GitHub 连不上），先设置镜像再执行：
>
> ```powershell
> $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
> ```
>
> 产物：`release/AnimeDiary-Setup-<版本>.exe`（安装版）+ `release/win-unpacked/`（免安装，双击 `AnimeDiary.exe` 即可运行）。

**数据位置**：安装版把数据放在「文档/AnimeDiary/」：

```
文档/AnimeDiary/
├── 番评分.xlsx     主数据（可直接用 Excel 打开编辑）
├── images/         海报与截图
└── backups/        多代快照（每次写 Excel 前自动留存，最多 10 份）
```

首次启动会自动创建带表头的空白 `番评分.xlsx`；已有数据可用面板上的「导入 Excel」导入。

**为什么打包后还能用**：开发时 `/api/*` 由 Vite 插件提供，打包后由 Electron 主进程起一个
只监听 `127.0.0.1` 的本地服务提供 —— 两者复用**同一份** `server/api-routes.ts`，
所以不存在"开发能跑、装上去打不开"的两套实现问题。

### 前端热更新

前端资源可以独立更新，**只改 React 代码/样式时不用重新安装**：

```bash
npm version patch      # 升版本号（不升的话客户端会认为没有更新）
npm run build          # 产出 dist/
npm run update:pack    # 产出 release/web-update/{AnimeDiary-web-<版本>.zip, latest.json}
```

把 `release/web-update/` 里的两个文件放到「更新源」目录即可，客户端启动后会自动检查并下载，
**重启后生效**（改到主进程或依赖时仍需重新发布安装包）。

更新源可以是**一个本地文件夹**，也可以是 HTTP 静态目录：

**方式一（最省事）：本地文件夹**
直接把 `AnimeDiary-web-<版本>.zip` 和 `latest.json` 放进任意文件夹（例如 `E:\AnimeDiary-updates`），
客户端配置里写这个路径即可 —— 不需要任何服务器。

**方式二：HTTP 静态目录**（自建服务 / 局域网共享 / 网盘直链）

```
<updateUrl>/latest.json
  { "version": "1.0.1", "url": "AnimeDiary-web-1.0.1.zip", "sha256": "...", "notes": "..." }
```

客户端配置存放在 `%APPDATA%/anime-diary/update-config.json`（目录名取自 package name，注意是 `anime-diary` 而不是 `AnimeDiary`）：

```json
{ "updateUrl": "E:\\AnimeDiary-updates", "autoCheck": true }
```

本地验证热更新（HTTP 方式）：

```bash
npm run update:serve   # 起本地更新源 http://127.0.0.1:8787/updates/
```

然后在应用侧栏的「桌面应用」里点「检查更新」。

### 运行测试

```bash
npm test              # 单次运行 76 个测试
npm run test:watch    # 监听模式
```

### 从浏览器版迁移本地设置

浏览器访问 `localhost:5173` 时，分类标记、自定义模板、海报焦点、AI 配置等都存在浏览器的
localStorage 里，与桌面版是**两套独立存储**。迁移步骤：

1. 启动开发服务器：`npm run dev:web`
2. 用**你平时访问该应用的那个浏览器**打开 <http://localhost:5173/api/_migrate-export>
3. 页面自动把本地数据交给服务端，在项目根目录生成 `browser-migration.json`
4. 把该文件复制到桌面版数据目录（`文档/AnimeDiary/`），重启桌面版 —— 会自动写入并改名成 `.applied`

> 该文件含 AI API Key 等敏感内容，已被 `.gitignore` 忽略；应用处理完会自动改名，确认无误后可删除。

## AI 功能配置

AI 分析功能需要配置 LLM 接口，支持 DeepSeek / OpenAI 兼容协议。

1. 打开程序后点击左下角 **AI 设置**
2. 填入 API Key、Base URL 和模型名称
3. 选择你想使用的 AI Skill

## License

MIT
