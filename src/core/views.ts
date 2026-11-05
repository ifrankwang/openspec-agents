import type { TaskGroupState, OrchestrateState, TaskItem } from "./types.ts"
import { derivePortFromNamespace } from "./namespace.ts"
import { readFileSync } from "node:fs"
import { findSkillPath } from "../skills/scan.ts"
import { scanSkillTags, resolveSkillsForCapabilities } from "../skills/resolve.ts"
import type { SessionStacks } from "../skills/stacks.ts"
import { mustDoChecksOfStep, stepToken } from "./tools/gate.ts"

export function renderSkillSuggestions(agent: string, caps: string[], session?: SessionStacks | null): string[] {
  if (caps.length === 0) return []
  const index = scanSkillTags()
  const { skillNames } = resolveSkillsForCapabilities(caps, session, index)

  const lines: string[] = []
  if (skillNames.length === 0) return lines

  lines.push("## Skill 加载清单", "")
  lines.push("必须加载（逐项用 Skill tool 加载，未找到时跳过）：", "")

  for (const name of skillNames) {
    lines.push(`- \`${name}\``)
  }
  lines.push("")
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

/** worktree 就绪判定：taskGroup 投影的 worktreePath 非空即就绪（与 submit 硬门禁的 metadata.worktree_path 同源）。 */
export function isWorktreeReady(tg: TaskGroupState): boolean {
  return Boolean(tg.worktreePath)
}

/** 统一 worktree 未就绪提示文案（renderWorktreeSection / orchestrator 分派视图 / 子代理拒绝执行视图共用）。 */
export function renderWorktreeNotReady(): string[] {
  return ["- (worktree 未就绪 — 请编排者先调用 opx_orch_set_worktree)"]
}

/** 状态异常（phase ↔ step 归属错位）诊断行：subagent 拒绝视图与 orchestrator 分派视图共用。 */
export function renderStateMismatchDiagnostic(
  phase: string,
  currentStep: string | null,
  expectedPhase: string | null,
): string[] {
  return [
    `- **当前阶段 (phase)**: \`${phase}\``,
    `- **当前 step**: \`${currentStep ?? "(无)"}\``,
    `- **step 预期归属阶段**: \`${expectedPhase ?? "(未知)"}\``,
  ]
}

export function renderWorktreeSection(
  state: OrchestrateState,
  tg: TaskGroupState,
  opts?: { showNamespace?: boolean; showPort?: boolean },
): string[] {
  const lines: string[] = []
  lines.push("## Worktree", "")
  // 基准分支（change 会话）：worktree 分支的 fork 源与收口合并目标，可能在主仓库未检出的分支上
  if (state.kind !== "review") {
    lines.push(`- **基准分支**: \`${state.baseBranch}\``)
  }
  if (tg.worktreePath) {
    lines.push(`- **路径**: \`${tg.worktreePath}\``)
    lines.push(`- **分支**: \`${tg.branchName || "(none)"}\``)
    if (state.kind === "review") {
      // 独立审查会话：渲染「审查范围」锚点——pr 形态为 base..head 区间（base_ref 存 merge-base 锚点），
      // full 形态为全量代码库（base_ref 不设，不得渲染为「未检出变更」）
      if (state.reviewScope?.scopeType === "pr" && tg.baseRef) {
        lines.push(
          `- **审查范围**: PR 区间审查（${state.reviewScope.baseRef}..${state.reviewScope.headRef}）——` +
            `用 \`git -C ${tg.worktreePath} diff --name-only ${tg.baseRef}..HEAD\` 查询本区间已提交变更文件`,
        )
      } else {
        lines.push("- **审查范围**: 全量代码库审查（无区间界定，工具检查与审查覆盖整个代码库）")
      }
    } else if (tg.baseRef) {
      lines.push(`- **变更范围**: 用 \`git -C ${tg.worktreePath} diff --name-only ${tg.baseRef}..HEAD\` 查询本任务组的已提交变更文件`)
    }
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

/** 开发者必做项申报渲染（审查者的证据锚点）。数据源为 metadata.must_do_checks_by_step["implement"]
 *  （implement 提交参数 must_do_checks 的按 step 存档）：逐项渲染必做项、完成状态与证据/降级理由，
 *  reviewer 分级复验据此对照（低成本实跑证据核对、高成本项核验申报 + 抽样重放）。无存档时返回空数组
 *  （不渲染空区块）。
 *  与 renderAgentSummaries 的语义区分：会话摘要按角色隔离（辅助记忆，不跨 agent 传递）；必做项申报是
 *  正式提交参数的存档，跨角色可见是设计意图，不违反「子代理上下文不得转述」：该条约束的是编排者在
 *  分派 prompt 中转述动态上下文，视图渲染动态上下文本就是 opx_status 工具本职。 */
export function renderDevMustDoDeclaration(metadata: Record<string, unknown>): string[] {
  const checks = mustDoChecksOfStep(metadata, "implement")
  if (checks.length === 0) return []
  const lines: string[] = ["## 开发者必做项申报（implement）", ""]
  for (const c of checks) {
    const token = stepToken(c.step)
    if (c.completed) {
      const evidence = typeof c.evidence === "string" && c.evidence.trim() !== "" ? c.evidence.trim() : "(未附证据)"
      lines.push(`- **${token}**：已完成 — ${evidence}`)
    } else {
      lines.push(`- **${token}**：未完成 — 降级理由：${c.skip_reason ?? "(未申报)"}`)
    }
  }
  lines.push("")
  return lines
}

// ─── 部署注意点提取 ───

/** 从任务组 WorkItem 的 metadata.deployment_notes（implement 提交参数存档）提取实施补充点：
 *  规划文档未记载、开发者实施时申报的部署注意点；无命中返回空数组。逐条去除首尾空白，空条目忽略。 */
export function extractDeploymentNoteLines(metadata: Record<string, unknown>): string[] {
  const raw = metadata["deployment_notes"]
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (trimmed !== "") out.push(trimmed)
  }
  return out
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
  "base_branch",
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

