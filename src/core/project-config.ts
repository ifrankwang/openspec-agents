import { readFile, writeFile } from "node:fs/promises"
import { existsSync, readdirSync, readFileSync as readFileSyncNode } from "node:fs"
import { basename, dirname, join } from "node:path"
import { findSkillPath } from "../skills/scan.ts"
import { scanSkillTags, type SkillTagIndex } from "../skills/resolve.ts"
import { matchesSessionShapes, type SessionStacks } from "../skills/stacks.ts"
import type { ContainerInfo, ContainerProbeResult } from "./containers.ts"

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
  detectedVia: "runtime" | "compose"
}

export interface CollectProjectConfigOpts {
  /** skill 索引覆盖（测试注入；缺省扫描当前 skill 索引）。 */
  index?: SkillTagIndex
}

/** 目标文件的处理结果。 */
export interface ProjectConfigTargetReport {
  target: string
  action: "created" | "appended" | "complete"
  /** 本次实际追加的键（新建时为空）。 */
  addedKeys: string[]
  sources: string[]
  detectedVia: "runtime" | "compose"
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
 * - 命中判定 = 任一匹配词命中运行中容器的镜像名/容器名；运行时不可用时，改为 compose 文件
 *   文本包含该词（此时 detectedVia = "compose"）；
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
    let detectedVia: "runtime" | "compose" = "runtime"
    if (matchedWords.length === 0 && containers.runtime === null && containers.composeHits.length > 0) {
      matchedWords = words.filter((word) => {
        const pattern = globPattern(word)
        return containers.composeHits.some((text) => pattern.test(text))
      })
      detectedVia = "compose"
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
    const detectedVia: "runtime" | "compose" = group.some((a) => a.detectedVia === "compose")
      ? "compose"
      : "runtime"
    const filePath = join(repoRoot, target)

    let before: string | null = null
    try {
      before = await readFile(filePath, "utf-8")
    } catch {
      before = null
    }

    if (before === null) {
      const template = group.map((a) => renderProjectConfigTemplate(a.template, slug)).join("\n")
      const content = template.endsWith("\n") ? template : `${template}\n`
      if (!opts.dryRun) await writeFile(filePath, content, "utf-8")
      targets.push({ target, action: "created", addedKeys: [], sources, detectedVia })
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
      targets.push({ target, action: "complete", addedKeys: [], sources, detectedVia })
      continue
    }

    const eol = before.includes("\r\n") ? "\r\n" : "\n"
    const parts = [`${APPEND_COMMENT_PREFIX}${sources.join("、")}`, ...lines]
    const content = `${ensureTrailingEol(before, eol)}${parts.join(eol)}${eol}`
    if (!opts.dryRun) await writeFile(filePath, content, "utf-8")
    targets.push({ target, action: "appended", addedKeys, sources, detectedVia })
  }

  return { targets }
}

export type ProjectConfigSkipReason = "no-session" | "no-runtime" | "no-match"

/** 跳过原因的统一文案（挂在 init / set_worktree 返回体）。 */
export function renderProjectConfigSkip(reason: ProjectConfigSkipReason): string {
  const detail =
    reason === "no-session"
      ? "会话未记录项目栈，跳过。"
      : reason === "no-runtime"
        ? "未检测到容器运行时，跳过。"
        : "检测到容器但无匹配的平台，跳过。"
  return `- **${TARGET_LABEL}**: ${detail}`
}

/** 结构化报告 → markdown 片段。 */
export function renderProjectConfigReport(report: ProjectConfigReport): string[] {
  return report.targets.map((entry) => {
    const via = entry.detectedVia === "compose" ? "（按 compose 文件识别）" : ""
    const sources = entry.sources.join("、")
    if (entry.action === "created") {
      return `- **${TARGET_LABEL}**: 已创建 \`${entry.target}\`（来源：${sources}）${via}`
    }
    if (entry.action === "appended") {
      const keys = entry.addedKeys.join("、")
      return `- **${TARGET_LABEL}**: \`${entry.target}\` 已补齐 ${entry.addedKeys.length} 项：${keys}（来源：${sources}）${via}`
    }
    return `- **${TARGET_LABEL}**: \`${entry.target}\` 已存在且完整。`
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
  if (assets.length === 0) {
    const nothingDetected = probe.runtime === null && probe.composeHits.length === 0
    return renderProjectConfigSkip(nothingDetected ? "no-runtime" : "no-match")
  }
  const report = await ensureProjectConfigs(repoRoot, assets, opts)
  return renderProjectConfigReport(report).join("\n")
}
