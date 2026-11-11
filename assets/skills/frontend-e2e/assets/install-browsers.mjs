import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

/**
 * 安装 Playwright 浏览器到官方默认缓存目录（macOS 为 ~/Library/Caches/ms-playwright）。
 *
 * 用默认位置而不是仓库内目录：浏览器体积大、与项目代码无关，装到仓库里既污染工作区
 * 又要进 gitignore；默认缓存跨项目复用，同一台机器只需装一次。
 * 额外参数透传给官方安装器（如 `npm run test:e2e:install -- firefox`）。
 */

const require = createRequire(import.meta.url)

/**
 * 解析 Playwright CLI 入口：不写死 node_modules 路径。
 * pnpm 严格布局下根 node_modules 只有直接依赖的软链，playwright 包未必可解析；
 * 交给 Node 按包名解析（@playwright/test/cli 是官方 exports 入口），三种布局通用。
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

const cli = resolvePlaywrightCli()

const args = process.argv.slice(2)
const result = spawnSync(
  process.execPath,
  [cli, 'install', ...(args.length ? args : ['chromium'])],
  { stdio: 'inherit' }
)

if (result.status !== 0) {
  console.error('[e2e] 浏览器安装失败')
  process.exit(result.status ?? 1)
}
console.log('[e2e] 浏览器已安装到 Playwright 默认缓存目录')
