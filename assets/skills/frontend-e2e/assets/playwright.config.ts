import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveE2ePaths } from './reporting/paths.mjs'

/**
 * e2e 配置模板。按项目实际情况改标记 TODO 的地方即可。
 *
 * 产物分两类，路径由 reporting/paths.mjs 决定，这里不再重复公式：
 * - 正式业务报告：项目内单一根目录 e2e/reports/playwright-report/（真实模式 .../real/），
 *   gitignore、Vite 不监听；报告生成时把每步截图复制进报告 assets/，HTML 自包含。
 * - 截图 / trace / video：系统临时目录 <tmp>/<项目目录名>-e2e/test-results-<端口>，
 *   按端口分目录，并行跑互不覆盖，系统定期清理。
 * 一次性验证要单独出报告时用 E2E_REPORT_DIR 指到 `$(mktemp -d)`，不要写进仓库。
 *
 * 数据源由 E2E_API_MODE 切换：
 * - mock（默认）：dev server 以 E2E_API_MODE=mock 启动，应用加载项目自己的 MSW handlers；
 * - real：不启动 mock worker，请求经 dev server 代理打真实后端，用于联调与发版回归。
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.E2E_PORT || 5173) // TODO: 换成项目 dev server 默认端口
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`
const API_MODE = process.env.E2E_API_MODE === 'real' ? 'real' : 'mock'
const { reportDir, resultDir } = resolveE2ePaths({ repoRoot, mode: API_MODE, port: PORT })
const REPORTER_PATH = fileURLToPath(new URL('./reporting/business-reporter.mjs', import.meta.url))
const E2E_GREP = process.env.E2E_GREP

export default defineConfig({
  testDir: './specs',
  // 明示只收集 .spec.ts：Playwright 默认也会跑 .test.ts，而编号预检与报告口径都只针对 spec
  testMatch: '**/*.spec.ts',
  outputDir: resultDir,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // E2E_GREP 让「只跑回归子集 / 受影响场景」不依赖记忆命令行参数，脚本可直接封装
  ...(E2E_GREP ? { grep: new RegExp(E2E_GREP) } : {}),
  reporter: [
    ['list'],
    [REPORTER_PATH, { outputDir: reportDir, mode: API_MODE, baseURL: BASE_URL }]
  ],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry'
  },
  ...(process.env.E2E_SKIP_WEBSERVER
    ? {}
    : {
        webServer: {
          // TODO: 换成项目自己的启动命令；端口走 E2E_PORT，方便并行跑时自动挑端口
          command: `npm run dev -- --port ${PORT} --strictPort`,
          url: BASE_URL,
          timeout: 120_000,
          // 复用既有服务时，须自行保证该服务以相同 E2E_API_MODE 启动，否则数据源与报告 mode 不一致
          reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
          // 关键：把数据源模式透传给 dev server；应用侧读同值环境变量决定是否启动 mock worker。
          // 透传缺失会让 mock 静默失效、请求打到真实后端（最常见的"mock 没生效"原因）。
          env: { E2E_API_MODE: API_MODE, VITE_API_MODE: API_MODE },
          stdout: 'pipe',
          stderr: 'pipe'
        }
      })
})
