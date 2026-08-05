import type { TaskGroupState, OrchestrateState, TaskItem } from "./types.js"
import { derivePortFromNamespace } from "./namespace.js"
import { readFileSync } from "node:fs"
import { findSkillPath } from "../skills/scan.js"
import { scanSkillTags, resolveSkillsForCapabilities, getEfficiencySkills } from "../skills/resolve.js"

export function renderSkillSuggestions(agent: string, caps: string[]): string[] {
  if (caps.length === 0) return []
  const index = scanSkillTags()
  const { skillNames, generic, techStackOnly } = resolveSkillsForCapabilities(caps, index)

  const lines: string[] = []
  if (skillNames.length === 0) return lines

  lines.push("## Skill 加载清单", "")
  lines.push("必须加载（逐项用 Skill tool 加载，未找到时跳过）：", "")

  for (const name of generic) {
    lines.push(`- \`${name}\``)
  }
  lines.push("")
  if (techStackOnly.length > 0) {
    lines.push("仅当技术栈匹配时加载：", "")
    const byStack = new Map<string, string[]>()
    for (const name of techStackOnly) {
      const tags = index.skillTags.get(name) || []
      const stackTag = tags.find((t) => t.startsWith("tech-stack-"))
      if (!stackTag) continue
      const arr = byStack.get(stackTag) || []
      arr.push(name)
      byStack.set(stackTag, arr)
    }
    for (const names of byStack.values()) {
      for (const name of names) {
        lines.push(`- \`${name}\``)
      }
    }
    lines.push("")
  }
  lines.push("（其他 available_skills 中未列举的相关 skill，按需加载）")
  lines.push("")

  const hinted: string[] = []
  for (const name of skillNames) {
    const mdPath = findSkillPath(name)
    if (!mdPath) continue
    try {
      const raw = readFileSync(mdPath, "utf-8")
      if (!raw.includes("boundary_hints:")) continue
      const dm = raw.match(/directories:\s*\[([^\]]*)\]/)
      if (dm) for (const d of dm[1].split(",").map((s: string) => s.trim().replace(/["']/g, ""))) {
        hinted.push(`- \`${name}\` → \`${d}\``)
      }
    } catch { /* skip */ }
  }

  if (hinted.length > 0) {
    lines.push("## 路径提示（skill 声明的 boundary_hints）", "")
    lines.push("以下目录不受执行边界限制：", "")
    lines.push(...hinted)
    lines.push("")
  }

  return lines
}

export function renderEfficiencySteps(startNum: number): { lines: string[], nextNum: number } {
  const lines: string[] = []
  let n = startNum
  if (getEfficiencySkills().length > 0) {
    lines.push(`${n++}. 按已加载的效率 skill 中的工具可用性检测步骤确认代码探索工具就绪（含索引初始化）`)
    lines.push(`${n++}. 初始化仅是前置——本 session 后续所有代码探索操作须持续遵循已加载效率 skill 中的工具选择规则，不可将初始化视为终点而恢复默认工具习惯`)
    lines.push(`${n++}. 提交前自查：本 step 涉及的代码探索（符号定位/调用关系/影响评估）是否遵循已加载效率 skill 的工具选择规则，未遵循须补做`)
  }
  return { lines, nextNum: n }
}

/** worktree 就绪判定：taskGroup 投影的 worktreePath 非空即就绪（与 submit 硬门禁的 metadata.worktree_path 同源）。 */
export function isWorktreeReady(tg: TaskGroupState): boolean {
  return Boolean(tg.worktreePath)
}

/** 统一 worktree 未就绪提示文案（renderWorktreeSection / orchestrator 分派视图 / 子代理拒绝执行视图共用）。 */
export function renderWorktreeNotReady(): string[] {
  return ["- (worktree 未就绪 — 请编排者先调用 opx_orch_set_worktree)"]
}

export function renderWorktreeSection(
  state: OrchestrateState,
  tg: TaskGroupState,
  opts?: { showNamespace?: boolean; showPort?: boolean },
): string[] {
  const lines: string[] = []
  lines.push("## Worktree", "")
  if (tg.worktreePath) {
    lines.push(`- **路径**: \`${tg.worktreePath}\``)
    lines.push(`- **分支**: \`${tg.branchName || "(none)"}\``)
    if (tg.baseRef) lines.push(`- **变更范围**: 用 \`git -C ${tg.worktreePath} diff --name-only ${tg.baseRef}..HEAD\` 查询本 change 全部已提交变更文件`)
    lines.push("- **⚠️ 约束**: 所有读写和 git 操作均在此目录下进行；严禁直接修改主仓库/主分支路径下的文件（如 `<repo>/openspec/...`）")
    lines.push("- **路径解析**: 推荐阅读文档均为相对 worktree 路径的引用，一律以 worktree 路径为基准解析，禁止从主仓库根目录解析")
  } else {
    lines.push(...renderWorktreeNotReady())
  }
  if (opts?.showNamespace) {
    lines.push(`- **隔离标识**: \`${state.isolationNamespace}\``)
    if (opts?.showPort) {
      lines.push(`  - 建议端口: ${derivePortFromNamespace(state.isolationNamespace)}`)
    }
  }
  lines.push("")
  return lines
}

export function formatFilePath(file: string, line: number, maxLen = 60): string {
  const suffix = line > 0 ? `:${line}` : ""
  const full = `${file}${suffix}`
  if (full.length <= maxLen) return full
  const parts = file.split("/")
  if (parts.length <= 1) return full.slice(0, maxLen - 3) + "..."
  const base = parts[parts.length - 1]
  const parent = parts[parts.length - 2]
  const tryTwo = `.../${parent}/${base}${suffix}`
  if (tryTwo.length <= maxLen) return tryTwo
  const lastSeg = `${base}${suffix}`
  if (lastSeg.length <= maxLen) return lastSeg
  return lastSeg.slice(0, maxLen - 3) + "..."
}

export function renderTaskItem(t: TaskItem): string {
  const trace = t.specTrace ? ` [spec:${t.specTrace}]` : ""
  return `- Task id=${t.id} ｜ ${t.title}${trace}`
}

export function formatSeverity(severity: string): string {
  switch (severity) {
    case "Critical": return `**${severity}**`
    case "High": return `**${severity}**`
    case "Medium": return `*${severity}*`
    case "Low": return severity
    case "Info": return `\`${severity}\``
    default: return severity
  }
}

/** 上轮会话摘要渲染。参数为 agentSummaries 记录（workItems 单轨下直接读 item.metadata["agent_summaries"]）。
 *  按调用者角色隔离（409c411 意图）：只渲染当前 agent 自己的摘要，不跨 agent 传递。 */
export function renderAgentSummaries(agentSummaries: Record<string, string> | undefined, agentName: string): string[] {
  if (!agentSummaries || !agentSummaries[agentName]) return []
  const lines: string[] = ["## 上轮会话摘要", ""]
  lines.push(`- **${agentName}**：${agentSummaries[agentName]}`)
  lines.push("")
  return lines
}

// ─── 占位符插值层 ───

/** 插值白名单：仅这些 key 可被 {{key}} 占位符引用，其余一律保留原文（防配置注入任意动态值）。 */
const INTERPOLATION_ALLOWED_KEYS = new Set([
  "worktree_path",
  "change_id",
  "step_id",
  "phase",
  "agent",
  "allowed_directories",
  "allowed_packages",
  "notes",
])

/**
 * 占位符插值：将 text 中的 `{{key}}` 替换为 ctx[key]。
 * - key 不在白名单：保留原文（原样返回占位符）
 * - ctx 缺值：保留原文（降级，不抛错、不阻断渲染）
 */
export function interpolateText(text: string, ctx: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (raw, key: string) => {
    if (!INTERPOLATION_ALLOWED_KEYS.has(key)) return raw
    const value = ctx[key]
    return value === undefined ? raw : value
  })
}

