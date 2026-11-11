import os from 'node:os'
import path from 'node:path'

/**
 * e2e 报告与运行痕迹的路径唯一实现。
 *
 * 为什么集中在一处：
 * - playwright.config.ts、scripts/run-e2e.mjs、reporting/business-reporter.mjs 三处都要知道
 *   「报告写哪里、痕迹写哪里」。各写一份公式必然漂移（报告、痕迹、gitignore、Vite watch
 *   各改一处）；这里返回绝对值，调用方只消费结果，不再拼路径。
 * - 正式业务报告是交付物，留在项目内单一根目录；截图 / trace / video 只服务失败排查，
 *   默认写系统临时目录，由操作系统定期清理，仓库不会被运行痕迹污染。
 *
 * 目录约定：
 * - 报告根：<repo>/e2e/reports/playwright-report/（real 模式加 real/ 子目录）
 * - 运行痕迹：<os.tmpdir()>/<仓库目录名 slug>-e2e/test-results-<端口>
 *   按端口分目录，同一台机器并行跑多份 e2e 时互不覆盖。
 *
 * 环境变量（都是显式覆盖，设置后不再叠加模式子目录）：
 * - E2E_REPORT_DIR：报告输出目录；相对路径按 e2e/ 解析，绝对路径原样使用。
 *   一次性验证出报告时指向 `$(mktemp -d)`，不要写进仓库。
 * - E2E_RESULT_DIR：痕迹输出目录；相对路径同样按 e2e/ 解析。
 *
 * 相对路径的基准是 e2e/ 而不是仓库根：配置里写 `reports/playwright-report` 比
 * `e2e/reports/playwright-report` 短，且与 README 里「相对 e2e/ 解析」的说法一致。
 * 绝对路径判断用 path.isAbsolute：在 Windows 上拿 new URL(值, import.meta.url) 解析
 * 盘符路径会被当成 URL scheme 抛错，不能用来做这件事。
 */

/** 仓库目录名转成 tmp 目录可用的 slug：保留字母数字与点/横线，其余压成单个横线 */
function repoSlug(repoRoot) {
  return (
    path
      .basename(repoRoot)
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app'
  )
}

/** 相对路径按 e2e/ 目录解析；绝对路径直接使用 */
function resolveFromE2e(e2eDir, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(e2eDir, value)
}

/**
 * 解析本次运行的全部产物路径。
 * @param {object} [options]
 * @param {string} [options.repoRoot] 仓库根目录，默认当前工作目录
 * @param {'mock' | 'real' | string} [options.mode] 数据源模式，real 时报告落到 real/ 子目录
 * @param {number} [options.port] dev server 端口，用于给痕迹目录分目录
 * @returns {{ tempRoot: string, reportDir: string, resultDir: string }} 三者均为绝对路径
 */
export function resolveE2ePaths({ repoRoot, mode = 'mock', port } = {}) {
  const root = path.resolve(repoRoot || process.cwd())
  const e2eDir = path.join(root, 'e2e')
  const tempRoot = path.join(os.tmpdir(), `${repoSlug(root)}-e2e`)
  const resolvedPort = Number(port ?? process.env.E2E_PORT ?? 5173)

  const reportOverride = process.env.E2E_REPORT_DIR
  const reportDir = reportOverride
    ? resolveFromE2e(e2eDir, reportOverride)
    : path.join(e2eDir, 'reports', 'playwright-report', ...(mode === 'real' ? ['real'] : []))

  const resultOverride = process.env.E2E_RESULT_DIR
  const resultDir = resultOverride
    ? resolveFromE2e(e2eDir, resultOverride)
    : path.join(tempRoot, `test-results-${resolvedPort}`)

  return { tempRoot, reportDir, resultDir }
}
