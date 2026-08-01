import type { TaskGroupState, OrchestrateState, TaskItem, IssueItem, ReviewDimension, Dimension } from "./types.js"
import { REVIEW_DIMENSIONS } from "./types.js"
import { SEVERITY_LEVELS, DIMENSION_AGENT_MAP, MAX_RETRIES } from "./constants.js"
import { deriveStatus, isReviewCompleted, allTasksVerified, deriveCurrentAgents, isBlockingIssue, isStatusUnresolved } from "./derive.js"
import { derivePortFromNamespace } from "./namespace.js"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { findSkillPath, SKILL_SCAN_ROOTS } from "../skills/scan.js"

const AGENT_CAPABILITY_SUGGESTIONS: Record<string, string[]> = {
  "openspec-architect": ["efficiency", "architecture", "api-design", "db-design"],
  "openspec-developer": ["efficiency", "api-testing", "style", "maintainability", "performance"],
  "openspec-reviewer-tool": ["efficiency", "quality-gate"],
  "openspec-reviewer-task": ["efficiency", "api-testing"],
  "openspec-reviewer-architecture": ["efficiency", "tool-improvement", "architecture"],
  "openspec-reviewer-maintainability": ["efficiency", "tool-improvement", "maintainability"],
  "openspec-reviewer-performance": ["efficiency", "tool-improvement", "performance"],
  "openspec-reviewer-security": ["efficiency", "tool-improvement", "security"],
  "openspec-reviewer-style": ["efficiency", "tool-improvement", "api-design", "db-design", "style"],
}

function getToolImprovementSkills(agent: string): string[] {
  const caps = AGENT_CAPABILITY_SUGGESTIONS[agent]
  if (!caps || !caps.includes("tool-improvement")) return []
  const { tagMap } = scanSkills()
  return tagMap.get("tool-improvement") || []
}

function scanSkills(): { tagMap: Map<string, string[]>; skillTags: Map<string, string[]> } {
  const tagMap = new Map<string, string[]>()
  const skillTags = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const root of SKILL_SCAN_ROOTS) {
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
        seen.add(entry.name)
      } catch { /* skip unreadable */ }
    }
  }
  return { tagMap, skillTags }
}

