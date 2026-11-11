import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveE2ePaths } from '../reporting/paths.mjs'
import { assertUniqueCaseIds } from './check-case-ids.mjs'

/**
 * e2e 启动器：校验用例编号 → 清过期痕迹 → 挑一个空闲端口 → 交给 Playwright。
 *
 * 为什么需要这一层：
 * - 端口隔离：多人/多领域并行跑时各用独立 dev server 端口。端口从「5173 + 进程号散列」起步，
 *   被占用就换端口重试（最多 3 次），避免两个进程同时探测到同一端口后互相踢掉 dev server。
 * - 痕迹隔离：截图 / trace / video 写系统临时目录并按端口分目录，并行运行互不覆盖；
 *   正式业务报告仍覆盖项目内单一报告根（见 reporting/paths.mjs）。
 * - 编号预检：编号重复的报告会出现同名条目，属于用例组织错误，先查一遍，重复直接中止，
 *   不浪费一次全量运行。
 *
 * 用法与直接调 Playwright 一致，参数透传：
 *   npm run test:e2e -- specs/orders
 *   E2E_API_MODE=real npm run test:e2e
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const require = createRequire(import.meta.url)

/**
 * 解析 Playwright CLI 入口。
 *
 * 不能写死 node_modules/playwright/cli.js：pnpm 的严格布局把依赖装在 .pnpm 下，
 * 根 node_modules 只放直接依赖的软链，playwright 包未必能从项目根解析到。
 * 按包名逐个尝试，由 Node 的解析规则负责穿越软链与嵌套布局：
 * - @playwright/test/cli：官方 exports 映射暴露的入口（解析到 cli.js）
 * - @playwright/test/cli.js：兼容没有 exports 字段的旧版本 / 简单布局
 * - playwright/cli.js：旧版本 / 未启用 exports 映射时的兜底
 */
function resolvePlaywrightCli() {
  for (const specifier of ['@playwright/test/cli', '@playwright/test/cli.js', 'playwright/cli.js']) {
    try {
      return require.resolve(specifier)
    } catch {
      /* 当前包名不可解析，继续试下一个 */
    }
  }
  console.error('[e2e] 找不到 Playwright，请先安装 @playwright/test（按项目包管理器安装，如 `pnpm add -D @playwright/test`）')
  process.exit(1)
}

const playwrightCli = resolvePlaywrightCli()
/** 端口起点：默认 5173 + 进程号散列，可用 E2E_PORT_START 或 E2E_PORT 显式指定 */
const basePort = Number(process.env.E2E_PORT_START || 5173 + (process.pid % 400))
const MODE = process.env.E2E_API_MODE === 'real' ? 'real' : 'mock'
const TEMP_ROOT = resolveE2ePaths({ repoRoot, mode: MODE }).tempRoot
const RESULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000

/** 清掉 3 天前遗留的痕迹目录：系统清理不及时，避免临时目录无限堆积 */
function cleanStaleResults() {
  let entries = []
  try {
    entries = fs.readdirSync(TEMP_ROOT, { withFileTypes: true })
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('test-results-')) continue
    const target = path.join(TEMP_ROOT, entry.name)
    try {
      if (now - fs.statSync(target).mtimeMs < RESULT_RETENTION_MS) continue
      fs.rmSync(target, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响本次运行 */
    }
  }
}

// 编号重复会让报告出现同名条目：先查一遍，重复就直接中止
if (!assertUniqueCaseIds()) process.exit(1)

cleanStaleResults()

function isFree(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function findFreePort(start) {
  for (let port = start; port < start + 60; port += 1) {
    if (await isFree(port)) return port
  }
  throw new Error(`[e2e] ${start} 起连续 60 个端口均被占用，无法启动 dev server`)
}

function runPlaywright(port) {
  const args = ['test', '--config=e2e/playwright.config.ts', ...process.argv.slice(2)]
  return new Promise(resolve => {
    const child = spawn(process.execPath, [playwrightCli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, E2E_PORT: String(port) }
    })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      process.stdout.write(chunk)
    })
    child.stderr.on('data', chunk => {
      output += chunk.toString()
      process.stderr.write(chunk)
    })
    child.on('exit', code => resolve({ code: code ?? 1, output }))
  })
}

let attempt = 0
while (attempt < 3) {
  const port = process.env.E2E_PORT
    ? Number(process.env.E2E_PORT)
    : await findFreePort(basePort + attempt * 11)
  // 显式打印痕迹目录：失败排查时用户不用猜截图在哪，也不用翻报告源码
  if (!process.env.E2E_RESULT_DIR) {
    // 路径由 paths.mjs 统一解析，不在这里手拼：端口变了痕迹目录跟着变
    const { resultDir } = resolveE2ePaths({ repoRoot, mode: MODE, port })
    console.log(`[e2e] 运行痕迹（截图/trace/video）：${resultDir}`)
  }
  const result = await runPlaywright(port)
  const portBusy = result.output.includes('is already used')
  if (portBusy && !process.env.E2E_PORT && attempt < 2) {
    console.error(`[e2e] 端口 ${port} 在启动瞬间被占用，换端口重试（第 ${attempt + 2} 次）`)
    attempt += 1
    continue
  }
  process.exit(result.code)
}
process.exit(1)
