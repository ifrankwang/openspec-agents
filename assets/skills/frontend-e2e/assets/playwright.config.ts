import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * e2e 配置模板。按项目实际情况改标记 TODO 的地方即可。
 * 报告与产物都落在项目内 gitignore 目录：playwright-report/ 与 test-results/。
 *
 * 数据源由 E2E_API_MODE 切换：
 * - mock（默认）：dev server 以 E2E_API_MODE=mock 启动，应用加载项目自己的 MSW handlers；
 * - real：不启动 mock worker，请求经 dev server 代理打真实后端，用于联调与发版回归。
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.E2E_PORT || 5173) // TODO: 换成项目 dev server 默认端口
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`
const API_MODE = process.env.E2E_API_MODE === 'real' ? 'real' : 'mock'
const RESULT_DIR = process.env.E2E_RESULT_DIR || '../test-results'
const REPORT_DIR = process.env.E2E_REPORT_DIR || '../playwright-report'
const REPORTER_PATH = fileURLToPath(new URL('./reporting/reporter.mjs', import.meta.url))
const ABS_REPORT_DIR = fileURLToPath(new URL(REPORT_DIR, import.meta.url))

export default defineConfig({
  testDir: './specs',
  outputDir: RESULT_DIR,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    [REPORTER_PATH, { outputDir: ABS_REPORT_DIR, mode: API_MODE, baseURL: BASE_URL }]
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
  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : {
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
