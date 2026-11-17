import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import yaml from "js-yaml"
import { findSkillPath } from "../skills/scan.ts"
import { scanSkillTags, type SkillTagIndex } from "../skills/resolve.ts"
import { matchesSessionShapes, type SessionStacks } from "../skills/stacks.ts"
import { isSuppressionIntent, pathMatchesGlob, type ExemptionRecord } from "./exemptions.ts"

/**
 * 扫描配置忽略条目 ↔ 豁免记录的双向核对（数据驱动）。
 *
 * 抑制配置来源由 skill 资产声明（<skill 目录>/suppression-config.yaml），代码不感知技术栈、扫描平台
 * 或工具名：每条声明给出「配置文件 + 格式 + 键」，解析逻辑按 format 枚举实现。核对只在渲染期产出
 * 机器核对结论，不参与任何门禁判定——config_check 仍是必做项，其结果供该必做项的证据对照。
 */

export const SUPPRESSION_CONFIG_FILE = "suppression-config.yaml"

export type SuppressionConfigFormat = "properties-key-glob-list" | "glob-list"

/** skill 资产里的一条抑制配置来源声明。 */
export interface SuppressionConfigDeclaration {
  /** 配置文件路径（相对于项目根）。 */
  file: string
  /** 解析格式：properties 键值 glob 列表 / 整文件逐行 glob 列表。 */
  format: SuppressionConfigFormat
  /** format=properties-key-glob-list 时的键名。 */
  key?: string
}

/** 配置里实际解析出的一条忽略条目。 */
export interface SuppressionEntry {
  file: string
  pattern: string
  source: string
}

export interface SuppressionConsistency {
  /** 配置里有、豁免记录里无。 */
  unmatchedConfig: SuppressionEntry[]
  /** 豁免记录声明了配置抑制意图（path_pattern / rule_keys）、配置里无落点。 */
  unmatchedExemptions: ExemptionRecord[]
}

export interface CollectSuppressionOpts {
  /** skill 索引覆盖（测试注入；缺省扫描当前 skill 索引）。 */
  index?: SkillTagIndex
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "")
}

/** 解析 skill 的 suppression-config.yaml：只接受数组，逐项校验 file/format/key，非法项跳过。 */
export function parseSuppressionConfig(content: string): SuppressionConfigDeclaration[] {
  let raw: unknown
  try {
    raw = yaml.load(stripBom(content))
  } catch {
    return [] // 资产损坏按未声明处理，不阻断视图渲染
  }
  if (!Array.isArray(raw)) return []
  const out: SuppressionConfigDeclaration[] = []
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const file = typeof rec.file === "string" ? rec.file.trim() : ""
    if (file === "") continue
    if (rec.format === "glob-list") {
      out.push({ file, format: "glob-list" })
    } else if (rec.format === "properties-key-glob-list") {
      const key = typeof rec.key === "string" ? rec.key.trim() : ""
      if (key === "") continue
      out.push({ file, format: "properties-key-glob-list", key })
    }
  }
  return out
}

/** 逗号分隔的 glob 列表（去空白、去空项；`#` 开头的项视为注释）。 */
function splitGlobList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("#"))
}

/** 把 properties 的续行（行尾反斜杠）拼成逻辑行，再解析指定键；重复键按出现顺序合并。 */
export function parsePropertiesGlobList(content: string, key: string): string[] {
  const logical: string[] = []
  let buffer: string | null = null
  for (const rawLine of stripBom(content).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (buffer === null) {
      if (line === "" || line.startsWith("#") || line.startsWith("!")) continue
      buffer = line
    } else {
      buffer += line
    }
    if (buffer.endsWith("\\")) {
      buffer = buffer.slice(0, -1)
      continue
    }
    logical.push(buffer)
    buffer = null
  }
  if (buffer !== null && buffer !== "") logical.push(buffer)

  const out: string[] = []
  for (const line of logical) {
    const eq = line.indexOf("=")
    if (eq < 0) continue
    if (line.slice(0, eq).trim() !== key) continue
    out.push(...splitGlobList(line.slice(eq + 1)))
  }
  return out
}

/** 整文件逐行 glob 列表：忽略空行与 `#` 注释，其余行原样作为 glob。 */
export function parseGlobList(content: string): string[] {
  return stripBom(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

/** 配置条目 ↔ 豁免记录是否指向同一类路径（双向 glob 包含：配置更宽或豁免更宽都算对应）。 */
function entryMatchesExemption(entry: SuppressionEntry, record: ExemptionRecord): boolean {
  const recordPattern = record.pathPattern ?? ""
  if (recordPattern !== "") {
    if (recordPattern === entry.pattern) return true
    if (pathMatchesGlob(entry.pattern, recordPattern)) return true
    if (pathMatchesGlob(recordPattern, entry.pattern)) return true
  }
  const recordFile = record.file ?? ""
  return recordFile !== "" && pathMatchesGlob(entry.pattern, recordFile)
}

/**
 * 收集命中会话形态的 skill 声明的抑制配置条目：skill 资产 → 声明的配置文件 → 按 format 解析 glob。
 * 配置文件不存在（平台未落地该配置）时跳过，不报错；条目按 (file, pattern) 去重并标注来源。
 */
export function collectSuppressionEntries(
  repoRoot: string,
  session: SessionStacks | null,
  opts: CollectSuppressionOpts = {},
): SuppressionEntry[] {
  if (!session || session.project_stacks.length === 0) return []
  const index = opts.index ?? scanSkillTags()
  const seen = new Set<string>()
  const entries: SuppressionEntry[] = []

  for (const skill of [...index.skillTags.keys()].sort()) {
    if (!matchesSessionShapes(index.skillStacks.get(skill) ?? [], session)) continue
    const skillMd = findSkillPath(skill)
    if (!skillMd) continue
    const configPath = join(dirname(skillMd), SUPPRESSION_CONFIG_FILE)
    if (!existsSync(configPath)) continue

    let declarations: SuppressionConfigDeclaration[] = []
    try {
      declarations = parseSuppressionConfig(readFileSync(configPath, "utf-8"))
    } catch {
      continue // 不可读资产按未声明处理
    }

    for (const decl of declarations) {
      const target = join(repoRoot, decl.file)
      if (!existsSync(target)) continue
      let content: string
      try {
        content = readFileSync(target, "utf-8")
      } catch {
        continue // 不可读配置文件跳过，不阻断视图渲染
      }
      const patterns =
        decl.format === "properties-key-glob-list"
          ? parsePropertiesGlobList(content, decl.key ?? "")
          : parseGlobList(content)
      const source = `skill \`${skill}\` · ${decl.file}${decl.key ? `#${decl.key}` : ""}`
      for (const pattern of patterns) {
        const dedupeKey = `${decl.file}\u0000${pattern}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        entries.push({ file: decl.file, pattern, source })
      }
    }
  }

  return entries.sort((a, b) =>
    a.file === b.file ? a.pattern.localeCompare(b.pattern) : a.file.localeCompare(b.file),
  )
}

/** 双向核对：配置里的每条忽略要有对应豁免记录；声明配置抑制意图的豁免记录要有配置落点。 */
export function checkSuppressionConsistency(
  entries: SuppressionEntry[],
  exemptions: ExemptionRecord[],
): SuppressionConsistency {
  const intents = exemptions.filter(isSuppressionIntent)
  return {
    unmatchedConfig: entries.filter((entry) => !intents.some((record) => entryMatchesExemption(entry, record))),
    unmatchedExemptions: intents.filter((record) => !entries.some((entry) => entryMatchesExemption(entry, record))),
  }
}
