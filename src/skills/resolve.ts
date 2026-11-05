import { readdirSync, readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { effectiveSkillScanRoots, __setSkillScanRoots } from "./scan.ts"
import { matchesSessionStacks, type SessionStacks } from "./stacks.ts"

export interface SkillTagIndex {
  tagMap: Map<string, string[]>
  skillTags: Map<string, string[]>
  /** skill 名 → frontmatter 声明的形态标签（stacks），未声明则无键（视为通用形态，所有会话命中）。 */
  skillStacks: Map<string, string[]>
  /** skill 名 → frontmatter 声明的框架标签（frameworks），未声明则无键（视为通用框架，所有会话命中）。 */
  skillFrameworks: Map<string, string[]>
}

let cacheKey: string | null = null
let cacheIndex: SkillTagIndex | null = null

type FrontmatterListField = "capabilities" | "stacks" | "frameworks"

/**
 * 解析 frontmatter 中的单行数组字段（`field: ["a", "b"]`），各字段同风格；
 * 字段未声明返回 null（与「声明了空数组」同按未声明处理）。
 */
function parseFrontmatterList(raw: string, field: FrontmatterListField): string[] | null {
  const m = raw.match(new RegExp(`${field}:\\s*\\[([^\\]]*)\\]`))
  if (!m) return null
  return m[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean)
}

/**
 * 扫描 skill 目录的 frontmatter，建立 tag → skill 名 与 skill 名 → tags 双向索引，
 * 并分别索引 stacks（形态标签）、frameworks（框架标签）。
 * 默认 roots 取 effectiveSkillScanRoots()（生产含用户级目录，测试可经 __setSkillScanRoots 钉死）。
 * 进程内缓存：roots 不变时返回同一实例，roots 变化时重建。
 */
export function scanSkillTags(roots: string[] = effectiveSkillScanRoots()): SkillTagIndex {
  const key = roots.join("\u0000")
  if (cacheKey === key && cacheIndex) return cacheIndex
  const tagMap = new Map<string, string[]>()
  const skillTags = new Map<string, string[]>()
  const skillStacks = new Map<string, string[]>()
  const skillFrameworks = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (seen.has(entry.name)) continue
      const mdPath = resolve(root, entry.name, "SKILL.md")
      if (!existsSync(mdPath)) continue
      try {
        const raw = readFileSync(mdPath, "utf-8")
        const tags = parseFrontmatterList(raw, "capabilities")
        if (!tags) continue
        skillTags.set(entry.name, tags)
        for (const tag of tags) {
          const arr = tagMap.get(tag) || []
          arr.push(entry.name)
          tagMap.set(tag, arr)
        }
        // 可选约定：stacks（形态标签）/ frameworks（框架标签）。未声明 = 通用，所有会话命中；
        // 词汇表不维护在代码里，新形态/框架只需在 skill frontmatter 声明。
        const stacks = parseFrontmatterList(raw, "stacks")
        if (stacks && stacks.length > 0) skillStacks.set(entry.name, stacks)
        const frameworks = parseFrontmatterList(raw, "frameworks")
        if (frameworks && frameworks.length > 0) skillFrameworks.set(entry.name, frameworks)
        seen.add(entry.name)
      } catch { /* skip unreadable */ }
    }
  }
  cacheKey = key
  cacheIndex = { tagMap, skillTags, skillStacks, skillFrameworks }
  return cacheIndex
}

/**
 * 测试注入：把默认扫描根钉死并清空进程内索引缓存（与 __setKnownStackTags 同范式）。
 * 传 REPO_SKILL_SCAN_ROOTS 使用例与开发者 home 目录解耦；传 null 恢复生产默认。
 */
export function __setSkillScanRootsForTest(roots: string[] | null): void {
  __setSkillScanRoots(roots)
  cacheKey = null
  cacheIndex = null
}

/** 清空进程内索引缓存（测试复位用；roots 不变但目录内容变化时强制重扫）。 */
export function __resetSkillCache(): void {
  cacheKey = null
  cacheIndex = null
}

/**
 * 按 capability tag 语义匹配 skill，并按会话项目栈过滤（形态/框架字段命中规则见 stacks.ts）。
 * 返回过滤后的 skill 名清单（不按 tech-stack-* 前缀分组，过滤统一在解析层完成）。
 * session 三种取值：
 * - 传对象：按会话项目栈做交集过滤；
 * - 传 null：旧会话未固化项目栈（无 stacks）——只保留未声明 stacks/frameworks 的通用 skill，
 *   技术栈配套 skill 一律不列（避免升级在途会话被要求加载错误技术栈的 skill）；
 * - 不传（undefined）：无会话上下文（如 workflow 静态校验、单测），不过滤。
 * caps 为空/undefined 返回空。
 */
export function resolveSkillsForCapabilities(
  caps: string[] | undefined,
  session?: SessionStacks | null,
  index?: SkillTagIndex,
): { skillNames: string[] } {
  if (!caps || caps.length === 0) return { skillNames: [] }
  const idx = index ?? scanSkillTags()
  const { tagMap, skillStacks, skillFrameworks } = idx
  const matched = new Set<string>()
  for (const cap of caps) {
    for (const n of tagMap.get(cap) || []) matched.add(n)
  }
  const skillNames: string[] = []
  for (const name of matched) {
    const declaredStacks = skillStacks.get(name) ?? []
    const declaredFrameworks = skillFrameworks.get(name) ?? []
    if (session === null) {
      // 旧会话未固化项目栈：仅通用 skill（两通道均未声明）
      if (declaredStacks.length > 0 || declaredFrameworks.length > 0) continue
    } else if (session && !matchesSessionStacks(declaredStacks, declaredFrameworks, session)) continue
    skillNames.push(name)
  }
  return { skillNames }
}

