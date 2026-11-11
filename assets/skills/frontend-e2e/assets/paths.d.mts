/**
 * paths.mjs 的类型声明。
 *
 * 若项目启用 e2e 类型检查，其 tsconfig 的 moduleResolution 需为 Bundler，TS 才会从 .mjs
 * 匹配到 .d.mts 声明；否则 `import { resolveE2ePaths } from './reporting/paths.mjs'`
 * 会报找不到类型声明。
 */

export interface E2ePaths {
  /** 系统临时目录下的运行痕迹根目录（截图 / trace / video 的上级） */
  tempRoot: string
  /** 正式业务报告目录（绝对路径；real 模式已含 real/ 子目录） */
  reportDir: string
  /** 本次运行的运行痕迹目录（绝对路径） */
  resultDir: string
}

export interface ResolveE2ePathsOptions {
  /** 仓库根目录，默认 process.cwd() */
  repoRoot?: string
  /** 数据源模式，'real' 时报告落到 real/ 子目录 */
  mode?: 'mock' | 'real' | (string & {})
  /** dev server 端口，用于给痕迹目录按端口分目录 */
  port?: number
}

export function resolveE2ePaths(options?: ResolveE2ePathsOptions): E2ePaths
