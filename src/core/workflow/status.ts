import type { OrchestrateState, TaskGroupState, BlockerItem, ExecutionBoundary, Dimension } from "../types.js"
import type { WorkItem, StepConfig } from "./types.js"
import type { LoadedWorkflow } from "./loader.js"
import type { EngineRecommendation } from "./engine.js"
import { getStepVerdict, isTerminalPhase, isBlockingSeverity } from "./engine.js"
import { ORCHESTRATOR_AGENT, DIMENSION_AGENT_MAP } from "../constants.js"
import { resolveChildIssueFields } from "./reset.js"
import { taskListOf, issueChildrenOf } from "../task-children.js"
import {
  renderSkillSuggestions, renderEfficiencySteps, renderWorktreeSection,
  renderAgentSummaries, renderTaskItem, formatFilePath, formatSeverity,
} from "../views.js"

export interface WorkflowStatusViewOptions {
  state: OrchestrateState
  tg: TaskGroupState
}

/**
 * 新流动态视图：按调用者角色 + 引擎推荐（recommendForItem）渲染。
 * - 终态（done/cancelled）：呈现已完成/已取消状态（见 renderTerminalPhase）
 * - checkpoint：呈现检查点状态 + continue/giveup 决策入口（复用既有文案）
 * - suspended / blocked / terminal：分别呈现暂停原因 / 阻塞原因 / step 已通过
 * - recommend：
 *   - orchestrator → 分派视图（阶段进展 + children 统计 + blocker 汇总 + 下一步分派）
 *   - 调用者 ∈ 推荐 agents → ✅ 执行视图（skill 加载清单 + 按 step 渲染 children/blocker/执行边界/会话摘要 + 操作指引）
 *   - 否则 → ⛔ 阶段门禁（复用既有 gate 文案）
 */
export function renderWorkflowStatusView(
  item: WorkItem,
  workflow: LoadedWorkflow,
  rec: EngineRecommendation,
  ctxAgent: string,
  options: WorkflowStatusViewOptions,
): string {
  if (item.metadata["_checkpoint"] === true || rec.status === "checkpoint") {
    return renderCheckpoint(rec)
  }
  if (rec.status === "suspended") {
    return renderSuspended(item)
  }
  if (item.phase === "done" || item.phase === "cancelled") {
    return renderTerminalPhase(item)
  }
  if (rec.status === "blocked") {
    if (ctxAgent === ORCHESTRATOR_AGENT) {
      return renderOrchestratorDispatch(options.state, item, workflow, rec)
    }
    return renderBlocked(rec)
  }
  if (rec.status === "terminal") {
    if (ctxAgent === ORCHESTRATOR_AGENT) {
      return renderOrchestratorDispatch(options.state, item, workflow, rec)
    }
    return renderTerminal(rec)
  }
  if (ctxAgent === ORCHESTRATOR_AGENT) {
    return renderOrchestratorDispatch(options.state, item, workflow, rec)
  }
  if (rec.agents.includes(ctxAgent)) {
    const step = rec.stepId ? (workflow.stepMap.get(rec.stepId)?.step ?? null) : null
    return renderAgentWorking(item, rec, step, ctxAgent, options.state, options.tg)
  }
  return renderGate(rec, item, ctxAgent)
}

function renderCheckpoint(rec: EngineRecommendation): string {
  const round = rec.checkpoint?.retryCount ?? "?"
  const step = rec.stepId ?? "(无)"
  return [
    `# ⛔ 审查重试达到检查点（第 ${round} 轮）`,
    "",
    "需要用户决策。",
    `唯一动作：调用 \`opx_agent_submit({ step_id: "${step}", checkpoint_decision: "continue" })\`（continue / giveup 二选一）推进。`,
    "",
  ].join("\n")
}

function renderSuspended(item: WorkItem): string {
  const reason = (item.metadata["suspend_reason"] as string) || "suspended"
  return [
    "# ⏸ WorkItem 已暂停",
    "",
    `- **原因**: ${reason}`,
    `- **当前 step**: \`${item.currentStep ?? "(无)"}\``,
    "",
    "暂停期间跳过调度，请结束当前会话，不执行任何操作。",
    "",
  ].join("\n")
}

