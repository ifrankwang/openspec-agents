import { readFile, writeFile } from "node:fs/promises"
import { existsSync, readdirSync, readFileSync as readFileSyncNode } from "node:fs"
import { basename, dirname, join } from "node:path"
import { findSkillPath } from "../skills/scan.ts"
import { scanSkillTags, type SkillTagIndex } from "../skills/resolve.ts"
import { matchesSessionShapes, type SessionStacks } from "../skills/stacks.ts"
import { collectComposeTexts, type ContainerInfo, type ContainerProbeResult } from "./containers.ts"

/**
 * 项目级扫描平台配置基线。
 *
 * 资产契约（全部是真文件，代码里不出现任何平台的工具名或扫描器名）：
 * - `assets/skills/<skill>/project-config/container-match`：每行一个匹配词/glob，
 *   对比运行中容器的镜像名与容器名（大小写不敏感）；该文件存在才表示 skill 提供配置基线；
 * - 同目录其余文件：目标文件模板，目标文件名 = 资产文件名，`{{project.name}}` / `{{project.key}}`
 *   写入时插值，`#` 开头的行为配置文件注释并原样保留。
 *
 * 写入语义：目标不存在 → 按模板创建；已存在 → 只追加模板中缺失的键，绝不改已有行；
 * 只写工作树，不做任何 git 操作（不 add、不 commit）。
 */

export const PROJECT_CONFIG_DIR_NAME = "project-config"
export const CONTAINER_MATCH_FILE = "container-match"
const APPEND_COMMENT_PREFIX = "# 由编排初始化补齐："
const TARGET_LABEL = "扫描平台配置"

/** 命中来源：运行中容器 / compose 文件文本（运行时不可用）/ compose 文件文本（运行时可用但零匹配）。 */
export type ProjectConfigDetectedVia = "runtime" | "compose" | "compose-idle"

/** 单个 skill 提供的一个目标文件模板（同一目标可有多个 skill 来源，写入时合并条目）。 */
export interface ProjectConfigAsset {
  skill: string
  /** 目标文件名（相对项目根）。 */
  target: string
  /** 模板原文（注释与占位符保留）。 */
  template: string
  /** 命中的 container-match 词。 */
  matchedWords: string[]
  /** 命中来源：运行中容器或 compose 文件文本。 */
  detectedVia: ProjectConfigDetectedVia
}

export interface CollectProjectConfigOpts {
  /** skill 索引覆盖（测试注入；缺省扫描当前 skill 索引）。 */
  index?: SkillTagIndex
}

/** 同键不同值的冲突键（键名 + 涉及来源）。 */
export interface ProjectConfigConflict {
  key: string
  /** 冲突涉及的 skill（首值来源在前）。 */
  sources: string[]
}

/** 目标文件的处理结果。 */
export interface ProjectConfigTargetReport {
  target: string
  action: "created" | "appended" | "complete"
  /** 本次实际追加的键（新建时为空）。 */
  addedKeys: string[]
  sources: string[]
  detectedVia: ProjectConfigDetectedVia
  /** 同键不同值的冲突键；创建时以首个来源的值为准，绝不静默后写覆盖。 */
  conflicts: ProjectConfigConflict[]
}

export interface ProjectConfigReport {
  targets: ProjectConfigTargetReport[]
}

export interface EnsureProjectConfigsOpts {
  /** 只计算计划、不落盘。 */
  dryRun?: boolean
}

/** container-match 词是否命中任一运行中容器（镜像名/容器名，大小写不敏感，支持 glob）。 */
function matchWordAgainstContainers(word: string, containers: readonly ContainerInfo[]): boolean {
  const pattern = globPattern(word)
  return containers.some((c) => pattern.test(c.image) || pattern.test(c.name))
}

/**
 * 匹配词转正则：`*`/`?` 通配，其余字符按字面量；整体按「包含」语义匹配（前后补 `.*`），
 * 大小写不敏感——平台容器名与镜像名写法差异大（如带 registry 前缀或 `:version` 后缀）。
 */
function globPattern(word: string): RegExp {
  const escaped = word
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`(?:${escaped})`, "i")
}

