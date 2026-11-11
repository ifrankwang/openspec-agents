import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveE2ePaths } from '../reporting/paths.mjs'

/**
 * 跨平台打开业务测试报告（reporting/business-reporter.mjs 生成）。
 *
 * 为什么不用 `npx playwright show-report`：那份命令只认 Playwright 自带报告，
 * 本 skill 的 HTML 是自定义两级业务报告；且 show-report 需要额外传目录，容易把用户
 * 引到「报告到底在哪」的反复试错上。路径统一由 reporting/paths.mjs 决定，
 * 与跑测试时一致，E2E_REPORT_DIR / E2E_API_MODE=real 也自动生效。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const mode = process.env.E2E_API_MODE === 'real' ? 'real' : 'mock'
const reportFile = path.join(resolveE2ePaths({ repoRoot, mode }).reportDir, 'index.html')

if (!existsSync(reportFile)) {
  console.error(`[e2e] 还没有报告：${reportFile}`)
  console.error('[e2e] 先跑一次 npm run test:e2e（真实后端为 E2E_API_MODE=real npm run test:e2e）')
  process.exit(1)
}

const command =
  process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
const args = process.platform === 'win32' ? ['/c', 'start', '', reportFile] : [reportFile]

// 打不开浏览器（无桌面环境 / 缺少 xdg-open）时只打印路径，不让脚本失败：
// 报告本身已经生成，用户可以复制路径到任何环境查看
const child = spawn(command, args, { stdio: 'ignore', detached: true })
child.on('error', () => {
  console.log(`[e2e] 报告已生成：${reportFile}`)
  console.log('[e2e] 自动打开失败，请手动在浏览器打开上述文件')
})
child.unref()
console.log(`[e2e] 正在打开报告：${reportFile}`)
