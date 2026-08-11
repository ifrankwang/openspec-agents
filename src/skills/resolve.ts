import { readdirSync, readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { SKILL_SCAN_ROOTS } from "./scan.js"

export interface SkillTagIndex {
  tagMap: Map<string, string[]>
  skillTags: Map<string, string[]>
  /** skill 名 → frontmatter 声明的机器可读必做清单（must_do），未声明则无键。 */
  skillMustDo: Map<string, string[]>
}

let cacheKey: string | null = null
let cacheIndex: SkillTagIndex | null = null

/**
 * 扫描 skill 目录的 capabilities frontmatter，建立 tag → skill 名 与 skill 名 → tags 双向索引。
 * 进程内缓存：roots 不变时返回同一实例，roots 变化时重建。
 */
export function scanSkillTags(roots: string[] = SKILL_SCAN_ROOTS): SkillTagIndex {
  const key = roots.join("\u0000")
  if (cacheKey === key && cacheIndex) return cacheIndex
  const tagMap = new Map<string, string[]>()
  const skillTags = new Map<string, string[]>()
  const skillMustDo = new Map<string, string[]>()
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
        const m = raw.match(/capabilities:\s*\[([^\]]*)\]/)
        if (!m) continue
        const tags = m[1].split(",").map((s: string) => s.trim().replace(/["']/g, "")).filter(Boolean)
        skillTags.set(entry.name, tags)
        for (const tag of tags) {
          const arr = tagMap.get(tag) || []
          arr.push(entry.name)
          tagMap.set(tag, arr)
        }
        // 可选约定：must_do 必做清单（机器可读）。单行数组形态，与 capabilities 解析同机制；
        // 未声明的 skill 不参与必做清单覆盖度门禁（优雅降级，缺失不报错）。
        const mdo = raw.match(/must_do:\s*\[([^\]]*)\]/)
        if (mdo) {
          const items = mdo[1].split(",").map((s: string) => s.trim().replace(/["']/g, "")).filter(Boolean)
          if (items.length > 0) skillMustDo.set(entry.name, items)
        }
        seen.add(entry.name)
      } catch { /* skip unreadable */ }
    }
  }
  cacheKey = key
  cacheIndex = { tagMap, skillTags, skillMustDo }
  return cacheIndex
}

/**
 * 按 capability tag 语义匹配 skill：skill 含 tech-stack- 前缀 tag 归 techStackOnly，否则归 generic。
 * caps 为空/undefined 返回空。
 */
export function resolveSkillsForCapabilities(
  caps: string[] | undefined,
  index?: SkillTagIndex,
): { skillNames: string[]; techStackOnly: string[]; generic: string[] } {
  if (!caps || caps.length === 0) return { skillNames: [], techStackOnly: [], generic: [] }
  const idx = index ?? scanSkillTags()
  const { tagMap, skillTags } = idx
  const matched = new Set<string>()
  for (const cap of caps) {
    for (const n of tagMap.get(cap) || []) matched.add(n)
  }
  const skillNames: string[] = []
  const generic: string[] = []
  const techStackOnly: string[] = []
  for (const name of matched) {
    skillNames.push(name)
    const tags = skillTags.get(name) || []
    if (tags.some((t) => t.startsWith("tech-stack-"))) techStackOnly.push(name)
    else generic.push(name)
  }
  return { skillNames, techStackOnly, generic }
}

/** efficiency tag 命中的效率类 skill 名 */
export function getEfficiencySkills(index: SkillTagIndex = scanSkillTags()): string[] {
  return index.tagMap.get("efficiency") || []
}

/** 取 skill 声明的机器可读必做清单（must_do）；未声明返回 null（该 skill 不参与覆盖度门禁）。 */
export function getSkillMustDo(name: string, index: SkillTagIndex = scanSkillTags()): string[] | null {
  return index.skillMustDo.get(name) ?? null
}
