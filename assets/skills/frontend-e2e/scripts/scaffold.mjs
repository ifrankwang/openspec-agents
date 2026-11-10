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

const files = [
  ['reporter.mjs', 'e2e/reporting/reporter.mjs'],
  ['evidence.ts', 'e2e/support/evidence.ts'],
  ['http-trace.ts', 'e2e/support/http-trace.ts'],
  ['reporting.ts', 'e2e/support/reporting.ts'],
  ['test-fixture.ts', 'e2e/support/test.ts'],
  ['playwright.config.ts', 'e2e/playwright.config.ts'],
  ['mock-from-real.mjs', 'e2e/support/mock-from-real.mjs'],
  ['README-template.md', 'e2e/README.md']
]

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

fs.mkdirSync(path.join(target, 'e2e/specs'), { recursive: true })

console.log(`\n完成：新增 ${created} 个文件，跳过 ${skipped} 个。`)
console.log('下一步：')
console.log('1. 改 e2e/playwright.config.ts 里的 TODO（端口、启动命令）。数据源模式走 E2E_API_MODE，配置已透传给 dev server。')
console.log('2. 确认项目 src/mocks 下已有 MSW handlers 与浏览器启动入口：mock 模式复用这一份，不在 e2e 里另写拦截。新增或修改 mock 数据先按真实接口取数，用 e2e/support/mock-from-real.mjs 转成 fixture 与溯源记录。')
console.log('3. 在 e2e/specs/ 下按「scenario + step」写用例。')
console.log('4. package.json 加脚本："test:e2e": "playwright test -c e2e/playwright.config.ts"（配置在 e2e/ 下必须带 -c）。')
console.log('5. .gitignore 加 playwright-report/、test-results/、.playwright-browsers/。')