function readLines(file: string): string[] {
  try {
    return readFileSyncNode(file, "utf-8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  } catch {
    return []
  }
}

function listFiles(dir: string): string[] {
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

function readTemplate(file: string): string | null {
  try {
    return readFileSyncNode(file, "utf-8").replace(/^\uFEFF/, "")
  } catch {
    return null
  }
}

/**
 * 收集形态命中且声明了 container-match 的 skill 的配置模板。
 *
 * - 只取 `matchesSessionShapes(skillStacks, session)` 命中的 skill（形态维度，与忽略基线一致）；
 * - 命中判定 = 任一匹配词命中运行中容器的镜像名/容器名；零匹配时再按 compose 文件文本包含
 *   该词回落（运行时不可用标 `compose`，运行时可用但容器未在运行标 `compose-idle`）；
 * - 旧会话（session 缺失或 project_stacks 为空）不补齐，返回空。
 */
export function collectProjectConfigAssets(
  session: SessionStacks | null,
  containers: ContainerProbeResult,
  opts: CollectProjectConfigOpts = {},
): ProjectConfigAsset[] {
  if (!session || session.project_stacks.length === 0) return []
  const index = opts.index ?? scanSkillTags()
  const assets: ProjectConfigAsset[] = []

  for (const skill of [...index.skillTags.keys()].sort()) {
    if (!matchesSessionShapes(index.skillStacks.get(skill) ?? [], session)) continue
    const skillMd = findSkillPath(skill)
    if (!skillMd) continue
    const configDir = join(dirname(skillMd), PROJECT_CONFIG_DIR_NAME)
    const words = readLines(join(configDir, CONTAINER_MATCH_FILE))
    if (words.length === 0) continue // 未声明 container-match = 该 skill 不提供配置基线

    let matchedWords = words.filter((word) => matchWordAgainstContainers(word, containers.containers))
    let detectedVia: ProjectConfigDetectedVia = "runtime"
    if (matchedWords.length === 0 && containers.composeHits.length > 0) {
      matchedWords = words.filter((word) => {
        const pattern = globPattern(word)
        return containers.composeHits.some((text) => pattern.test(text))
      })
      // 运行时可用但零匹配时，命中的是 compose 声明、容器并未在运行：来源要显式标注该差异。
      detectedVia = containers.runtime === null ? "compose" : "compose-idle"
    }
    if (matchedWords.length === 0) continue

    for (const name of listFiles(configDir)) {
      if (name === CONTAINER_MATCH_FILE) continue
      const template = readTemplate(join(configDir, name))
      if (template === null) continue
      assets.push({ skill, target: name, template, matchedWords, detectedVia })
    }
  }
  return assets
}

/** 仓库目录名 → 项目标识（小写、非字母数字折叠为 `-`、去首尾连字符）。 */
export function projectSlug(repoRoot: string): string {
  const raw = basename(repoRoot).toLowerCase()
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "project"
}

/** 模板插值：只替换两个约定占位符。 */
export function renderProjectConfigTemplate(template: string, slug: string): string {
  return template.replace(/\{\{project\.(name|key)\}\}/g, slug)
}

/** 已有配置文件的键集合（`name = value` 形态）。 */
export function parseConfigKeys(content: string): Set<string> {
  const keys = new Set<string>()
  for (const raw of content.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z0-9_.\-]+)\s*=/)
    if (m) keys.add(m[1])
  }
  return keys
}

/** 模板中缺失的键行（按模板顺序去重），注释与空行不参与追加。 */
export function missingTemplateLines(template: string, existingKeys: Set<string>): string[] {
  const missing: string[] = []
  const seen = new Set<string>()
  for (const raw of template.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z0-9_.\-]+)\s*=/)
    if (!m) continue
    const key = m[1]
    if (existingKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    missing.push(raw)
  }
  return missing
}

function ensureTrailingEol(content: string, eol: string): string {
  return content.length > 0 && !content.endsWith("\n") ? `${content}${eol}` : content
}

const CONFIG_KEY_LINE = /^\s*([A-Za-z0-9_.\-]+)\s*=\s*(.*)$/

/**
 * 多来源模板按键合并（创建分支）：以首个模板为基，后续模板只补缺失键。
 *
 * 同一目标被多个 skill 声明时（前后端同仓）不能直接拼接模板——拼接会产生重复键，
 * 而 properties 语义下后写覆盖前写，等于静默篡改前一个来源的值。这里统一按键合并：
 * 首值生效，同键不同值记入 conflicts（点名键名与来源），由报告显式披露。
 */