function renderSkillSuggestions(agent: string, caps: string[]): string[] {
  if (caps.length === 0) return []
  const { tagMap, skillTags } = scanSkills()

  const matched = new Set<string>()
  for (const cap of caps) {
    for (const n of tagMap.get(cap) || []) matched.add(n)
  }

  const lines: string[] = []
  if (matched.size === 0) return lines

  lines.push("## Skill 加载清单", "")
  lines.push("必须加载（逐项用 Skill tool 加载，未找到时跳过）：", "")

  const generic: string[] = []
  const techStack = new Map<string, string[]>()

  for (const name of matched) {
    const tags = skillTags.get(name) || []
    const stackTag = tags.find(t => t.startsWith("tech-stack-"))
    if (stackTag) {
      const arr = techStack.get(stackTag) || []
      arr.push(name)
      techStack.set(stackTag, arr)
    } else {
      generic.push(name)
    }
  }

  for (const name of generic) {
    lines.push(`- \`${name}\``)
  }
  lines.push("")
  if (techStack.size > 0) {
    lines.push("仅当技术栈匹配时加载：", "")
    for (const [stack, names] of techStack) {
      for (const name of names) {
        lines.push(`- \`${name}\``)
      }
    }
    lines.push("")
  }
  lines.push("（其他 available_skills 中未列举的相关 skill，按需加载）")
  lines.push("")

  const hinted: string[] = []
  for (const name of matched) {
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

function renderEfficiencySteps(tagMap: Map<string, string[]>, startNum: number): { lines: string[], nextNum: number } {
  const lines: string[] = []
  let n = startNum
  if ((tagMap.get("efficiency") || []).length > 0) {
    lines.push(`${n++}. 按已加载的效率 skill 中的工具可用性检测步骤确认代码探索工具就绪（含索引初始化）`)
    lines.push(`${n++}. 初始化仅是前置——本 session 后续所有代码探索操作须持续遵循已加载效率 skill 中的工具选择规则，不可将初始化视为终点而恢复默认工具习惯`)
  }
  return { lines, nextNum: n }
}

function renderWorktreeSection(state: OrchestrateState, tg: TaskGroupState): string[] {
  const lines: string[] = []
  lines.push("## Worktree", "")
  if (tg.worktreePath) {
    lines.push(`- **路径**: \`${tg.worktreePath}\``)
    lines.push(`- **分支**: \`${tg.branchName || "(none)"}\``)
    if (tg.baseRef) lines.push(`- **变更范围**: 用 \`git -C ${tg.worktreePath} diff --name-only ${tg.baseRef}..HEAD\` 查询本 change 全部已提交变更文件`)
    lines.push("- **⚠️ 约束**: 所有读写和 git 操作均在此目录下进行")
  } else {
    lines.push("- (worktree 尚未设置)")
  }
  lines.push(`- **隔离标识**: \`${state.isolationNamespace}\``)
  lines.push(`  - 建议端口: ${derivePortFromNamespace(state.isolationNamespace)}`)
  lines.push("")
  return lines
}

function renderOptionalSection(lines: string[], title: string, content: string[]): void {
  if (content.length === 0) return
  lines.push(`## ${title}`, "")
  lines.push(...content)
  lines.push("")
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

export function taskSummary(tasks: TaskItem[]): Record<string, number> {
  const counts: Record<string, number> = { open: 0, submitted: 0, rejected: 0, verified: 0 }
  for (const t of tasks) counts[t.status]++
  return counts
}

export function issueSummary(issues: IssueItem[]): Record<string, number> {
  const counts: Record<string, number> = { open: 0, submitted: 0, rejected: 0, verified: 0, exemption_requested: 0, exempted: 0 }
  for (const i of issues) counts[i.status]++
  return counts
}

export function renderTaskItem(t: TaskItem): string {
  const trace = t.specTrace ? ` [spec:${t.specTrace}]` : ""
  return `- Task id=${t.id} ｜ ${t.title}${trace}`
}

export function sortIssuesByCategory(issues: IssueItem[]): IssueItem[] {
  const dimRank = (d: string) => {
    const idx = (REVIEW_DIMENSIONS as readonly string[]).indexOf(d)
    return idx === -1 ? REVIEW_DIMENSIONS.length : idx
  }
  const sevRank = (s: string) => {
    const idx = (SEVERITY_LEVELS as readonly string[]).indexOf(s)
    return idx === -1 ? SEVERITY_LEVELS.length : idx
  }
  return [...issues].sort((a, b) => dimRank(a.dimension) - dimRank(b.dimension) || sevRank(a.severity) - sevRank(b.severity))
}

function formatSeverity(severity: string): string {
  switch (severity) {
    case "Critical": return `**${severity}**`
    case "High": return `**${severity}**`
    case "Medium": return `*${severity}*`
    case "Low": return severity
    case "Info": return `\`${severity}\``
    default: return severity
  }
}

export function renderIssueItem(i: IssueItem): string {
  const lines: string[] = []
  lines.push(`- Issue #${i.id} | ${formatSeverity(i.severity)} | ${i.dimension} | [${i.sourcePhase}]`)
  lines.push(`  - 文件：${formatFilePath(i.file, i.line)}`)
  lines.push(`  - 描述：${i.description}`)
  if (i.suggestion) lines.push(`  - 建议：${i.suggestion}`)
  if (i.status === "exemption_requested" && i.exemptReason) lines.push(`  - 豁免理由：${i.exemptReason}`)
  if (i.status === "rejected" && i.rejectReason) lines.push(`  - 驳回原因：${i.rejectReason}`)
  lines.push(`  - 修复未过次数：${i.refixCount}`)
  return lines.join("\n")
}

export function renderLayerIssues(
  issues: IssueItem[],
  sourcePhase: string,
  dimension?: string,
): string[] {
  const lines: string[] = []

  let filtered = issues.filter((i) => i.sourcePhase === sourcePhase)
  if (dimension) filtered = filtered.filter((i) => i.dimension === dimension)

  const submitted = sortIssuesByCategory(filtered.filter((i) => i.status === "submitted"))
  const exemptionRequested = sortIssuesByCategory(filtered.filter((i) => i.status === "exemption_requested"))

  if (submitted.length === 0 && exemptionRequested.length === 0) {
    return []
  }

  if (submitted.length > 0) {
    lines.push("### 待确认", "")
    lines.push(
      "> 待确认核验：逐条核验上述「待确认」issue 是否真已修复——已修复列入 fixed_issue_ids；未达标则不列入，工具将自动回退为 rejected 交 developer 重修。",
      ""
    )
    for (const i of submitted) lines.push(renderIssueItem(i))
    lines.push("")
  }

  if (exemptionRequested.length > 0) {
    lines.push("### 豁免裁定中", "")
    for (const i of exemptionRequested) lines.push(renderIssueItem(i))
    lines.push("")
  }

  return lines
}

export function renderOrchestratorView(state: OrchestrateState, tg: TaskGroupState, diskWorktrees?: { branch: string; path: string }[]): string {
  const ts = taskSummary(tg.tasks)
  const is = issueSummary(tg.issues)
  const lines: string[] = []
  lines.push("# 编排进度", "")
  lines.push(`**变更**: ${state.changeId}`)
  lines.push(`**基准分支**: ${state.baseBranch}`)
  lines.push(`**当前阶段**: ${tg.status}`, "")
  lines.push("## 阶段进展", "")
  lines.push("| 阶段 | 状态 |")
  lines.push("|------|------|")
  const phaseSummary = (name: string, p: { completed: boolean }) => p.completed ? "✓" : (tg.status === name ? "●" : "✗")
  lines.push(`| task_analysis | ${phaseSummary("task_analysis", tg.phases.architect_review)} |`)
  const devStatus = (tg.status === "review" || tg.status === "completed") ? "✓" : (tg.status === "dev_impl" ? "●" : "✗")
  lines.push(`| dev_impl | ${devStatus} |`)
  const reviewParts: string[] = []
  if (tg.phases.review.tool.completed) reviewParts.push("tool✓")
  if (tg.phases.review.task.completed && !tg.phases.review.tool.completed && allTasksVerified(tg.tasks)) {
    reviewParts.push("task(跳过)")
  } else if (tg.phases.review.task.completed) {
    reviewParts.push("task✓")
  }
  const allQualityPassed = REVIEW_DIMENSIONS.every(d => tg.phases.review.quality.progress[d] === "passed")
  if (allQualityPassed) reviewParts.push("quality✓")
  if (!tg.phases.review.tool.completed) reviewParts.push("tool⏳")
  else if (!tg.phases.review.task.completed) reviewParts.push("task⏳")
  else if (!allQualityPassed) reviewParts.push("quality⏳")
  const reviewLayer = reviewParts.join(" → ")
  const reviewStatus = isReviewCompleted(tg) ? "✓" : (tg.status === "review" ? `● ${reviewLayer}` : "✗")
  lines.push(`| review | ${reviewStatus} |`)
  lines.push("")
  const blockerLines: string[] = []
  for (const blocker of tg.blockers) {
    blockerLines.push(`- Blocker #${blocker.id} | ${blocker.status} | ${blocker.category}`)
    blockerLines.push(`  - 来源：${blocker.sourceRole}${blocker.taskId ? `；Task #${blocker.taskId}` : ""}`)
    blockerLines.push(`  - 描述：${blocker.description}`)
    if (blocker.userResponse) blockerLines.push(`  - 用户答复：${blocker.userResponse}`)
    if (blocker.architectConclusion) blockerLines.push(`  - 架构结论：${blocker.architectConclusion}`)
  }
  renderOptionalSection(lines, "Blocker", blockerLines)
  lines.push("## Task 摘要", "")
  lines.push(`| 状态 | 数量 |`)
  lines.push(`|------|------|`)
  lines.push(`| open | ${ts.open} |`)
  lines.push(`| submitted | ${ts.submitted} |`)
  lines.push(`| rejected | ${ts.rejected} |`)
  lines.push(`| verified | ${ts.verified} |`)
  lines.push("")
  lines.push("## Issue 摘要", "")
  lines.push(`| 状态 | 数量 |`)
  lines.push(`|------|------|`)
  lines.push(`| open | ${is.open} |`)
  lines.push(`| submitted | ${is.submitted} |`)
  lines.push(`| rejected | ${is.rejected} |`)
  lines.push(`| verified | ${is.verified} |`)
  lines.push(`| exemption_requested | ${is.exemption_requested} |`)
  lines.push(`| exempted | ${is.exempted} |`)
  lines.push("")
  lines.push("## 审核进度", "")
  const rp = tg.phases.review.quality.progress
  const fmt = (k: ReviewDimension) => `${k}=${rp[k]}`
  lines.push(`| 维度 | 状态 |`)
  lines.push(`|------|------|`)
  for (const dim of ["style", "architecture", "performance", "security", "maintainability"] as const) {
    lines.push(`| ${dim} | ${fmt(dim)} |`)
  }
  if (diskWorktrees && diskWorktrees.length > 0) {
    const stateBranches = new Set(state.taskGroups.filter((g) => g.branchName).map((g) => g.branchName!))
    const unregistered = diskWorktrees.filter((w) => !stateBranches.has(w.branch))
    lines.push("")
    lines.push("## 磁盘 Worktree", "")
    lines.push("| 分支 | 路径 | 状态 |")
    lines.push("|------|------|------|")
    for (const w of diskWorktrees) {
      const registered = stateBranches.has(w.branch)
      const existingTg = state.taskGroups.find((g) => g.branchName === w.branch)
      const derivedStatus = existingTg ? deriveStatus(existingTg, state.taskGroupId) : "completed"
      const status = registered ? `已注册 (TG${existingTg?.id}, ${derivedStatus})` : "未注册（可恢复进度）"
      lines.push(`| ${w.branch} | \`${w.path}\` | ${status} |`)
    }
    if (unregistered.length > 0) {
      lines.push("")
      if (state.unattended) {
        lines.push(`⚠️ 发现 ${unregistered.length} 个未注册到状态文件的 worktree，（无人值守模式）跳过恢复，继续执行。`)
      } else {
        lines.push(`⚠️ 发现 ${unregistered.length} 个未注册到状态文件的 worktree，请用 question 询问用户是否恢复，确认后调用 opx_orch_init(recovery=...) 恢复。`)
      }
      for (const w of unregistered) {
        const match = w.branch.match(/^task-group\/(.+?)\/(\d+)$/)
        const tgId = match ? match[2] : "?"
        const cId = match ? match[1] : "?"
        lines.push(`  - ${w.branch} (change=${cId}) → \`opx_orch_init({ change_id: "${cId}", recovery: { phase: "<phase>" } })\` + \`opx_orch_set_worktree\``)
      }
    }
  }
  lines.push("")
  lines.push("## 一致性分析", "")
  const checks: string[] = []
  if ((tg.status === "review" || tg.status === "completed") && tg.phases.architect_review.completed === false) {
    checks.push(`- ⚠️ 阶段逆序：status=${tg.status} 但 architect_review 未完成`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "task_analysis", ... } })\``)
  }
  if (isReviewCompleted(tg) && tg.status !== "review" && tg.status !== "completed") {
    checks.push(`- ⚠️ 状态未推进：status=${tg.status} 但 review 已完成`)
    checks.push(`  建议：直接调用 \`opx_orch_complete_task_group\` 收尾完成。`)
  }
  if ((tg.status === "dev_impl" || tg.status === "review") && !tg.executionBoundary) {
    checks.push(`- ⚠️ 缺 executionBoundary：status=${tg.status} 但 executionBoundary=null`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "task_analysis", ... } })\``)
  }
  for (const dim of REVIEW_DIMENSIONS) {
    if (tg.phases.review.quality.progress[dim] === "passed") {
      const openInDim = tg.issues.filter(
        (i) => i.dimension === dim && i.sourcePhase === "quality" && isStatusUnresolved(i.status) && isBlockingIssue(i)
      )
      if (openInDim.length > 0) {
        checks.push(`- ⚠️ review 内部矛盾：维度 ${dim} passed 但仍有 ${openInDim.length} 个阻塞 issue`)
        if (tg.status === "completed") {
          checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "dev_impl", reopenIssues: true } })\` 重置审查进度后重新验证。`)
        } else {
          checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "dev_impl", ... } })\`，恢复后由 developer 修复遗留 issue 并提交（将重置该维度审查进度）。`)
        }
      }
    }
  }
  if (tg.status === "review") {
    const atCheckpoint = tg.phases.review.retryCount > 0 && tg.phases.review.retryCount % MAX_RETRIES === 0
    const alreadyResolved = tg.phases.review.retryCount === tg.phases.review.lastResolvedRetryCount
    if (atCheckpoint && !alreadyResolved) {
      checks.push(`- ⛔ 审查重试达到检查点（第 ${tg.phases.review.retryCount} 轮），需要用户决策。`)
      checks.push(`  唯一动作：调用 \`opx_orch_resolve_review\` 推进（continue / giveup）。`)
    }
  }
  if (checks.length > 0) {
    lines.push(...checks)
    lines.push("")
    if (state.unattended) {
      lines.push("（无人值守模式）以上异常将按对应建议自动执行。")
    } else {
      lines.push("请用 question 向用户展示上述异常，确认后按对应建议修复。")
    }
  } else {
    lines.push("未发现状态异常。")
  }
  lines.push("", "## 下一步", "")
  if (checks.length > 0) {
    lines.push("以上状态异常，请按对应建议修复。")
  } else if (tg.status === "completed") {
    lines.push("编排已完成。")
  } else if (isReviewCompleted(tg)) {
    lines.push("所有审核层已完成，调用 `opx_orch_complete_task_group` 收尾。")
  } else if (tg.status === "review") {
    const needsDecision = tg.phases.review.retryCount > 0
      && tg.phases.review.retryCount % MAX_RETRIES === 0
      && tg.phases.review.retryCount !== tg.phases.review.lastResolvedRetryCount
    if (needsDecision) {
      lines.push("审查重试达到检查点（retryCount=" + tg.phases.review.retryCount + "），需要用户决策。")
      lines.push("请调用 `opx_orch_resolve_review` 推进（continue：继续修 / giveup：放弃合并）。")
    } else {
      const agents = deriveCurrentAgents(tg)
      if (agents.length > 0) {
        const agentList = agents.map((a) => `\`${a}\``).join("、")
        lines.push(`分派子代理：${agentList}。`)
        if (agents.length > 1) {
          lines.push("（多子代理相互独立，可在单条消息中并排分派，无需串行等待）")
        }
        if (tg.phases.review.task.completed && !tg.phases.review.tool.completed) {
          lines.push("（说明：task 层已自动跳过，tool review 完成后直接进入 quality review）")
        }
      } else {
        lines.push("（无待分派项，请检查状态）")
      }
    }
  } else if (tg.status === "dev_impl" && (!tg.worktreePath || !tg.baseRef)) {
    lines.push("资源未就绪：调用 `opx_orch_set_worktree`。")
  } else {
    if (!tg.worktreePath || !tg.baseRef) {
      lines.push("资源未就绪：调用 `opx_orch_set_worktree`。")
    }
    const agents = deriveCurrentAgents(tg)
    if (agents.length > 0) {
      const agentList = agents.map((a) => `\`${a}\``).join("、")
      lines.push(`分派子代理：${agentList}。`)
      if (agents.length > 1) {
        lines.push("（多子代理相互独立，可在单条消息中并排分派，无需串行等待）")
      }
      if (tg.phases.review.task.completed && !tg.phases.review.tool.completed) {
        lines.push("（说明：task 层已自动跳过，tool review 完成后直接进入 quality review）")
      }
    } else {
      lines.push("（无待分派项，请检查状态）")
    }
  }
  return lines.join("\n")
}