/** 终态渲染：done 区分已完成（completed_at 已写）与待收尾；cancelled 呈现已取消。 */
function renderTerminalPhase(item: WorkItem): string {
  if (item.phase === "cancelled") {
    return [
      "# 🚫 任务组已取消",
      "",
      "- **说明**: 该 WorkItem 已取消，编排停止，请结束当前会话。",
      "",
    ].join("\n")
  }
  if (item.metadata["completed_at"] !== undefined) {
    return [
      "# ✅ 任务组已完成",
      "",
      `- **完成时间**: ${item.metadata["completed_at"]}`,
      "",
      "编排已完成并收尾。",
      "",
    ].join("\n")
  }
  return [
    "# 🏁 任务组已完成，待收尾",
    "",
    "全部审核层已通过。调用 `opx_orch_complete_task_group` 合并分支并完成收尾。",
    "",
  ].join("\n")
}

function renderBlocked(rec: EngineRecommendation): string {
  return [
    "# ⛔ 当前无法推进（blocked）",
    "",
    `- **原因**: ${rec.blockedReason ?? "(未知)"}`,
    "",
  ].join("\n")
}

function renderTerminal(rec: EngineRecommendation): string {
  return [
    "# 🏁 当前 step 已通过",
    "",
    `- **说明**: ${rec.message ?? "step 已通过，沿 transitions.on_pass 推进（由 submit 工具执行状态迁移）。"}`,
    "",
  ].join("\n")
}

function renderOrchestratorDispatch(
  state: OrchestrateState,
  item: WorkItem,
  workflow: LoadedWorkflow,
  rec: EngineRecommendation,
): string {
  const lines = [
    "# 编排进度",
    "",
    `**变更**: ${state.changeId}`,
    `**当前阶段**: ${item.phase}（step \`${rec.stepId ?? "(无)"}\`）`,
    "",
  ]
  // 推进被拦时附阻塞原因（优先取 submit 工具写入 metadata 的实际原因，次取引擎 blocked 推荐原因），
  // 编排者据此决策（修复 / recovery / 收尾）
  const metaReason = item.metadata["_advance_block_reason"]
  const advanceBlockReason =
    typeof metaReason === "string" && metaReason !== "" ? metaReason : rec.blockedReason
  if (advanceBlockReason) {
    lines.push(`**推进阻塞**: ${advanceBlockReason}`)
    lines.push("")
  }
  lines.push(...renderProgressSection(item, workflow))
  lines.push(...renderOrchestratorBlockers(item))
  lines.push("## 下一步", "")
  const agents = rec.agents
  if (agents.length > 0) {
    const agentList = agents.map((a) => `\`${a}\``).join("、")
    lines.push(`分派子代理：${agentList}。`)
    if (agents.length > 1) {
      lines.push("（多子代理相互独立，可在单条消息中并排分派，无需串行等待）")
    }
  } else {
    lines.push("（无待分派项，请检查状态）")
  }
  lines.push("")
  return lines.join("\n")
}

/** orchestrator 阶段进展/审核进度：各 step:agent:verdict 汇总 + children 统计。 */
function renderProgressSection(item: WorkItem, workflow: LoadedWorkflow): string[] {
  const lines = ["## 阶段进展 / 审核进度", ""]
  lines.push("| step | agent | verdict |")
  lines.push("|------|-------|---------|")
  for (const phase of workflow.phases) {
    if (isTerminalPhase(phase.name)) continue
    for (const step of phase.steps) {
      for (const agent of step.agents) {
        lines.push(`| \`${step.id}\` | \`${agent}\` | ${getStepVerdict(item, step.id, agent)} |`)
      }
    }
  }
  lines.push("")
  const counts = childStatusCounts(item)
  lines.push("**children 统计**：", "")
  lines.push(`- 待处理 ${counts.todo} · 待裁定 ${counts.review} · 已验证 ${counts.done} · 已豁免 ${counts.cancelled}`)
  if (counts.exempt > 0) lines.push(`- 豁免申请中 ${counts.exempt}`)
  lines.push("")
  return lines
}

/** children 状态统计：todo=待处理、review=待裁定、done=已验证、cancelled=已豁免、exempt_request=豁免申请中。 */
function childStatusCounts(item: WorkItem): { todo: number; review: number; done: number; cancelled: number; exempt: number } {
  const counts = { todo: 0, review: 0, done: 0, cancelled: 0, exempt: 0 }
  // 仅统计 issue child（task child 不计入——子任务进度由 task 语义承载）
  for (const c of issueChildrenOf(item)) {
    if (c.metadata["exempt_request"] !== undefined) counts.exempt++
    switch (c.phase) {
      case "todo": counts.todo++; break
      case "review": counts.review++; break
      case "done": counts.done++; break
      case "cancelled": counts.cancelled++; break
    }
  }
  return counts
}