function mergeTemplatesByKey(
  group: readonly ProjectConfigAsset[],
  slug: string,
): { lines: string[]; conflicts: ProjectConfigConflict[] } {
  const baseLines = renderProjectConfigTemplate(group[0].template, slug).split(/\r?\n/)
  const values = new Map<string, { value: string; skill: string }>()
  for (const raw of baseLines) {
    const m = raw.match(CONFIG_KEY_LINE)
    if (!m || values.has(m[1])) continue
    values.set(m[1], { value: m[2].trim(), skill: group[0].skill })
  }

  const appended: string[] = []
  const conflicts: ProjectConfigConflict[] = []
  for (const asset of group.slice(1)) {
    const rendered = renderProjectConfigTemplate(asset.template, slug)
    for (const raw of rendered.split(/\r?\n/)) {
      const m = raw.match(CONFIG_KEY_LINE)
      if (!m) continue
      const key = m[1]
      const value = m[2].trim()
      const known = values.get(key)
      if (!known) {
        values.set(key, { value, skill: asset.skill })
        appended.push(raw)
        continue
      }
      if (known.value === value) continue
      const existing = conflicts.find((c) => c.key === key)
      if (existing) {
        if (!existing.sources.includes(asset.skill)) existing.sources.push(asset.skill)
      } else {
        conflicts.push({ key, sources: [known.skill, asset.skill] })
      }
    }
  }

  // 基模板尾部空行与追加行之间不留空行（保持原模板尾行紧接补齐键）。
  while (baseLines.length > 0 && baseLines[baseLines.length - 1].trim() === "") baseLines.pop()
  return { lines: [...baseLines, ...appended], conflicts }
}

/** 多来源命中来源合并：compose-idle（容器未在运行）信息量最高，优先披露。 */
function mergeDetectedVia(group: readonly ProjectConfigAsset[]): ProjectConfigDetectedVia {
  if (group.some((a) => a.detectedVia === "compose-idle")) return "compose-idle"
  if (group.some((a) => a.detectedVia === "compose")) return "compose"
  return "runtime"
}

/**
 * 按目标文件名合并多个 skill 的模板并补齐项目根配置。
 *
 * - 目标不存在：用（合并后的）模板插值创建；
 * - 已存在：逐行解析已有键，模板中的缺失键追加到文件末尾，前置一行来源注释（文件内已有该
 *   注释前缀则不重复写）；已有行的值一律不动；
 * - 只写工作树，不触碰 .git，不做任何 git 操作；dryRun 时只返回计划。
 */
