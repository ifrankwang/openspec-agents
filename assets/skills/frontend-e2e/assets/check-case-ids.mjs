import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 用例编号唯一性检查：只扫描 `scenario(testInfo, { id: 'ORD-001', ... })` 实参里的编号，
 * 要求格式合法且唯一。
 *
 * 为什么只认 scenario() 实参：spec 里还有各类业务数据对象（如 `{ id: 'PRODUCT-1234' }`），
 * 按 `id:` 全文扫会把数据字段误当用例编号，一次误报就让整轮 e2e 跑不起来，报错还指向数据字段。
 *
 * 编号格式与 support/reporting.ts 的 scenario() 校验保持一致：2~4 位大写字母前缀 +
 * 横线 + 三位序号（如 ORD-001）。字面量编号格式不对时在预检拦下；变量编号
 * （`id: caseId`）不在预检范围，由 scenario() 在运行时校验。
 *
 * 检查口径：扫描 e2e/specs 下所有 .spec.ts（与 Playwright 配置的 testMatch 一致）。
 */

/** 合法编号：与 support/reporting.ts 的 scenario() 校验完全一致 */
const VALID_CASE_ID = /^[A-Z]{2,4}-\d{3}$/
/** scenario() 的第二参数（元信息对象）整体，支持多行写法 */
const SCENARIO_CALL = /\bscenario\s*\(\s*testInfo\s*,\s*\{([\s\S]*?)\}\s*\)/g
/** 元信息对象里的 id 字面量 */
const ID_LITERAL = /\bid:\s*['"]([^'"]+)['"]/

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const specsDir = path.resolve(here, '../specs')

/**
 * 扫描用例编号。
 * @returns {{ usages: Map<string, {file: string, line: number}[]>, invalid: {id: string, file: string, line: number}[] }}
 *   usages：合法编号 → 出现位置；invalid：scenario() 里格式不合法的编号字面量
 */
export function findCaseIdUsages() {
  const usages = new Map()
  const invalid = []
  const walk = dir => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      // specs 目录还没建（刚铺骨架 / 正在引入 e2e）时视为没有用例，不报错
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.spec.ts')) continue
      const text = fs.readFileSync(full, 'utf8')
      const lineOf = index => text.slice(0, index).split('\n').length
      for (const call of text.matchAll(SCENARIO_CALL)) {
        const idMatch = ID_LITERAL.exec(call[1])
        if (!idMatch) continue
        const id = idMatch[1]
        // 行号 = scenario( 起点 + 元信息对象起始位置 + id 在对象内的偏移；多行写法同样准确
        const metaStart = call.index + call[0].indexOf('{') + 1
        const place = {
          file: path.relative(repoRoot, full),
          line: lineOf(metaStart + idMatch.index)
        }
        if (!VALID_CASE_ID.test(id)) {
          invalid.push({ id, ...place })
          continue
        }
        if (!usages.has(id)) usages.set(id, [])
        usages.get(id).push(place)
      }
    }
  }
  walk(specsDir)
  return { usages, invalid }
}

/** 编号格式不合法或重复时打印位置并返回 false，供启动器直接中止 */
export function assertUniqueCaseIds() {
  const { usages, invalid } = findCaseIdUsages()
  let ok = true

  if (invalid.length > 0) {
    console.error('[e2e] 用例编号格式不合法（应为 2~4 位大写字母前缀 + 三位序号，如 ORD-001）：')
    for (const item of invalid) console.error(`  ${item.id}（${item.file}:${item.line}）`)
    ok = false
  }

  const duplicates = [...usages.entries()].filter(([, places]) => places.length > 1)
  if (duplicates.length > 0) {
    console.error('[e2e] 用例编号重复（报告里会出现同名条目，请给每条用例分配唯一编号）：')
    for (const [id, places] of duplicates) {
      console.error(`  ${id}`)
      for (const place of places) console.error(`    ${place.file}:${place.line}`)
    }
    ok = false
  }

  return ok
}

// 既能被 run-e2e.mjs import，也能单独执行（package.json 里挂一个 check 脚本）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(assertUniqueCaseIds() ? 0 : 1)
}
