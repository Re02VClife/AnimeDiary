# Matt Pocock Skills — 简明使用指南

## 已安装概况

34 个技能已安装到你的项目中，按类别分为：

| 类别 | 路径 | 用途 |
|------|------|------|
| **工程类** (13个) | `.claude/skills/` | 日常编码工作流 |
| **生产力类** (4个) | `.claude/skills/` | 通用工作流工具 |
| **杂项** (4个) | `.claude/skills/` | 不常用的辅助工具 |
| **通用/实验** (13个) | `.claude/skills/` | 已弃用或实验性技能 |

## 文件结构

```
项目根目录/
├── .agents/skills/     ← 实际文件（universal 格式，适配多 AI agent）
│   ├── skill-name/
│   │   └── SKILL.md    ← 技能定义文件
│   └── ...
├── .claude/skills/     ← symlink 指向 .agents/skills/（Claude Code 专用）
│   ├── skill-name → ../../.agents/skills/skill-name
│   └── ...
```

## 使用方式

在 Claude Code 对话中直接输入 `/<skill名称>` 即可调用：

```
/grill-me          # 启动一次"盘问式"需求对齐
/tdd               # 进入测试驱动开发流程
/triage            # 对 issue 进行 triage
/improve-codebase-architecture  # 分析代码架构并生成改进报告
```

## 核心技能速查表

### ⭐ 最常用的 6 个技能

| 技能 | 类型 | 一句话说明 |
|------|------|-----------|
| `/grill-me` | 用户调用 | AI 对你进行拷问式提问，挖掘你没说清楚的需求 |
| `/grill-with-docs` | 用户调用 | 同上 + 自动建立项目术语表和架构文档 |
| `/tdd` | 模型自动 | 测试驱动开发：红→绿→重构循环 |
| `/to-prd` | 用户调用 | 把当前对话内容整理成 PRD 文档 |
| `/to-issues` | 用户调用 | 把计划拆成可独立执行的 issue |
| `/diagnosing-bugs` | 模型自动 | 系统化 debug 流程：复现→最小化→定位→修复→回归 |

### 🏗️ 工程类技能（完整列表）

| 技能 | 类型 | 说明 |
|------|------|------|
| `ask-matt` | 用户 | 不知道该用哪个技能？这个帮你选 |
| `grill-with-docs` | 用户 | 需求盘问 + 建立领域术语和ADR |
| `triage` | 用户 | Issue 状态机管理 |
| `improve-codebase-architecture` | 用户 | 代码架构体检，生成HTML报告 |
| `setup-matt-pocock-skills` | 用户 | **首次使用前必须运行**，配置 issue tracker 等 |
| `to-issues` | 用户 | 计划→独立 issue |
| `to-prd` | 用户 | 对话→PRD 文档 |
| `prototype` | 用户 | 快速原型（命令行/UI 两种模式） |
| `diagnosing-bugs` | 自动 | 系统化 debug |
| `tdd` | 自动 | 测试驱动开发 |
| `domain-modeling` | 自动 | 领域建模，维护CONTEXT.md |
| `codebase-design` | 自动 | 设计深层模块的规范和方法 |
| `implement` | 用户 | 实现技能 |

### 📋 生产力类技能

| 技能 | 类型 | 说明 |
|------|------|------|
| `grill-me` | 用户 | 拷问式需求对齐（不写文档版） |
| `handoff` | 用户 | 压缩当前对话为交接文档 |
| `teach` | 用户 | 多轮教学某概念 |
| `writing-great-skills` | 用户 | 教你写高质量 skill |
| `grilling` | 自动 | grill-me/grill-with-docs 背后的循环引擎 |

## 开始使用（首次配置）

**第一步**：运行配置向导
```
/setup-matt-pocock-skills
```
它会引导你设置：
1. **Issue 追踪器** — GitHub Issues / GitLab / 本地markdown
2. **Triage 标签名** — 5 个标准标签的对应名称
3. **领域文档布局** — 单仓库还是单体仓库

**第二步**：选一个场景开始
```
/grill-with-docs      # 有新需求时先运行这个，建立共识
/improve-codebase-architecture  # 每几天运行一次，保持代码健康
/tdd                  # 写新功能时用，保证质量
```

## 两种调用方式

- **用户调用** (`disable-model-invocation: true`)：必须你手动输入 `/技能名` 才会触发，负责编排工作流
- **模型自动** (无此标记)：AI 会在合适的时机自动调用，封装可复用的规范方法

## 推荐工作流

```
新需求来了 →
  /grill-with-docs   → 对齐需求 + 建立术语
  /to-issues          → 拆成独立 issue
  /triage             → 对 issue 进行优先级分类
  /tdd                → 逐个实现（AI 自动驱动）
  /diagnosing-bugs    → 出 bug 时系统化排查
  /improve-codebase-architecture → 定期体检
```

## 注意事项

- Skills 以完整 agent 权限运行，首次使用前请先 review 内容
- `setup-matt-pocock-skills` 每个仓库只需运行一次
- 配置文件在 `docs/agents/` 目录下，可手动编辑