export async function ensureProjectConfigs(
  repoRoot: string,
  assets: readonly ProjectConfigAsset[],
  opts: EnsureProjectConfigsOpts = {},
): Promise<ProjectConfigReport> {
  const groups = new Map<string, ProjectConfigAsset[]>()
  for (const asset of assets) {
    const list = groups.get(asset.target) ?? []
    list.push(asset)
    groups.set(asset.target, list)
  }

  const slug = projectSlug(repoRoot)
  const targets: ProjectConfigTargetReport[] = []

  for (const [target, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sources = [...new Set(group.map((a) => a.skill))].map((s) => `skill \`${s}\``)
    const detectedVia = mergeDetectedVia(group)
    // 模板间同键不同值的冲突与动作无关：文件已完整时也要报，避免「先创建后重跑」把冲突吞掉。
    const merged = mergeTemplatesByKey(group, slug)
    const filePath = join(repoRoot, target)

    let before: string | null = null
    try {
      before = await readFile(filePath, "utf-8")
    } catch {
      before = null
    }

    if (before === null) {
      const text = merged.lines.join("\n")
      const content = text.endsWith("\n") ? text : `${text}\n`
      if (!opts.dryRun) await writeFile(filePath, content, "utf-8")
      targets.push({
        target,
        action: "created",
        addedKeys: [],
        sources,
        detectedVia,
        conflicts: merged.conflicts,
      })
      continue
    }

    // 多来源模板合并：逐模板按已有键 + 本次已追加键去重，保证同名目标只出现一次。
    const existingKeys = parseConfigKeys(before)
    const addedKeys: string[] = []
    const lines: string[] = []
    for (const asset of group) {
      // 追加的键行同样要插值：模板里的 `{{project.key}}` 不能原样落盘。
      const rendered = renderProjectConfigTemplate(asset.template, slug)
      for (const line of missingTemplateLines(rendered, existingKeys)) {
        const key = line.match(/^\s*([A-Za-z0-9_.\-]+)/)?.[1]
        if (key && existingKeys.has(key)) continue
        if (key) {
          existingKeys.add(key)
          addedKeys.push(key)
        }
        lines.push(line)
      }
    }

    if (addedKeys.length === 0) {
      targets.push({ target, action: "complete", addedKeys: [], sources, detectedVia, conflicts: merged.conflicts })
      continue
    }

    const eol = before.includes("\r\n") ? "\r\n" : "\n"
    // 注释只在文件内尚无该前缀时写一次：连续多轮补齐不同键不能重复堆注释行。
    const parts = before.includes(APPEND_COMMENT_PREFIX)
      ? lines
      : [`${APPEND_COMMENT_PREFIX}${sources.join("、")}`, ...lines]
    const content = `${ensureTrailingEol(before, eol)}${parts.join(eol)}${eol}`
    if (!opts.dryRun) await writeFile(filePath, content, "utf-8")
    targets.push({ target, action: "appended", addedKeys, sources, detectedVia, conflicts: merged.conflicts })
  }

  return { targets }
}

export type ProjectConfigSkipReason = "no-session" | "no-runtime" | "no-containers" | "no-match"

/** 跳过原因的统一文案（挂在 init / set_worktree 返回体）。 */
export function renderProjectConfigSkip(reason: ProjectConfigSkipReason): string {
  const detail =
    reason === "no-session"
      ? "会话未记录项目栈，跳过。"
      : reason === "no-runtime"
        ? "未检测到容器运行时，跳过。"
        : reason === "no-containers"
          ? "容器运行时可用，但没有容器在运行，跳过。"
          : "检测到容器但无匹配的平台，跳过。"
  return `- **${TARGET_LABEL}**: ${detail}`
}

/** 结构化报告 → markdown 片段。 */
export function renderProjectConfigReport(report: ProjectConfigReport): string[] {
  return report.targets.map((entry) => {
    const via =
      entry.detectedVia === "compose-idle"
        ? "（按 compose 文件识别（容器未在运行））"
        : entry.detectedVia === "compose"
          ? "（按 compose 文件识别）"
          : ""
    const sources = entry.sources.join("、")
    const conflictNote =
      entry.conflicts.length === 0
        ? ""
        : `\n  - 冲突键（同键不同值，已保留首个来源的值）：${entry.conflicts
            .map((c) => `\`${c.key}\`（${c.sources.map((s) => `skill \`${s}\``).join(" vs ")}）`)
            .join("、")}`
    if (entry.action === "created") {
      return `- **${TARGET_LABEL}**: 已创建 \`${entry.target}\`（来源：${sources}）${via}${conflictNote}`
    }
    if (entry.action === "appended") {
      const keys = entry.addedKeys.join("、")
      return `- **${TARGET_LABEL}**: \`${entry.target}\` 已补齐 ${entry.addedKeys.length} 项：${keys}（来源：${sources}）${via}${conflictNote}`
    }
    return `- **${TARGET_LABEL}**: \`${entry.target}\` 已存在且完整。${conflictNote}`
  })
}

/**
 * 接线入口（init / set_worktree 共用）：会话栈 → 资产收集 → 写入 → 报告片段。
 * 不做容器探测（由调用方探测一次后传入），保证同一次初始化只探测一次。
 */
export async function ensureProjectConfigsForSession(
  repoRoot: string,
  session: SessionStacks | null,
  probe: ContainerProbeResult,
  opts: EnsureProjectConfigsOpts = {},
): Promise<string> {
  if (!session || session.project_stacks.length === 0) {
    return renderProjectConfigSkip("no-session")
  }
  const assets = collectProjectConfigAssets(session, probe)
  // 运行时可用但零匹配：compose 文本在运行时探测成功时不会被读取，这里再回落读一次；
  // 命中则照常补齐（来源标注容器未在运行），两处都失败才跳过。
  const resolved = assets.length === 0 && probe.runtime !== null
    ? collectProjectConfigAssets(session, { ...probe, composeHits: collectComposeTexts(repoRoot) })
    : assets
  if (resolved.length === 0) {
    if (probe.runtime === null && probe.composeHits.length === 0) {
      return renderProjectConfigSkip("no-runtime")
    }
    if (probe.runtime !== null && probe.containers.length === 0) {
      return renderProjectConfigSkip("no-containers")
    }
    return renderProjectConfigSkip("no-match")
  }
  const report = await ensureProjectConfigs(repoRoot, resolved, opts)
  return renderProjectConfigReport(report).join("\n")
}
