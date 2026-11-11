#!/usr/bin/env node
/**
 * 把 skill 自带模板拷进目标前端项目：
 *   node scripts/scaffold.mjs --target /path/to/frontend
 * 已存在的文件不覆盖（保护用户改动），只提示。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const skillRoot = path.resolve(here, '..')
const assets = path.join(skillRoot, 'assets')

const args = process.argv.slice(2)
const targetIndex = args.indexOf('--target')
const target = path.resolve(targetIndex >= 0 ? args[targetIndex + 1] : process.cwd())

// 目标路径按真实项目结构铺开：reporting/ 只放报告生成器与路径解析，
// scripts/ 放启动器与辅助脚本，support/ 放测试期能力，三者职责不混
const files = [
  ['reporter.mjs', 'e2e/reporting/business-reporter.mjs'],
  ['paths.mjs', 'e2e/reporting/paths.mjs'],
  ['paths.d.mts', 'e2e/reporting/paths.d.mts'],
  ['run-e2e.mjs', 'e2e/scripts/run-e2e.mjs'],
  ['open-report.mjs', 'e2e/scripts/open-report.mjs'],
  ['install-browsers.mjs', 'e2e/scripts/install-browsers.mjs'],
  ['check-case-ids.mjs', 'e2e/scripts/check-case-ids.mjs'],
  ['evidence.ts', 'e2e/support/evidence.ts'],
  ['http-trace.ts', 'e2e/support/http-trace.ts'],
  ['reporting.ts', 'e2e/support/reporting.ts'],
  ['test-fixture.ts', 'e2e/support/test.ts'],
  ['mock-from-real.mjs', 'e2e/support/mock-from-real.mjs'],
  ['playwright.config.ts', 'e2e/playwright.config.ts'],
  ['README-template.md', 'e2e/README.md']
]

// specs/ 与 fixtures/ 先建空目录：写用例和数据时直接落位，不再临时决定目录名
const directories = ['e2e/specs', 'e2e/fixtures']

let created = 0
let skipped = 0
for (const [from, to] of files) {
  const source = path.join(assets, from)
  const dest = path.join(target, to)
  if (!fs.existsSync(source)) {
    console.log(`缺少模板文件：${source}`)
    continue
  }
  if (fs.existsSync(dest)) {
    console.log(`跳过（已存在）：${to}`)
    skipped += 1
    continue
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(source, dest)
  console.log(`已写入：${to}`)
  created += 1
}

for (const directory of directories) {
  fs.mkdirSync(path.join(target, directory), { recursive: true })
}

console.log(`\n完成：新增 ${created} 个文件，跳过 ${skipped} 个。`)
console.log('下一步：')
console.log('1. 改 e2e/playwright.config.ts 里的 TODO（端口、启动命令）。数据源模式走 E2E_API_MODE，配置已透传给 dev server。')
console.log('2. package.json 加脚本：')
console.log('   "test:e2e": "node e2e/scripts/run-e2e.mjs"')
console.log('   "test:e2e:real": "E2E_API_MODE=real node e2e/scripts/run-e2e.mjs"')
console.log('   "test:e2e:regress": "E2E_GREP=@regress node e2e/scripts/run-e2e.mjs"')
console.log('   "test:e2e:report": "node e2e/scripts/open-report.mjs"')
console.log('   "test:e2e:install": "node e2e/scripts/install-browsers.mjs"')
console.log('3. .gitignore 加 e2e/reports/，并保留兜底项 test-results*/、playwright-report*/、blob-report/（防止从仓库根误跑时产物入库）。')
console.log('4. dev server 的 watch ignore 加 e2e/reports/，否则报告写入会触发无意义的整页刷新。')
console.log('5. 确认项目 src/mocks 下已有 MSW handlers 与浏览器启动入口：mock 模式复用这一份，不在 e2e 里另写拦截。新增或修改 mock 数据先按真实接口取数，用 e2e/support/mock-from-real.mjs 转成 fixture 与溯源记录。')
console.log('6. 在 e2e/specs/ 下按「scenario + step」写用例，编号唯一性由 e2e/scripts/check-case-ids.mjs 在启动时预检。')
