/**
 * plugins/watch-analysis — 拉片分析插件入口
 *
 * 这是主应用唯一需要 import 的文件。它做三件事：
 *   1. 声明插件身份（id / title / version）
 *   2. 暴露 registerRoutes() 给 server/api-routes.ts 挂载
 *   3. 暴露 deps() 给设置页做依赖自检
 *
 * **边界**：主应用不知道插件内部有 Port、adapter、worker、store。
 * 将来要把这里换成一个 DSH 插件或独立服务，只需要保持这两个方法签名不变。
 *
 * 后续期数会在契约上继续加：
 *   tools(): AppToolRuntime[]    AI 工具（watch_overview / watch_zoom ...）
 *   tab(): ComponentType         番剧详情页的「拉片」Tab
 * 加的时候**不改已有方法**，只加可选字段 —— 这样 Phase 0 挂上的路由不会因为
 * Phase 1 加 UI 而重新编译失败。
 */
import { registerWatchRoutes } from './server/routes'
import type { WatchRoutesOptions } from './server/routes'
import { checkDependencies } from './server/deps'
import type { DependencyStatus } from './server/deps'

export type { WatchRoutesOptions }
export type { DependencyStatus }

/** 宿主环境：主应用注入，插件不自己去猜 DATA_DIR 在哪 */
export interface WatchPluginHost extends WatchRoutesOptions {}

interface RouterLike {
  use(prefix: string, handler: (req: any, res: any) => void): void
}

export interface WatchPlugin {
  readonly id: 'watch-analysis'
  readonly title: string
  readonly version: string
  /** 挂载 /api/watch/* */
  registerRoutes(router: RouterLike, host: WatchPluginHost): void
  /** 依赖自检（每次调用都重新探测，用户装完东西不用重启） */
  deps(): Promise<DependencyStatus[]>
}

export const watchAnalysisPlugin: WatchPlugin = {
  id: 'watch-analysis',
  title: '拉片分析',
  version: '0.1.0',

  registerRoutes(router, host) {
    registerWatchRoutes(router, host)
  },

  async deps() {
    return checkDependencies()
  },
}

// 数据模型与接口按需再导出：Phase 1 的 runtime/UI 会用到，
// 现在导出不增加成本，但能让未来的接入方不必深挖目录结构。
export * from './core/types'
export type * from './ports'
