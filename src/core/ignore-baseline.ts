import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { findSkillPath } from "../skills/scan.ts"
import { scanSkillTags, type SkillTagIndex } from "../skills/resolve.ts"
import { matchesSessionShapes, type SessionStacks } from "../skills/stacks.ts"

/**
 * 技术栈忽略基线资产收集。
 *
 * 基线资产全部是真实文件，按「谁产出谁声明」归属：
 * - 框架级通用基线：assets/ignore-baseline/ 下的文件，与项目形态无关，任何会话都生效；
 * - 能力级基线：skill 目录下的 ignore/ 子目录，仅当该 skill 声明的形态与会话 project_stacks
 *   有交集（形态维度命中）时生效——忽略条目由产出这些产物的能力声明，与具体框架无关。
 *
 * 目标文件名 = 资产文件名：ignore/ 与 ignore-baseline/ 下的文件按名字对应项目根同名文件，
 * 新增 `.dockerignore` 之类目标只需放资产文件，不需要改代码。
 */

export const IGNORE_BASELINE_DIR_NAME = "ignore-baseline"

/** 单个目标文件的一条基线条目，source 用于在报告里说明来源。 */
export interface IgnoreBaselineEntry {
  /** 资产文件中的原始行（已 trim，保留 `!` 否定前缀）。 */
  line: string
  /** 来源描述：`框架通用基线` 或 `skill \`<name>\``。 */
  source: string
}

/** 按目标文件名分组的基线条目。 */
export interface IgnoreTargetBaseline {
  target: string
  entries: IgnoreBaselineEntry[]
}

export interface CollectIgnoreBaselineOpts {
  /** skill 索引覆盖（测试注入；缺省扫描当前 skill 索引）。 */
  index?: SkillTagIndex
  /** 框架级基线目录覆盖（测试注入；缺省按模块位置上溯探测）。 */
  baselineRoot?: string | null
}

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * 定位随包分发的框架级基线目录。源码形态为仓库根 assets/ignore-baseline；插件包形态为
 * <插件根>/ignore-baseline 或 <插件根>/assets/ignore-baseline（与 resolveSkillScanRoot 同范式：
 * 部署深度不同，从模块所在目录逐级上溯探测，首中即用）。
 */
export function resolveIgnoreBaselineRoot(moduleUrl: string = import.meta.url): string | null {
  const startDir = dirname(fileURLToPath(moduleUrl))
  let dir = startDir
  for (;;) {
    for (const candidate of [
      resolve(dir, "assets", IGNORE_BASELINE_DIR_NAME),
      resolve(dir, IGNORE_BASELINE_DIR_NAME),
    ]) {
      if (existsSync(join(candidate, ".gitignore"))) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 兜底：源码形态下模块目录上溯可能先命中别的 assets/ignore-baseline，优先仓库根。
  const repoCandidate = join(moduleRoot, "assets", IGNORE_BASELINE_DIR_NAME)
  return existsSync(join(repoCandidate, ".gitignore")) ? repoCandidate : null
}

/**
 * 解析忽略资产文件：去注释与空行，其余行原样保留（含 `!` 否定行与通配）。
 * 注释行只服务资产可读性，不会写入目标文件。
 */
export function parseIgnoreAsset(content: string): string[] {
  return content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
}

/** 条目归一化键：用于跨来源去重与覆盖率判定（去尾部斜杠，保留 `!` 前缀）。 */
export function normalizeIgnoreLine(line: string): string {
  const trimmed = line.trim()
  const negated = trimmed.startsWith("!")
  const body = (negated ? trimmed.slice(1) : trimmed).replace(/\/+$/, "")
  return `${negated ? "!" : ""}${body}`
}

function readAssetLines(file: string): string[] {
  try {
    return parseIgnoreAsset(readFileSync(file, "utf-8"))
  } catch {
    return [] // 不可读资产按无条目处理，不阻断初始化
  }
}

function listAssetFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 收集「框架级基线（永远生效）+ 形态命中的 skill 的 ignore/ 资产」，按目标文件名分组去重。
 * session 为 null（旧会话未固化项目栈）时只返回框架级基线。
 */
export function collectIgnoreBaseline(
  session: SessionStacks | null,
  opts: CollectIgnoreBaselineOpts = {},
): IgnoreTargetBaseline[] {
  const groups = new Map<string, IgnoreBaselineEntry[]>()
  const seenByTarget = new Map<string, Set<string>>()

  const add = (target: string, line: string, source: string): void => {
    const key = normalizeIgnoreLine(line)
    if (key.length === 0) return
    const seen = seenByTarget.get(target) ?? new Set<string>()
    if (seen.has(key)) return
    seen.add(key)
    seenByTarget.set(target, seen)
    const entries = groups.get(target) ?? []
    entries.push({ line, source })
    groups.set(target, entries)
  }

  const baselineRoot =
    opts.baselineRoot === undefined ? resolveIgnoreBaselineRoot() : opts.baselineRoot
  if (baselineRoot) {
    for (const name of listAssetFiles(baselineRoot)) {
      for (const line of readAssetLines(join(baselineRoot, name))) add(name, line, "框架通用基线")
    }
  }

  if (session) {
    const index = opts.index ?? scanSkillTags()
    for (const skill of index.skillTags.keys()) {
      const stacks = index.skillStacks.get(skill) ?? []
      if (!matchesSessionShapes(stacks, session)) continue
      const skillMd = findSkillPath(skill)
      if (!skillMd) continue
      const ignoreDir = join(dirname(skillMd), "ignore")
      const source = `skill \`${skill}\``
      for (const name of listAssetFiles(ignoreDir)) {
        for (const line of readAssetLines(join(ignoreDir, name))) add(name, line, source)
      }
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([target, entries]) => ({ target, entries }))
}