/** orchestrator blocker 汇总（含状态）。 */
function renderOrchestratorBlockers(item: WorkItem): string[] {
  const blockers = readBlockers(item)
  if (blockers.length === 0) return []
  const lines = ["## Blocker", ""]
  for (const b of blockers) {
    const status = b.status === "resolved" ? "✓ 已解决" : "⏳ 待处理"
    lines.push(`- Blocker #${b.id} | ${status} | ${b.category}`)
    lines.push(`  - 来源：${b.sourceRole}${b.taskId ? `；Task #${b.taskId}` : ""}`)
    lines.push(`  - 描述：${b.description}`)
    if (b.userResponse) lines.push(`  - 用户答复：${b.userResponse}`)
  }
  lines.push("")
  return lines
}

function renderGate(rec: EngineRecommendation, item: WorkItem, ctxAgent: string): string {
  const expected = rec.agents.join(", ") || "(无)"
  return [
    "# ⛔ 阶段门禁",
    "",
    `当前阶段为 **${item.phase}**（step \`${rec.stepId ?? "(无)"}\`），未轮到你（**${ctxAgent}**）执行。`,
    `当前预期角色为：\`${expected}\``,
    "",
    "请立即结束当前会话，不要执行任何操作。",
    "",
  ].join("\n")
}

function renderAgentWorking(
  item: WorkItem,
  rec: EngineRecommendation,
  step: StepConfig | null,
  ctxAgent: string,
  state: OrchestrateState,
  tg: TaskGroupState,
): string {
  const caps = step?.capability_tags ?? []
  const lines = [
    "# ✅ 当前轮到你执行",
    "",
    "完成本职工作后**必须**调用 `opx_agent_submit()` 提交。",
    "按结果提交 `verdict=passed` 或 `verdict=failed`。",
    "",
    "---",
    "",
    "# 当前任务上下文",
    "",
    `**变更**: ${state.changeId}`,
    `**阶段**: ${item.phase} | **step**: \`${rec.stepId ?? "(无)"}\``,
    "",
  ]
  lines.push(...renderWorktreeSection(state, tg, { showNamespace: true, showPort: true }))
  lines.push(...renderAgentSummaries(readAgentSummaries(item)))
  lines.push(...renderStepContext(item, step, ctxAgent))
  lines.push(...renderSkillSuggestions(ctxAgent, caps))
  lines.push("## 操作指引", "")
  let n = 0
  lines.push(`${n++}. 按上方「Skill 加载清单」逐项加载列出的 skill（不可跳步）`)
  const eff = renderEfficiencySteps(n)
  lines.push(...eff.lines)
  n = eff.nextNum
  if (tg.worktreePath && tg.baseRef) {
    lines.push(`${n++}. 用上方「变更范围」命令获取本 change 全部已提交变更文件清单，作为本次工作范围`)
  }
  lines.push(`${n++}. 执行当前 step（\`${rec.stepId}\`）职责范围内的全部工作——遵循所有已加载 skill 的全部规范与约束`)
  lines.push(`${n++}. 逐项检视所有已加载 skill 的 MUST 规范，确认全部满足（不满足则补做，不得跳过）`)
  lines.push(`${n++}. 按已加载的质量门类 skill 在本地执行构建验证，并本地核对覆盖率门禁达标后再提交（避免提交后由审核层复核发现不达标来回返工）`)
  lines.push(`${n++}. 全部完成 → commit → \`opx_agent_submit({ step_id: "${rec.stepId}", verdict: "passed" })\``)
  lines.push(`${n++}. 遇阻塞无法继续 → \`opx_agent_submit({ step_id: "${rec.stepId}", verdict: "failed" })\``)
  lines.push("")
  return lines.join("\n")
}

/** 按 step 渲染动态上下文：analyze=blocker、implement=执行边界+待修复 children、verify_*=children/待验证任务清单。 */
function renderStepContext(item: WorkItem, step: StepConfig | null, ctxAgent: string): string[] {
  if (!step) return []
  const lines: string[] = []
  switch (step.id) {
    case "analyze":
      lines.push(...renderAnalyzeBlockers(item))
      break
    case "implement":
      lines.push(...renderExecutionBoundary(item))
      lines.push(...renderDeveloperChildren(item))
      break
    case "verify_tool":
      lines.push(...renderToolChildren(item))
      break
    case "verify_task":
      lines.push(...renderTaskChildren(item))
      break
    case "verify_quality":
      lines.push(...renderQualityChildren(item, ctxAgent))
      break
  }
  return lines
}

// ─── children / blockers / 执行边界 渲染 ───

function readBlockers(item: WorkItem): BlockerItem[] {
  const raw = item.metadata["blockers"]
  return Array.isArray(raw) ? (raw as BlockerItem[]) : []
}

function readTasks(item: WorkItem): ReturnType<typeof taskListOf> {
  return taskListOf(item)
}

function readAgentSummaries(item: WorkItem): Record<string, string> | undefined {
  const raw = item.metadata["agent_summaries"]
  return typeof raw === "object" && raw !== null ? (raw as Record<string, string>) : undefined
}

function readExecutionBoundary(item: WorkItem): ExecutionBoundary | null {
  const raw = item.metadata["execution_boundary"]
  return typeof raw === "object" && raw !== null ? (raw as ExecutionBoundary) : null
}

/** analyze step：blocker 清单（awaiting_user/resolved）+ 处理指引。 */
function renderAnalyzeBlockers(item: WorkItem): string[] {
  const blockers = readBlockers(item)
  if (blockers.length === 0) return []
  const lines = ["## Blocker", ""]
  for (const b of blockers) {
    const status = b.status === "resolved" ? "✓ 已解决" : "⏳ 待用户答复"
    lines.push(`- Blocker #${b.id} | ${status} | ${b.category}`)
    lines.push(`  - 来源：${b.sourceRole}${b.taskId ? `；Task #${b.taskId}` : ""}`)
    lines.push(`  - 描述：${b.description}`)
    if (b.evidence) lines.push(`  - 证据：${b.evidence}`)
    if (b.attemptedActions) lines.push(`  - 已尝试：${b.attemptedActions}`)
    if (b.options.length > 0) lines.push(`  - 可选方案：${b.options.join("；")}`)
    if (b.userResponse) lines.push(`  - 用户答复：${b.userResponse}`)
    if (b.architectConclusion) lines.push(`  - 架构结论：${b.architectConclusion}`)
  }
  lines.push("")
  if (blockers.some((b) => b.status !== "resolved")) {
    lines.push("> 存在未解决 blocker：analyze step 无法以 passed 提交。请先通过 `opx_agent_submit` 的 blocker_updates 逐条置 resolved（附用户答复）后再提交。", "")
  }
  return lines
}

/** implement step：执行边界（allowed_directories / allowed_packages）。 */
function renderExecutionBoundary(item: WorkItem): string[] {
  const b = readExecutionBoundary(item)
  if (!b) return []
  const lines = ["## 执行边界", ""]
  lines.push("- **允许目录**:")
  for (const d of b.allowed_directories) lines.push(`  - \`${d}\``)
  lines.push("- **允许包**:")
  for (const p of b.allowed_packages) lines.push(`  - \`${p}\``)
  if (b.notes) lines.push(`- **实施前请注意遵守**: ${b.notes}`)
  lines.push("")
  return lines
}

/** implement step：developer 待修复 children（Low+ 必办 / Info 建议，均带 reject_reason/refix_count 提示）。 */
function renderDeveloperChildren(item: WorkItem): string[] {
  const lines: string[] = []
  // 仅 issue child 进入修复清单（task child 不得混入 issue 渲染）
  const toFix = issueChildrenOf(item).filter(
    (c) => !isTerminalPhase(c.phase) && c.metadata["exempt_request"] === undefined
  )
  if (toFix.length === 0) return lines
  const blocking = toFix.filter((c) => isBlockingSeverity(c.severity))
  const info = toFix.filter((c) => !isBlockingSeverity(c.severity))
  if (blocking.length > 0) {
    lines.push(...renderChildrenSection("Issue (待修复 · Low 及以上，必办)", blocking))
  }
  if (info.length > 0) {
    lines.push(...renderChildrenSection("Issue (待修复 · Info，建议修复，不阻塞提交)", info))
  }
  const highRefix = toFix.filter((c) => typeof c.metadata["refix_count"] === "number" && (c.metadata["refix_count"] as number) >= 2)
  if (highRefix.length > 0) {
    lines.push("## ⚠️ 修复多次未过的 issue（须根因分析）", "")
    for (const c of highRefix) {
      const id = c.externalId ?? c.id.replace(/^issue:/, "")
      lines.push(`- Issue #${id}（已 ${c.metadata["refix_count"]} 次修复未过）`)
    }
    lines.push("", "**必须完成 5-Why 根因分析后再动手修复**，不得跳过分析直接改代码。", "")
  }
  return lines
}

/** verify_tool step：reviewer-tool 视角全部 issue children + 待裁定（review / exempt_request）。 */
function renderToolChildren(item: WorkItem): string[] {
  const lines: string[] = []
  const issues = issueChildrenOf(item)
  if (issues.length > 0) {
    lines.push(...renderChildrenSection("全部 Issue（tool 层可见）", issues))
  }
  const pending = issues.filter((c) => c.phase === "review" || c.metadata["exempt_request"] !== undefined)
  if (pending.length > 0) {
    lines.push(...renderChildrenSection("待裁定 (review / 豁免申请中)", pending))
  }
  return lines
}

/** verify_task step：task children 待验证列表 + 待裁定 children。 */
function renderTaskChildren(item: WorkItem): string[] {
  const lines: string[] = []
  const pendingTasks = readTasks(item).filter((t) => t.status === "submitted")
  if (pendingTasks.length > 0) {
    lines.push("## Task (待验证)", "")
    for (const t of pendingTasks) lines.push(renderTaskItem(t))
    lines.push("")
  }
  const pending = issueChildrenOf(item).filter((c) => c.phase === "review" || c.metadata["exempt_request"] !== undefined)
  if (pending.length > 0) {
    lines.push(...renderChildrenSection("Issue (待裁定)", pending))
  }
  return lines
}

/** verify_quality step：各维度 reviewer 仅渲染本维度 issue children（metadata.dimension === 当前 agent 对应维度）。 */
function renderQualityChildren(item: WorkItem, ctxAgent: string): string[] {
  const dimension = agentToDimension(ctxAgent)
  if (!dimension) return []
  // task child 无 dimension 归因（resolveChildIssueFields 缺省 style），必须按 type 排除
  const own = issueChildrenOf(item).filter((c) => resolveChildIssueFields(c).dimension === dimension)
  if (own.length === 0) return []
  const lines = [`## 本维度 Issue（${dimension}）`, ""]
  for (const c of own) lines.push(renderChildIssue(c))
  lines.push("")
  return lines
}

/** 调用者 agent → 审查维度（DIMENSION_AGENT_MAP 反查）。 */
function agentToDimension(agent: string): Dimension | undefined {
  return (Object.keys(DIMENSION_AGENT_MAP) as Dimension[]).find((d) => DIMENSION_AGENT_MAP[d] === agent)
}

/** 渲染 children 区块：标题 + 逐条列表，空列表返回空数组。 */
function renderChildrenSection(title: string, children: WorkItem[]): string[] {
  if (children.length === 0) return []
  const lines = [`## ${title}`, ""]
  for (const c of children) lines.push(renderChildIssue(c))
  lines.push("")
  return lines
}

/** 单个 issue child 渲染（参考 views.renderIssueItem 风格，字段来自 WorkItem.metadata）。 */
function renderChildIssue(child: WorkItem): string {
  const f = resolveChildIssueFields(child)
  const id = child.externalId ?? child.id.replace(/^issue:/, "")
  const sev = child.severity ?? "Info"
  const rule = typeof child.metadata["rule"] === "string" ? ` | ${child.metadata["rule"]}` : ""
  const lines = [
    `- Issue #${id} | ${formatSeverity(sev)} | ${f.dimension} | [${f.sourcePhase}]${rule} | ${childStateLabel(child)}`,
  ]
  if (f.file) lines.push(`  - 文件：${formatFilePath(f.file, f.line)}`)
  lines.push(`  - 描述：${child.description}`)
  if (typeof child.metadata["suggestion"] === "string") lines.push(`  - 建议：${child.metadata["suggestion"]}`)
  if (typeof child.metadata["reject_reason"] === "string") lines.push(`  - 驳回原因：${child.metadata["reject_reason"]}`)
  if (typeof child.metadata["refix_count"] === "number") lines.push(`  - 修复未过次数：${child.metadata["refix_count"]}`)
  if (child.metadata["exempt_request"] !== undefined) lines.push("  - 豁免申请中：等待裁定")
  return lines.join("\n")
}

/** child 状态标签：todo=待处理、review=待裁定、done=已验证、cancelled=已豁免；exempt_request 标记 → 豁免申请中。 */
function childStateLabel(child: WorkItem): string {
  if (child.metadata["exempt_request"] !== undefined) return "豁免申请中"
  switch (child.phase) {
    case "todo": return "待处理"
    case "review": return "待裁定"
    case "done": return "已验证"
    case "cancelled": return "已豁免"
    default: return child.phase
  }
}