export function renderArchitectView(state: OrchestrateState, tg: TaskGroupState): string {
  const lines: string[] = []
  lines.push("# 架构师上下文", "")
  lines.push(`**变更**: ${state.changeId}`)
  const arcReviewLayer = tg.status === "review"
    ? tg.phases.review.tool.completed
      ? tg.phases.review.task.completed
        ? "(quality)"
        : "(task)"
      : "(tool)"
    : ""
  lines.push(`**当前阶段**: ${tg.status}${arcReviewLayer}`, "")
  lines.push(...renderSkillSuggestions("openspec-architect", AGENT_CAPABILITY_SUGGESTIONS["openspec-architect"]))
  lines.push(...renderWorktreeSection(state, tg))
  lines.push("## 推荐阅读文档", "")
  lines.push(`- \`openspec/changes/${state.changeId}/clarify.md\``)
  lines.push(`- \`openspec/changes/${state.changeId}/design.md\``)
  lines.push(`- \`openspec/changes/${state.changeId}/tasks.md\``)
  for (const s of tg.relevantSpecs) {
    lines.push(`- \`openspec/changes/${state.changeId}/specs/${s}/spec.md\``)
  }
  lines.push("")
  const unresolvedBlockers = tg.blockers.filter((blocker) => blocker.status !== "resolved")
  const archBlockerLines: string[] = []
  for (const blocker of unresolvedBlockers) {
    archBlockerLines.push(`- Blocker #${blocker.id} | ${blocker.status} | ${blocker.category}`)
    archBlockerLines.push(`  - 来源：${blocker.sourceRole}${blocker.taskId ? `；Task #${blocker.taskId}` : ""}`)
    archBlockerLines.push(`  - 描述：${blocker.description}`)
    archBlockerLines.push(`  - 证据：${blocker.evidence}`)
    archBlockerLines.push(`  - 已尝试：${blocker.attemptedActions}`)
    if (blocker.options.length > 0) archBlockerLines.push(`  - 可选方案：${blocker.options.join("；")}`)
    if (blocker.userResponse) archBlockerLines.push(`  - 用户答复：${blocker.userResponse}`)
    if (blocker.architectConclusion) archBlockerLines.push(`  - 架构结论：${blocker.architectConclusion}`)
  }
  renderOptionalSection(lines, "Blocker (待架构复核)", archBlockerLines)
  
  const { tagMap } = scanSkills()
  const archSkills = tagMap.get("architecture") || []
  const archSkillRef = archSkills.length > 0 ? archSkills.map(s => `\`${s}\``).join(", ") : "architecture 类 skill"
  lines.push("## 操作指引", "")
  lines.push("")
  let stepNum = 0
  lines.push(`${stepNum++}. 按上方「Skill 加载清单」逐项加载列出的 skill（不可跳步）`)
  const eff = renderEfficiencySteps(tagMap, stepNum)
  lines.push(...eff.lines)
  stepNum = eff.nextNum
  lines.push(`${stepNum++}. 读取上方「推荐阅读文档」中所有文件原文`)
  lines.push(`${stepNum++}. 交叉比对：`)
  lines.push("   - spec ↔ tasks：当前组子任务是否有对应需求？")
  lines.push("   - spec ↔ design：设计方案是否覆盖 spec 需求？")
  lines.push("   - tasks ↔ design：每项 task 是否有技术方案支撑？完成标准是否一致？")
  lines.push(`${stepNum++}. 检查：`)
  lines.push("   - 前置依赖是否就绪？")
  lines.push("   - 实施所需信息是否齐备？（模板路径/字段映射/外部依赖决策等）")
  lines.push("   - 接口/模型是否与 design 冲突？")
  lines.push("   - 任务排列是否合理？（基础架构类任务应在更早完成）")
  lines.push(`${stepNum++}. 按以下维度审查 design.md 方案合理性：`)
  lines.push(`   - 需求对齐度：方案是否完整覆盖 spec 所有核心需求与非功能约束？`)
  lines.push(`   - 架构模式合规性：方案是否遵循 ${archSkillRef} 的全部规范？`)
  lines.push(`   - 复杂度匹配度：设计复杂度是否与需求规模匹配？是否有过度设计？`)
  lines.push(`   - 风险与边界：隐含假设是否声明？异常路径与退化场景是否覆盖？`)
  lines.push(`   不合理时通过 opx_arch_blocker (category=architecture_design) 反馈`)
  lines.push(`${stepNum++}. 可本地修复的问题（仅限 md 文件）→ edit；信息缺口 → opx_arch_blocker`)
  lines.push(`${stepNum++}. 识别任务中是否已存在通用做法（识别方式见项目 AGENTS.md/CLAUDE.md）：有则注明 dev 须遵循现有做法（任务明确要求换做法除外）；无但判断应做成通用做法的，在 notes 注明拓展性要求`)
  if (state.unattended) {
    lines.push(`${stepNum++}. 复核上方「Blocker (待架构复核)」中 awaiting_user 项——有用户答复用 opx_arch_blocker 处理；缺用户答复时自行推断决策后标记 resolved（无人值守模式）`)
  } else {
    lines.push(`${stepNum++}. 复核上方「Blocker (待架构复核)」中 awaiting_user 项——有用户答复用 opx_arch_blocker 处理（user_response+blocker_id），缺用户答复用 question 工具收集`)
  }
  lines.push(`${stepNum++}. 确定 execution_boundary（含测试代码目录）→ opx_arch_submit(outcome=\"ready\")`)
  return lines.join("\n")
}

export function renderDeveloperView(state: OrchestrateState, tg: TaskGroupState): string {
  const lines: string[] = []
  lines.push("# 开发上下文", "")
  lines.push(`当前阶段: ${tg.status}`, "")
  lines.push(...renderSkillSuggestions("openspec-developer", AGENT_CAPABILITY_SUGGESTIONS["openspec-developer"]))
  lines.push(...renderWorktreeSection(state, tg))
  lines.push("## 执行边界", "")
  if (tg.executionBoundary) {
    const b = tg.executionBoundary
    lines.push("- **允许目录**:")
    for (const d of b.allowed_directories) lines.push(`  - \`${d}\``)
    lines.push("- **允许包**:")
    for (const p of b.allowed_packages) lines.push(`  - \`${p}\``)
    if (b.notes) lines.push(`- **实施前请注意遵守**: ${b.notes}`)
  } else {
    lines.push("- (无)")
  }
  lines.push("")
  const highRefixBlocking = tg.issues.filter(
    (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i) && i.refixCount >= 2
  )
  if (highRefixBlocking.length > 0) {
    lines.push("## ⚠️ 修复多次未过的 issue（须根因分析）", "")
    for (const issue of highRefixBlocking) {
      lines.push(`- Issue #${issue.id}（已 ${issue.refixCount} 次修复未过）`)
      lines.push(`  - 文件：${formatFilePath(issue.file, issue.line)}`)
      lines.push(`  - 描述：${issue.description}`)
    }
    lines.push("")
    lines.push("**必须完成 5-Why 根因分析后再动手修复**，不得跳过分析直接改代码。", "")
  }
  lines.push("## 推荐阅读文档", "")
  lines.push(`- \`openspec/changes/${state.changeId}/clarify.md\``)
  lines.push(`- \`openspec/changes/${state.changeId}/design.md\``)
  for (const s of tg.relevantSpecs) lines.push(`- \`openspec/changes/${state.changeId}/specs/${s}/spec.md\``)
  lines.push("")
  const openTasks = tg.tasks.filter((t) => t.status === "open")
  renderOptionalSection(lines, "Task (待完成)", openTasks.map(renderTaskItem))
  const devSubmitted = tg.tasks.filter((t) => t.status === "submitted")
  renderOptionalSection(lines, "Task (待验证)", devSubmitted.map(renderTaskItem))
  const rejectedTasks = tg.tasks.filter((t) => t.status === "rejected")
  renderOptionalSection(lines, "Task (已驳回)", rejectedTasks.map(t => {
    const reason = t.rejectReason ? `  - 驳回原因：${t.rejectReason}` : ""
    return `${renderTaskItem(t)}${reason ? `\n${reason}` : ""}`
  }))
  const blockingIssues = tg.issues.filter(
    (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
  )
  renderOptionalSection(lines, "Issue (待修复 · Low 及以上，必办)", sortIssuesByCategory(blockingIssues).map(renderIssueItem))
  const infoFix = tg.issues.filter(
    (i) => (i.status === "open" || i.status === "rejected") && !isBlockingIssue(i)
  )
  renderOptionalSection(lines, "Issue (待修复 · Info，建议修复，不阻塞提交)", sortIssuesByCategory(infoFix).map(renderIssueItem))
  const submittedIssues = tg.issues.filter((i) => i.status === "submitted")
  renderOptionalSection(lines, "Issue (已修复待验证)", sortIssuesByCategory(submittedIssues).map(renderIssueItem))
  const exemptionIssues = tg.issues.filter((i) => i.status === "exemption_requested")
  renderOptionalSection(lines, "Issue (豁免裁定中)", sortIssuesByCategory(exemptionIssues).map(renderIssueItem))
  const { tagMap } = scanSkills()
  lines.push("## 操作指引", "")
  lines.push("")
  let stepNum = 0
  lines.push(`${stepNum++}. 按「Skill 加载清单」逐项加载列出的 skill（不可跳步）`)
  const eff = renderEfficiencySteps(tagMap, stepNum)
  lines.push(...eff.lines)
  stepNum = eff.nextNum
  lines.push(`${stepNum++}. 实施「Task (待完成)」的全部任务——遵循所有已加载 skill 的全部规范与约束`)
  lines.push(`${stepNum++}. 逐项检视所有已加载 skill 的 MUST 规范，确认全部满足（不满足则补做，不得跳过）`)
  lines.push(`${stepNum++}. 用上方「变更范围」命令确认本次变更涉及文件，据此按已加载的 API 测试规范核对变更接口的测试脚本——文件存在、内容已更新`)
  lines.push(`${stepNum++}. 按已加载的技术栈 skill 运行项目级构建验证（编译、单元测试、质量门等）`)
  lines.push(`${stepNum++}. 全部完成 → commit → opx_dev_submit(outcome=\"completed\")`)
  lines.push(`${stepNum++}. 遇外部依赖/凭证/真实输入缺失无法继续 → opx_dev_submit(outcome=\"blocked\")`)
  return lines.join("\n")
}

export function renderToolReviewView(state: OrchestrateState, tg: TaskGroupState): string {
  const lines: string[] = []
  lines.push("# 工具审核上下文", "")
  lines.push(...renderSkillSuggestions("openspec-reviewer-tool", AGENT_CAPABILITY_SUGGESTIONS["openspec-reviewer-tool"]))
  lines.push(...renderWorktreeSection(state, tg))
  const toolIssues = renderLayerIssues(tg.issues, "tool")
  renderOptionalSection(lines, "全部 Issue（tool 层可见）", toolIssues)
  const { tagMap } = scanSkills()
  lines.push("## 操作指引", "")
  lines.push("")
  let stepNum = 0
  lines.push(`${stepNum++}. 按上方「Skill 加载清单」逐项加载列出的 skill（不可跳步）`)
  const eff = renderEfficiencySteps(tagMap, stepNum)
  lines.push(...eff.lines)
  stepNum = eff.nextNum
  lines.push(`${stepNum++}. 用上方「变更范围」命令获取本 change 全部已提交变更文件清单，作为审查范围`)
  lines.push(`${stepNum++}. 加载质量门 skill，获取工具清单、执行命令与 issue 映射表`)
  lines.push(`${stepNum++}. 按质量门 skill 定义顺序逐项执行工具检查（环境检查 → 编译 → 格式 → 架构约束 → 静态分析 → 测试编译与覆盖率 → 深度扫描 → 工具配置检查）`)
  lines.push(`${stepNum++}. 每项检查先按质量门 skill 自愈步骤恢复——同一环境/技术故障自愈尝试上限 3 次`)
  if (state.unattended) {
    lines.push(`${stepNum++}. 自愈超限后记 skipped 并说明理由（无人值守模式）`)
  } else {
    lines.push(`${stepNum++}. 自愈超限后用 question 提请用户裁定，或按质量门 skill 降级`)
  }
  lines.push(`${stepNum++}. 按质量门 skill 映射表将工具输出翻译为统一 issue`)
  lines.push(`${stepNum++}. 核验「待确认」issue 是否真已修复——已修复列入 fixed_issue_ids；未达标则不列入（工具自动回退为 rejected）`)
  lines.push(`${stepNum++}. 汇总 → opx_tool_review_submit`)
  return lines.join("\n")
}

export function renderTaskReviewView(state: OrchestrateState, tg: TaskGroupState): string {
  const lines: string[] = []
  lines.push("# 任务审核上下文", "")
  lines.push(`**tool 层**: ${tg.phases.review.tool.completed ? "✓ 已完成" : "⏳ 待完成"}`, "")
  lines.push(...renderSkillSuggestions("openspec-reviewer-task", AGENT_CAPABILITY_SUGGESTIONS["openspec-reviewer-task"]))
  lines.push(...renderWorktreeSection(state, tg))
  lines.push("## 推荐阅读文档", "")
  lines.push(`- \`openspec/changes/${state.changeId}/design.md\``)
  for (const s of tg.relevantSpecs) lines.push(`- \`openspec/changes/${state.changeId}/specs/${s}/spec.md\``)
  lines.push("")
  if (tg.executionBoundary?.notes) {
    lines.push("## 实施指引", "")
    lines.push(tg.executionBoundary.notes)
    lines.push("")
  }
  const reviewSubmitted = tg.tasks.filter((t) => t.status === "submitted")
  renderOptionalSection(lines, "Task (待验证)", reviewSubmitted.map(renderTaskItem))
  const reviewRejected = tg.tasks.filter((t) => t.status === "rejected")
  renderOptionalSection(lines, "Task (已驳回)", reviewRejected.map(t => {
    const reason = t.rejectReason ? `  - 驳回原因：${t.rejectReason}` : ""
    return `${renderTaskItem(t)}${reason ? `\n${reason}` : ""}`
  }))
  const taskIssues = renderLayerIssues(tg.issues, "task")
  renderOptionalSection(lines, "审查 Issue", taskIssues)
  const { tagMap } = scanSkills()
  lines.push("## 操作指引", "")
  lines.push("")
  lines.push("0. 按上方「Skill 加载清单」逐项加载列出的 skill（不可跳步）")
  let stepNum = 1
  const eff = renderEfficiencySteps(tagMap, stepNum)
  lines.push(...eff.lines)
  stepNum = eff.nextNum
  lines.push(`${stepNum++}. 用上方「变更范围」命令获取本 change 全部已提交变更文件清单，作为审查范围`)
  const hasGuidance = !!tg.executionBoundary?.notes
  if (hasGuidance) {
    lines.push(`${stepNum++}. 校验实施内容是否遵循上方「实施指引」中的指引；发现违背时报 issue`)
  }
  lines.push(`${stepNum++}. Task 产出验证：逐条核验各 task 产出完整性，按已加载的技术栈 skill 验证编译`)
  lines.push(`${stepNum++}. 服务启动验证：`)
  lines.push("   - 按上方 Worktree 区段的隔离标识与建议端口，按已加载 API 测试 skill 的隔离要求执行：搭建独立验证环境 → 启动应用 → 健康检查")
  lines.push("   - validation_steps 须显式列出「隔离环境搭建/清理」项")
  lines.push("   - **禁止复用或清空共享开发库**")
  lines.push(`${stepNum++}. **不可跳过** — API 测试验证：识别受影响 API，按已加载的 API 测试规范执行验证`)
  lines.push(`${stepNum++}. UT 测试质量审查：按已加载的测试技能规范审查单元测试质量`)
  lines.push(`${stepNum++}. 全部验证完成后清理隔离环境`)
  lines.push(`${stepNum++}. 发现本轮验证过程中的非本轮引入缺陷 → 按统一严重级别体系提交 issue（至少 Low）`)
  lines.push(`${stepNum++}. 核验「审查 Issue」中「待确认」issue 是否真已修复`)
  lines.push(`${stepNum++}. 缺少验证所需真实资源（隔离环境无法正常搭建亦属此类）→ opx_task_review_submit(passed=false)；禁止静默降级复用共享库`)
  lines.push(`${stepNum++}. 汇总 → opx_task_review_submit`)
  return lines.join("\n")
}

export function renderQualityReviewView(state: OrchestrateState, tg: TaskGroupState, agent: string): string {
  const dimension = (Object.keys(DIMENSION_AGENT_MAP) as Dimension[]).find((d) => DIMENSION_AGENT_MAP[d] === agent) || ""
  const lines: string[] = []
  const tiSkills = getToolImprovementSkills(agent)
  lines.push(`# AI 审查上下文 — ${dimension}`, "")
  lines.push(`**task 层**: ${tg.phases.review.task.completed ? "✓ 已完成" : "⏳ 待完成"}`, "")
  lines.push(...renderSkillSuggestions(agent, AGENT_CAPABILITY_SUGGESTIONS[agent] || []))
  lines.push(...renderWorktreeSection(state, tg))
  if (dimension === "architecture") {
    lines.push("## 推荐阅读文档", "")
    lines.push(`- \`openspec/changes/${state.changeId}/design.md\``)
    lines.push("  （以 design.md 中经 architect 批准的架构方案为基线，对照代码验证实施忠实度）")
    if (tg.relevantSpecs.length > 0) {
      for (const s of tg.relevantSpecs) lines.push(`- \`openspec/changes/${state.changeId}/specs/${s}/spec.md\``)
    }
    lines.push("")
  } else if (dimension === "performance" || dimension === "security") {
    lines.push("## 推荐阅读文档", "")
    lines.push(`- \`openspec/changes/${state.changeId}/design.md\``)
    lines.push("")
  }
  lines.push(
    "> 回归排查：对照上方「变更范围」命令输出的变更文件，检查本次修复是否在本维度引入了新问题；发现即在本维度报新 issue。",
    ""
  )
  const qualityIssues = renderLayerIssues(tg.issues, "quality", dimension)
  renderOptionalSection(lines, "本维度 Issue", qualityIssues)
  const { tagMap } = scanSkills()
  lines.push("## 操作指引", "")
  lines.push("")
  let stepNum = 0
  lines.push(`${stepNum++}. 按上方「Skill 加载清单」逐项加载列出的 skill（不可跳步）`)
  const eff = renderEfficiencySteps(tagMap, stepNum)
  lines.push(...eff.lines)
  stepNum = eff.nextNum
  lines.push(`${stepNum++}. 用上方「变更范围」命令获取变更文件清单，逐文件审查，按本维度审查标准发现问题`)
  if (dimension === "architecture") {
    lines.push(`${stepNum++}. 对照 design.md 架构方案基线，验证代码实施忠实度——偏离且违规时报 issue`)
  }
  lines.push(`${stepNum++}. 核验「本维度 Issue (待确认)」中每条是否真已修复 → fixed_issue_ids（未达标的不列入）`)
  lines.push(`${stepNum++}. 裁定「本维度 Issue (豁免裁定中)」→ exempt_issue_ids / rejected_issue_ids`)
  if (tiSkills.length > 0) {
    lines.push(`${stepNum++}. 新发现的本维度问题：`)
    lines.push("   - 优先判断此问题是否可通过工具配置统一解决")
    lines.push(`   - 是 → 报业务 issue + 同时报工具改进 issue（suggestion 末尾标 [tool_eligible]），规则草案参考已加载的 \`${tiSkills[0]}\``)
    lines.push("   - 否 → 报常规 issue（severity 不可下调来使维度 passed）")
  } else {
    lines.push(`${stepNum++}. 新发现的本维度问题 → 报 issue（severity 不可下调来使维度 passed）`)
  }
  lines.push(`${stepNum++}. 完成 → opx_quality_review_submit`)
  return lines.join("\n")
}
