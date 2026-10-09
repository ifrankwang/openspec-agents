/**
 * 子代理定义投放：assets/agents/*.md 转成 OpenCode V2 原生 agent 文件，写入目标项目
 * `.opencode/agents/<名>.md`——V2 发现项目级 agent 的位置。
 *
 * V2 插件接口的 agent 编辑器只提供 update/remove，没有新增能力，而 V2 也不从插件包目录发现
 * agent，因此新增子代理只能走文件投放，与 codex 适配器把 agent 写进目标仓库 `.codex/agents/`
 * 的做法同构。
 *
 * frontmatter 按 V2 字段落地：mode/steps/hidden 沿用同名，permission 对象展开为 permissions
 * 有序数组（见 permissions.ts）。文件正文首行带生成标记：已存在且带标记的文件随插件版本刷新，
 * 用户手工改写过的同名文件保留不动。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as yaml from "js-yaml"
import { parseAgentMd, resolve } from "../agent-md.ts"
import { toV2Permissions } from "./permissions.ts"

const AGENTS_ROOT = resolve("assets", "agents")

/** 生成标记：正文首行。用于识别「本文件由插件生成、允许随版本刷新」。 */
const GENERATED_MARKER = "<!-- generated-by: openspec-agents -->"

/** 项目内 agent 投放目录（V2 发现位置）。 */
export function agentsTargetDir(projectRoot: string): string {
  return join(projectRoot, ".opencode", "agents")
}

/**
 * 把随包分发的子代理写入目标项目，返回本次实际写入的 agent 名列表。
 * assets/agents 缺失（分发形态裁剪）时返回空列表，不阻断插件启动。
 */
export function writeAgents(projectRoot: string): string[] {
  const written: string[] = []
  if (!existsSync(AGENTS_ROOT)) return written
  const targetDir = agentsTargetDir(projectRoot)
  for (const file of readdirSync(AGENTS_ROOT)) {
    if (!file.endsWith(".md")) continue
    const { frontmatter, body } = parseAgentMd(readFileSync(join(AGENTS_ROOT, file), "utf-8"))
    const name = (frontmatter.name as string) ?? file.replace(/\.md$/, "")
    if (!name) continue
    const target = join(targetDir, `${name}.md`)
    if (!isOverwritable(target)) continue
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(target, renderAgentFile(frontmatter, body), "utf-8")
    written.push(name)
  }
  return written
}

/** 未投放过、或上次由本插件生成的文件可覆盖；用户手工维护的文件一律保留。 */
function isOverwritable(target: string): boolean {
  if (!existsSync(target)) return true
  try {
    return readFileSync(target, "utf-8").includes(GENERATED_MARKER)
  } catch {
    return false
  }
}

function renderAgentFile(fm: Record<string, unknown>, body: string): string {
  const frontmatter: Record<string, unknown> = {}
  if (fm.description !== undefined) frontmatter.description = fm.description
  if (fm.mode !== undefined) frontmatter.mode = fm.mode
  if (fm.hidden !== undefined) frontmatter.hidden = fm.hidden
  const steps = (fm.steps ?? fm.maxSteps) as number | undefined
  if (steps !== undefined) frontmatter.steps = steps
  const permissions = toV2Permissions(fm.permission)
  if (permissions.length > 0) frontmatter.permissions = permissions
  return `---\n${yaml.dump(frontmatter)}---\n\n${GENERATED_MARKER}\n\n${body.trim()}\n`
}