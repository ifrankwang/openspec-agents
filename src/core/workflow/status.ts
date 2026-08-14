import type { OrchestrateState, TaskGroupState, BlockerItem, ExecutionBoundary, Dimension } from "../types.ts"
import type { WorkItem, StepConfig, WorkflowCommon } from "./types.ts"
import { stepAgentIds, EXEMPT_REQUEST_KEY } from "./types.ts"
import { EXEMPTED_HIT_KEY } from "../exemptions.ts"
import type { ExemptionRecord } from "../exemptions.ts"
import type { LoadedWorkflow } from "./loader.ts"
import type { EngineRecommendation } from "./engine.ts"
import type { DetectChangesResult } from "../git.ts"
import { getStepVerdict, isTerminalPhase, isBlockingSeverity, phaseStepMismatch, REVIEW_STEP_TO_LAYER, blockingStepChildren } from "./engine.ts"
import { agentToReviewDimension, agentToReviewLayer, readIssueSource } from "../constants.ts"
import { resolveChildIssueFields } from "./reset.ts"
import { taskListOf, issueChildrenOf } from "../task-children.ts"
import {
  renderSkillSuggestions, renderEfficiencySteps, renderWorktreeSection,
  renderAgentSummaries, renderTaskItem, formatFilePath, formatSeverity,
  isWorktreeReady, renderWorktreeNotReady, interpolateText, renderStateMismatchDiagnostic,
} from "../views.ts"
import { resolveMustDoForCaps, SKIP_REASON_FORMAT } from "../tools/gate.ts"

export interface WorkflowStatusViewOptions {
  state: OrchestrateState
  tg: TaskGroupState
  /** 主仓库 openspec 污染诊断结果（56ddfe9 意图），orchestrator 分派视图渲染。 */
  mainPollution?: { repoRoot: string; files: string[] } | null
  /** verify_tool 的 reviewer-tool 工作视图变更检测结果（检查点增量检测，A4）；缺省 undefined 走全量。 */
  toolChanges?: DetectChangesResult
  /** 本 change 命中项目级跨 change 豁免清单的存量问题数（工具层降级时统计，供视图汇总提示）。 */
  exemptedHits?: number
  /** 项目级跨 change 豁免清单条目（statusExecute 渲染前异步读取一次传入；renderChildIssue 逐条提示数据源，纯只读）。 */
  exemptionItems?: ExemptionRecord[]
}

/** 状态视图调用者信息：agent 名用于渲染归属，orchestrator 表示编排视角（各 agent 主代理）路由。 */
export interface StatusViewCaller {
  agent: string
  orchestrator?: boolean
  /** 调用者 agent 身份是否显式声明（MCP 形态下为是否携带 `_agent` 参数；OpenCode 直载形态恒 true）。
   *  false 且落入编排视角时，分派视图渲染补传 `_agent` 的身份提示（MCP 子代理首查死锁兜底）。 */
  identityDeclared?: boolean
}

/**
 * 新流动态视图：按调用者角色 + 引擎推荐（recommendForItem）渲染。
 * - 终态（done/cancelled）：呈现已完成/已取消状态（见 renderTerminalPhase）
 * - checkpoint：呈现检查点状态 + continue/giveup 决策入口（复用既有文案）
 * - suspended / blocked / terminal：分别呈现暂停原因 / 阻塞原因 / step 已通过
 * - recommend：
 *   - 编排视角 → 分派视图（阶段进展 + children 统计 + blocker 汇总 + 下一步分派）
 *   - 调用者 ∈ 推荐 agents → ✅ 执行视图（skill 加载清单 + 按 step 渲染 children/blocker/会话摘要 + 操作指引）
 *   - 否则 → ⛔ 阶段门禁（复用既有 gate 文案）
 */
export function renderWorkflowStatusView(
  item: WorkItem,
  workflow: LoadedWorkflow,
  rec: EngineRecommendation,
  caller: StatusViewCaller,
  options: WorkflowStatusViewOptions,
): string {
  const ctxAgent = caller.agent
  // 状态异常（phase ↔ step 归属错位）最高优先级：子代理一律拒绝执行；
  // 编排视角继续走分派视图，由 renderOrchestratorDispatch 渲染 ⚠️ 诊断。
  if (phaseStepMismatch(item, workflow)) {
    if (!caller.orchestrator) {
      return renderStateMismatch(item, workflow)
    }
  }
  if (item.metadata["_checkpoint"] === true || rec.status === "checkpoint") {
    return renderCheckpoint(rec, workflow, item)
  }
  if (rec.status === "suspended") {
    return renderSuspended(item)
  }
  if (item.phase === "done" || item.phase === "cancelled") {
    return renderTerminalPhase(item)
  }
  if (rec.status === "blocked") {
    if (caller.orchestrator) {
      return renderOrchestratorDispatch(options.state, item, workflow, rec, options.tg, options.mainPollution, caller.identityDeclared)
    }
    return renderBlocked(rec, item, workflow, ctxAgent)
  }
  if (rec.status === "terminal") {
    if (caller.orchestrator) {
      return renderOrchestratorDispatch(options.state, item, workflow, rec, options.tg, options.mainPollution, caller.identityDeclared)
    }
    return renderTerminal(rec)
  }
  if (caller.orchestrator) {
    return renderOrchestratorDispatch(options.state, item, workflow, rec, options.tg, options.mainPollution, caller.identityDeclared)
  }
  if (rec.agents.includes(ctxAgent)) {
    const step = rec.stepId ? (workflow.stepMap.get(rec.stepId)?.step ?? null) : null
    return renderAgentWorking(item, rec, step, workflow.common, ctxAgent, options.state, options.tg, options.toolChanges, options.exemptedHits, exemptionHintCtx(options.exemptionItems))
  }
  return renderGate(rec, item, ctxAgent)
}

/** 渲染期豁免清单提示上下文（纯只读，不写状态）：items 原始清单 + 预构建 (rule+file)→line 映射。
 *  映射在渲染入口构建一次，逐条 issue 渲染时 O(1) 查映射，避免循环内重复扫描清单。 */
interface ExemptionHintCtx {
  items: ExemptionRecord[]
  ruleFileLines: Map<string, number>
}

/** 从豁免清单构建 (rule+file)→line 映射：rule 或 file 任一缺失的条目不参与（与 exemptionKeyOf 宁漏勿误一致）。 */
function buildRuleFileLineMap(items: ExemptionRecord[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const it of items) {
    if (typeof it.rule === "string" && it.rule !== "" && typeof it.file === "string" && it.file !== "") {
      m.set([it.rule, it.file].join("\u0000"), it.line ?? 0)
    }
  }
  return m
}

/** 豁免清单为空时不构建提示上下文（渲染链零额外开销）。 */
function exemptionHintCtx(items: ExemptionRecord[] | undefined): ExemptionHintCtx | undefined {
  if (!items || items.length === 0) return undefined
  return { items, ruleFileLines: buildRuleFileLineMap(items) }
}

function renderCheckpoint(rec: EngineRecommendation, workflow: LoadedWorkflow, item: WorkItem): string {
  const round = rec.checkpoint?.retryCount ?? "?"
  const step = rec.stepId ?? "(无)"
  const lines = [
    `# ⛔ 审查重试达到检查点（第 ${round} 轮）`,
    "",
    "需要用户决策。",
    `唯一动作：调用 \`opx_agent_submit({ step_id: "${step}", checkpoint_decision: "continue" })\`（continue / giveup 二选一）推进。`,
    "",
  ]
  // 质量门类 step（当前 step 能力集解析出质量门必做清单）giveup 时，未覆盖必做项须经
  // checkpoint_skip_reasons 逐项申报结构化降级理由（操作指引层面，不解释门禁内部实现）。
  const entry = rec.stepId ? workflow.stepMap.get(rec.stepId) : undefined
  const stepCaps = Array.from(new Set((entry?.step.agents ?? []).flatMap((a) => a.capability_tags)))
  if (resolveMustDoForCaps(stepCaps).length > 0) {
    lines.push(
      `质量门类 step 的 giveup 决策：未覆盖必做项须经 \`checkpoint_skip_reasons\` 逐项申报结构化降级理由（格式：\`${SKIP_REASON_FORMAT}\`），缺理由 giveup 不会被受理。`,
      "",
    )
  }
  return lines.join("\n")
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

/** blocked 视图：调用者若为当前 step 轮次 agent 用 blocked_agent 文案，否则用通用 blocked 文案。
 *  verify_* 层当前 agent 且存在本层待复核（review 态）blocking issue 时，列出待复核清单并给出
 *  recheck_adjudications 自助恢复指引（上次提交漏带复核导致门禁阻塞的可补交解除）；
 *  存在本层调用者可裁定的豁免申请（待裁定）时同样列出并给出 exempt_adjudications 自助恢复指引
 *  （rejected 须配 verdict=failed、dismissed 配 verdict=passed），两条阻塞解除路径均只对本层报源可见。 */
function renderBlocked(rec: EngineRecommendation, item: WorkItem, workflow: LoadedWorkflow, ctxAgent: string): string {
  const step = rec.stepId ? (workflow.stepMap.get(rec.stepId)?.step ?? null) : null
  const isCurrentAgent = step ? stepAgentIds(step).includes(ctxAgent) : false
  const reason = rec.blockedReason ?? "(未知)"
  if (isCurrentAgent) {
    const layer = step ? REVIEW_STEP_TO_LAYER[step.id] : undefined
    const children = issueChildrenOf(item)
    const pendingRecheck = layer
      ? children.filter((c) => isAgentOwnedIssue(c, ctxAgent) && isBlockingSeverity(c.severity))
      : []
    const pendingExempt = layer
      ? children.filter((c) => isAdjudicableExempt(c, layer, ctxAgent) && isBlockingSeverity(c.severity))
      : []
    const lines = [
      "# ⛔ 当前 step 阻塞中，等待编排处理",
      "",
      `- **原因**: ${reason}`,
      "",
    ]
    if (pendingRecheck.length > 0 && step) {
      lines.push(
        ...renderBlockedAdjudicationBlock(
          "本层待复核 issue",
          pendingRecheck,
          `调用 \`opx_agent_submit({ step_id: "${step.id}", verdict: "passed", recheck_adjudications: [{ issue_id: "<上述 issue id>", verdict: "passed" }] })\` 补带复核结论重提；` +
            `复核通过后自动推进。复核不通过则传 verdict=rejected 并附 reject_reason 驳回（issue 回待修复并累计修复未过次数）。`,
        ),
      )
    }
    if (pendingExempt.length > 0 && step) {
      lines.push(
        ...renderBlockedAdjudicationBlock(
          "本层待裁定豁免申请",
          pendingExempt,
          `调用 \`opx_agent_submit({ step_id: "${step.id}", verdict: "passed", exempt_adjudications: [{ issue_id: "<上述 issue id>", action: "dismissed" }] })\` 补交豁免裁定解除阻塞；` +
            `裁定 dismissed（认可豁免）时 verdict 配 passed，裁定 rejected（驳回=需修复）时 verdict 必须配 failed（审查不能判定通过）。`,
        ),
      )
    }
    if (pendingRecheck.length === 0 && pendingExempt.length === 0) {
      lines.push("你属于当前轮次角色，请勿自行推进，等待编排者解除阻塞后重新查询状态。")
    }
    lines.push("")
    return lines.join("\n")
  }
  return [
    "# ⛔ 当前无法推进（blocked）",
    "",
    `- **原因**: ${reason}`,
    "",
  ].join("\n")
}

/** blocked 视图裁定区块渲染：清单（Issue #id | severity）+ 自助恢复指引，children 为空时返回空数组。 */
function renderBlockedAdjudicationBlock(title: string, children: WorkItem[], guidance: string): string[] {
  const lines = [`- **${title}（${children.length} 个）**:`]
  for (const c of children) {
    const id = c.externalId ?? c.id.replace(/^issue:/, "")
    lines.push(`  - Issue #${id} | ${formatSeverity(c.severity ?? "Info")}`)
  }
  lines.push("", `**自助恢复**：${guidance}`, "")
  return lines
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
  tg: TaskGroupState,
  mainPollution?: { repoRoot: string; files: string[] } | null,
  identityDeclared?: boolean,
): string {
  const lines = [
    "# 编排进度",
    "",
    `**变更**: ${state.changeId}`,
    `**当前阶段**: ${item.phase}（step \`${rec.stepId ?? "(无)"}\`）`,
    "",
  ]
  // 状态异常（phase ↔ step 归属错位）诊断：错位态禁止分派，提示 recovery 恢复。
  if (phaseStepMismatch(item, workflow)) {
    const entry = item.currentStep ? workflow.stepMap.get(item.currentStep) : undefined
    lines.push("## ⚠️ 状态异常（phase ↔ step 归属不一致）", "")
    lines.push(...renderStateMismatchDiagnostic(item.phase, item.currentStep, entry?.phase.name ?? null))
    lines.push("")
    lines.push("WorkItem 阶段与当前 step 归属错位，禁止分派任何子代理执行；请调用 `opx_orch_init(recovery=...)` 重置异常状态后重新调度。")
    lines.push("")
  }
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
  if (mainPollution && mainPollution.files.length > 0) {
    lines.push("## ⚠️ 主仓库 openspec 污染", "")
    lines.push(`检测到主仓库 \`${mainPollution.repoRoot}\` 下 openspec 文档存在未提交变更（修改/新增）：`)
    lines.push("")
    for (const f of mainPollution.files) lines.push(`- \`${f}\``)
    lines.push("")
    lines.push("子代理文件操作应限定在 worktree 内，主仓库路径出现变更通常由误改主分支路径造成，请人工核对处理。")
    lines.push("")
  }
  lines.push(...renderWorktreeSection(state, tg))
  lines.push("## 下一步", "")
  const agents = rec.agents
  if (agents.length > 0) {
    if (!isWorktreeReady(tg)) {
      // 分派前置门禁：worktree 未就绪时不给出分派指令，指引编排者先补齐 worktree 再回来查状态分派
      lines.push("分派前置条件未满足：当前存在待分派子代理，但 worktree 未就绪，暂不给出分派指令。")
      lines.push("请先调用 `opx_orch_set_worktree` 确保 worktree 就绪，再回来查 `opx_status` 获取分派指令。")
    } else {
      const agentList = agents.map((a) => `\`${a}\``).join("、")
      lines.push(`分派子代理：${agentList}。`)
      if (agents.length > 1) {
        lines.push("（多子代理相互独立，可在单条消息中并排分派，无需串行等待）")
      }
    }
  } else {
    // 防御出口：当前 step 存在 failed 残留 tag 但无待分派项 → 状态不一致。
    // 引擎已按「全部非 pending 时回退 failed 维度」自愈重派，此处兜底提示编排者走 recovery
    // 而非盲目回退，避免 failed tag 残留（如历史 state 报源缺失导致归因无法反推到对应维）静默死锁。
    const failed = failedAgentsOnStep(item, workflow, rec.stepId)
    if (failed.length > 0) {
      lines.push("⚠️ 状态不一致：存在 failed 裁决残留但无待分派项，下一步无法正常推进。")
      lines.push(`  - 失败维度：${failed.map((a) => `\`${a}\``).join("、")}`)
      lines.push("  建议：调用 `opx_orch_init(recovery=...)` 重置对应层审查进度后重新验证，勿盲目回退 dev。")
    } else if (rec.status === "blocked") {
      // blocked 且无可推导 reviewer（全部为 todo/in_progress 态或报源缺失）：输出阻塞 children 诊断清单，
      // 替代信息量为零的占位文案，编排者据此判断是派 dev 修复还是走 recovery。
      // 无阻塞 issue children（如跨 phase 门禁拦截的 task child 场景）回退占位文案，避免空区块。
      const diag = renderBlockedChildrenDiagnostic(item, workflow, rec.stepId)
      if (diag.length > 0) lines.push(...diag)
      else lines.push("（无待分派项，请检查状态）")
    } else {
      lines.push("（无待分派项，请检查状态）")
    }
  }
  lines.push("")
  // MCP 形态兜底（身份未显式声明时）：分派视图追加补传 `_agent` 的身份提示。提示正文直接复用
  // workflow 配置 common 块中的 `_agent` 指引原文（单一文案来源，避免双源）；配置缺失该条时静默降级。
  // 覆盖场景：MCP 子代理未按分派 prompt 携带 `_agent` 首查状态，落入编排视角视图时能获得自救指引。
  if (identityDeclared === false) {
    const agentGuidance = workflow.common?.instructions?.find((i) => i.includes("_agent"))
    if (agentGuidance) {
      lines.push(`> **身份提示**：${interpolateText(agentGuidance, {})}`, "")
    }
  }
  return lines.join("\n")
}

/** 当前 step 中 verdict=failed 的 agent 列表（无待分派项时的状态不一致诊断）。 */
function failedAgentsOnStep(item: WorkItem, workflow: LoadedWorkflow, stepId: string | null): string[] {
  if (!stepId) return []
  const step = workflow.stepMap.get(stepId)?.step
  if (!step) return []
  return step.agents.filter((a) => getStepVerdict(item, stepId, a.id) === "failed").map((a) => a.id)
}

/** blocked 且无可推导 reviewer 时的阻塞 children 诊断清单（归属/报源/阶段 + 处理建议）。 */
function renderBlockedChildrenDiagnostic(item: WorkItem, workflow: LoadedWorkflow, stepId: string | null): string[] {
  if (!stepId) return []
  const step = workflow.stepMap.get(stepId)?.step
  if (!step) return []
  const children = blockingStepChildren(item, step)
  if (children.length === 0) return []
  const lines = [
    "⚠️ 当前 step 已全 passed 但存在阻塞 children，且无可补交裁定的 reviewer：",
    "",
  ]
  for (const c of children) {
    const id = c.externalId ?? c.id.replace(/^issue:/, "")
    const f = resolveChildIssueFields(c)
    const source = readIssueSource(c) ?? "(报源缺失)"
    const state =
      c.metadata[EXEMPT_REQUEST_KEY] !== undefined ? "豁免申请中" : c.phase === "review" ? "待复核" : `待处理(${c.phase})`
    lines.push(`- Issue #${id} | ${formatSeverity(c.severity ?? "Info")} | 归属:${f.dimension} | 报源:${source} | ${state}`)
  }
  lines.push("")
  lines.push("处理建议：待复核/豁免申请中条目需报源 reviewer 补交裁定（recheck_adjudications / exempt_adjudications）；")
  lines.push("待处理条目需 developer 修复；报源缺失时核对 state 文件后按需 `opx_orch_init(recovery=...)` 恢复。")
  lines.push("")
  return lines
}

/** orchestrator 阶段进展/审核进度：各 step:agent:verdict 汇总 + children 统计。 */
function renderProgressSection(item: WorkItem, workflow: LoadedWorkflow): string[] {
  const lines = ["## 阶段进展 / 审核进度", ""]
  lines.push("| step | agent | verdict |")
  lines.push("|------|-------|---------|")
  for (const phase of workflow.phases) {
    if (isTerminalPhase(phase.name)) continue
    for (const step of phase.steps) {
      for (const agent of stepAgentIds(step)) {
        lines.push(`| \`${step.id}\` | \`${agent}\` | ${getStepVerdict(item, step.id, agent)} |`)
      }
    }
  }
  lines.push("")
  const counts = childStatusCounts(item)
  lines.push("**children 统计**：", "")
  lines.push(`- 待处理 ${counts.todo} · 待复核 ${counts.review} · 已验证 ${counts.done} · 已豁免 ${counts.cancelled}`)
  if (counts.exempt > 0) lines.push(`- 豁免申请中 ${counts.exempt}`)
  lines.push("")
  return lines
}

/** children 状态统计：todo=待处理、review=待复核、done=已验证、cancelled=已豁免、exempt_request=豁免申请中。
 *  待裁定豁免项（review 态 + exempt_request）只计入豁免申请中，不重复计入待复核/待处理。 */
function childStatusCounts(item: WorkItem): { todo: number; review: number; done: number; cancelled: number; exempt: number } {
  const counts = { todo: 0, review: 0, done: 0, cancelled: 0, exempt: 0 }
  // 仅统计 issue child（task child 不计入——子任务进度由 task 语义承载）
  for (const c of issueChildrenOf(item)) {
    const isExemptRequest = c.metadata[EXEMPT_REQUEST_KEY] !== undefined
    if (isExemptRequest) counts.exempt++
    switch (c.phase) {
      case "todo": if (!isExemptRequest) counts.todo++; break
      case "review": if (!isExemptRequest) counts.review++; break
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

/** 状态异常拒绝视图：phase ↔ step 归属错位时拒绝 agent 执行（复用 renderWorktreeNotReady 拒绝模式），指引 recovery 恢复。 */
function renderStateMismatch(item: WorkItem, workflow: LoadedWorkflow): string {
  const entry = item.currentStep ? workflow.stepMap.get(item.currentStep) : undefined
  return [
    "# ⛔ 状态异常，当前拒绝执行",
    "",
    "WorkItem 阶段与当前 step 归属不一致（phase ↔ step 错位），状态异常：",
    ...renderStateMismatchDiagnostic(item.phase, item.currentStep, entry?.phase.name ?? null),
    "",
    "请立即结束当前会话，不执行任何操作、不调用任何 `opx_*` 变更工具。",
    "请报告编排者调用 `opx_orch_init(recovery=...)` 重置异常状态后重新调度。",
    "",
  ].join("\n")
}

function renderAgentWorking(
  item: WorkItem,
  rec: EngineRecommendation,
  step: StepConfig | null,
  common: WorkflowCommon | undefined,
  ctxAgent: string,
  state: OrchestrateState,
  tg: TaskGroupState,
  toolChanges?: DetectChangesResult,
  exemptedHits?: number,
  exemptionCtx?: ExemptionHintCtx,
): string {
  // worktree 就绪阻断（置于顶部）：未就绪时拒绝执行，渲染 ⛔ 视图，不输出 ✅ 执行视图内容
  if (!isWorktreeReady(tg)) {
    return [
      "# ⛔ worktree 未就绪，当前拒绝执行",
      "",
      ...renderWorktreeNotReady(),
      "",
      "请立即结束当前会话，不执行任何操作、不调用 `opx_agent_submit`。",
      "报告编排者先调用 `opx_orch_set_worktree`，就绪后再回来执行。",
      "",
    ].join("\n")
  }

  // tool review 检查点增量三分支（A4）：仅 verify_tool 的 reviewer-tool 且提供了变更检测结果时生效；
  // toolChanges 缺省（未预计算）时维持既有全量渲染，不误伤其他 agent/step 的通用渲染。
  if (step?.id === "verify_tool" && agentToReviewLayer(ctxAgent) === "tool" && toolChanges) {
    const { active, pending } = toolPendingChildren(item, ctxAgent)
    if (!toolChanges.hasNonDocChange && active.length === 0 && pending.length === 0) {
      return renderToolDirectSubmit(exemptedHits)
    }
    if (!toolChanges.hasNonDocChange) {
      return renderToolAdjudicateOnly(item, rec, ctxAgent, exemptedHits, exemptionCtx)
    }
  }
  // skill 加载清单按当前调用者 agent 声明的 capability_tags 过滤（step 内各 agent 独立声明，互不相同）
  const caps = step?.agents.find((a) => a.id === ctxAgent)?.capability_tags ?? []
  // step 语义占位符插值上下文：动态值来源见各 key（缺值保留占位符原文，不阻断渲染）
  const stepCtx: Record<string, string> = {}
  if (tg.worktreePath) stepCtx["worktree_path"] = tg.worktreePath
  stepCtx["change_id"] = state.changeId
  if (rec.stepId) stepCtx["step_id"] = rec.stepId
  stepCtx["phase"] = item.phase
  stepCtx["agent"] = ctxAgent
  stepCtx["base_branch"] = state.baseBranch
  const boundary = readExecutionBoundary(item)
  if (boundary) {
    stepCtx["allowed_directories"] = boundary.allowed_directories.join(", ")
    stepCtx["allowed_packages"] = boundary.allowed_packages.join(", ")
    // notes 留空（架构师按规范无补充）时渲染为「无额外说明」，避免视图中出现字面 {{notes}}
    stepCtx["notes"] = boundary.notes && boundary.notes.trim() !== "" ? boundary.notes : "无额外说明"
  }
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
  if ((exemptedHits ?? 0) > 0) {
    lines.push(
      `> **存量豁免提示**：本 change 存在 ${exemptedHits} 个命中项目级跨 change 豁免清单的存量问题（已按 Info 处理，不阻塞、无需重复豁免）。`,
      "",
    )
  }
  lines.push(...renderStepSemantics(step, common, stepCtx))
  lines.push(...renderWorktreeSection(state, tg, { showNamespace: true, showPort: true }))
  // verify_tool 分支③（有变更 → 全量路径）证据注入：展示检查点增量口径的本次变更证据（文件清单 +
  // 区间 diff 命令），与 Worktree 区块「变更范围」（baseRef..HEAD 整个 change 累计口径）区分，
  // 供 reviewer 审查变更内容后按操作指引裁量是否可免全量工具检查（裁量语义由 workflow 配置单源承载，
  // 此处仅渲染事实证据）。仅 verify_tool + reviewer-tool + 已预计算变更检测结果（hasNonDocChange=true）
  // 时渲染；分支①②提前返回、toolChanges 缺省路径不经过此处，不误伤其他 agent/step。
  if (step?.id === "verify_tool" && agentToReviewLayer(ctxAgent) === "tool" && toolChanges?.hasNonDocChange) {
    lines.push(...renderToolChangesEvidence(item, tg, toolChanges))
  }
  lines.push(...renderAgentSummaries(readAgentSummaries(item), ctxAgent))
  lines.push(...renderStepContext(item, step, ctxAgent, state, exemptionCtx))
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
  // 通用指引（common.instructions）→ step 专属指引（step.instructions）合并渲染为编号步骤
  for (const instruction of common?.instructions ?? []) {
    lines.push(`${n++}. ${interpolateText(instruction, stepCtx)}`)
  }
  for (const instruction of step?.instructions ?? []) {
    lines.push(`${n++}. ${interpolateText(instruction, stepCtx)}`)
  }
  lines.push(`${n++}. 全部完成 → commit → \`opx_agent_submit({ step_id: "${rec.stepId}", verdict: "passed" })\``)
  lines.push(`${n++}. 遇阻塞无法继续 → \`opx_agent_submit({ step_id: "${rec.stepId}", verdict: "failed" })\``)
  lines.push("")
  return lines.join("\n")
}

/** step.id → 上下文渲染类型映射：verify_* 与 review_* 语义一一对应，渲染路由由 step.id 推导。 */
type StepContextKind = "analyze" | "implement" | "review_tool" | "review_task" | "review_quality" | "review_cleanup"

const STEP_ID_TO_CONTEXT_KIND: Record<string, StepContextKind> = {
  analyze: "analyze",
  implement: "implement",
  verify_tool: "review_tool",
  verify_task: "review_task",
  verify_quality: "review_quality",
  verify_cleanup: "review_cleanup",
}

/** step.id 推导上下文渲染类型，未命中返回 undefined（优雅降级不渲染该区块）。 */
function stepContextKind(stepId: string): StepContextKind | undefined {
  return STEP_ID_TO_CONTEXT_KIND[stepId]
}

/** 按 step 渲染动态上下文：由 step.id 推导渲染类型（未命中优雅降级返回空数组）。 */
function renderStepContext(item: WorkItem, step: StepConfig | null, ctxAgent: string, state: OrchestrateState, exemptionCtx?: ExemptionHintCtx): string[] {
  if (!step) return []
  const lines: string[] = []
  switch (stepContextKind(step.id)) {
    case "analyze":
      lines.push(...renderAnalyzeMode(state))
      lines.push(...renderAnalyzeBlockers(item))
      break
    case "implement":
      lines.push(...renderDeveloperChildren(item, ctxAgent, exemptionCtx))
      break
    case "review_tool":
      lines.push(...renderToolChildren(item, ctxAgent, exemptionCtx))
      break
    case "review_task":
      lines.push(...renderTaskChildren(item, ctxAgent, exemptionCtx))
      break
    case "review_quality":
      lines.push(...renderQualityChildren(item, ctxAgent, exemptionCtx))
      break
    case "review_cleanup":
      lines.push(...renderCleanupChildren(item, ctxAgent, exemptionCtx))
      break
  }
  return lines
}

/** step 语义字段渲染：constraints（common.constraints 与 step.constraints 合并，经占位符插值注入动态值，缺值保留原文）。 */
function renderStepSemantics(step: StepConfig | null, common: WorkflowCommon | undefined, ctx: Record<string, string>): string[] {
  if (!step) return []
  const lines: string[] = []
  const constraints = [...(common?.constraints ?? []), ...(step.constraints ?? [])]
  if (constraints.length > 0) {
    lines.push("## 约束", "")
    for (const c of constraints) lines.push(`- ${interpolateText(c, ctx)}`)
    lines.push("")
  }
  return lines
}

// ─── children / blockers 渲染 ───

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

/** analyze step：确认模式渲染（有人值守/无人值守），架构师据此判断直接向用户确认还是自行裁决。 */
function renderAnalyzeMode(state: OrchestrateState): string[] {
  const unattended = state.unattended === true
  return [
    "## 确认模式",
    "",
    unattended
      ? "- 当前：**无人值守**——不向用户提问，自行选择最优解继续"
      : "- 当前：**有人值守**——可直接向用户确认（需用户拍板时）",
    "",
  ]
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
    lines.push("> 存在未解决 blocker：analyze step 无法以 passed 提交。请先经 blocker_updates 逐条置 resolved（user_response 填确认/裁决结论）后再提交。", "")
  }
  return lines
}

/** implement step：developer 待修复 children（仅 todo 态：review 态由对应 reviewer 复核、豁免申请走待裁定区块）。 */
function renderDeveloperChildren(item: WorkItem, ctxAgent: string, exemptionCtx?: ExemptionHintCtx): string[] {
  const lines: string[] = []
  // 仅 issue child 进入修复清单（task child 不得混入 issue 渲染）
  const toFix = issueChildrenOf(item).filter((c) => isAgentOwnedIssue(c, ctxAgent))
  if (toFix.length === 0) return lines
  renderTodoFixBlocks(lines, toFix, exemptionCtx)
  const highRefix = toFix.filter((c) => typeof c.metadata["refix_count"] === "number" && (c.metadata["refix_count"] as number) >= 2)
  if (highRefix.length > 0) {
    lines.push("## ⚠️ 修复多次未过的 issue", "")
    for (const c of highRefix) {
      const id = c.externalId ?? c.id.replace(/^issue:/, "")
      lines.push(`- Issue #${id}（已 ${c.metadata["refix_count"]} 次修复未过）`)
    }
    lines.push("")
  }
  return lines
}

/** 调用者可裁定的豁免申请（谁提谁裁定）：tool 层由报源反推层命中 tool。 */
function isToolAdjudicable(child: WorkItem): boolean {
  return child.metadata[EXEMPT_REQUEST_KEY] !== undefined && agentToReviewLayer(readIssueSource(child)) === "tool"
}

/** 调用者可裁定的豁免申请（谁提谁裁定）：task 层由报源反推层命中 task。 */
function isTaskAdjudicable(child: WorkItem): boolean {
  return child.metadata[EXEMPT_REQUEST_KEY] !== undefined && agentToReviewLayer(readIssueSource(child)) === "task"
}

/** 调用者可裁定的豁免申请（谁提谁裁定）：quality 层报源维度等于调用者维度。 */
function isQualityAdjudicable(child: WorkItem, dimension: Dimension | undefined): boolean {
  if (child.metadata[EXEMPT_REQUEST_KEY] === undefined || !dimension) return false
  return agentToReviewDimension(readIssueSource(child) ?? "") === dimension
}

/** blocked 视图待裁定豁免判定：按当前 step 层路由到「谁提谁裁定」判定（tool/task 按报源层、quality 按报源维度）。
 *  与 isAgentOwnedIssue 互补：带 exempt_request 标记的 review 态项被主区块排除（isAgentOwnedIssue 返回 false），
 *  但仍是本层调用者可裁定的豁免申请（blocked 补交路径，blockedSupplementAgents 据此派发报源 reviewer）。 */
function isAdjudicableExempt(child: WorkItem, layer: string, ctxAgent: string): boolean {
  if (layer === "quality") return isQualityAdjudicable(child, agentToDimension(ctxAgent))
  if (layer === "tool") return isToolAdjudicable(child)
  if (layer === "task") return isTaskAdjudicable(child)
  return false
}

/** issue 主区块归属判定（单一事实源）：某 agent 该看到哪些 issue。
 *  - developer（implement step）：仅 todo 态（排除已交复核的 review 态与豁免申请 exempt_request）
 *  - reviewer-tool / reviewer-task（verify_tool / verify_task step）：仅本层报源（sourcePhase）的 review 态
 *  - reviewer-{dim}（verify_quality step）：quality 报源且报源维度与调用者维度一致，仅 review 态
 * 层归属一律经 resolveChildIssueFields(sourcePhase) 推导（内部含 source_phase 历史兜底），不裸用报源反推。
 * exempt_request issue 归「待裁定」区块管，主区块收紧为 review-only 后天然不重复展示。 */
function isAgentOwnedIssue(child: WorkItem, ctxAgent: string): boolean {
  const f = resolveChildIssueFields(child)
  const layer = agentToReviewLayer(ctxAgent)
  if (!layer) {
    return child.phase === "todo" && child.metadata[EXEMPT_REQUEST_KEY] === undefined
  }
  // 待裁定豁免项（exempt_request 标记）归「待裁定」区块管：即使已进入 review 态也排除出主区块，
  // 避免与待裁定区块重复展示；recheck 复核带标记项亦被工具层守卫拒绝（须走 exempt_adjudications 裁定）。
  if (child.phase !== "review" || child.metadata[EXEMPT_REQUEST_KEY] !== undefined) return false
  if (f.sourcePhase !== layer) return false
  if (layer === "quality") {
    const dim = agentToReviewDimension(ctxAgent)
    if (!dim) return false
    return agentToReviewDimension(readIssueSource(child) ?? "") === dim
  }
  return true
}

/** verify_tool 的 reviewer-tool 视角 children 收敛（单一事实源）：active=本层待复核主区块、
 *  pending=本层待裁定豁免，二者口径均不分 severity（与 renderBlockedAdjudicationBlock 一致）。
 *  三分支判定（A4）与 renderToolChildren 共用本函数，避免口径分叉。 */
function toolPendingChildren(item: WorkItem, ctxAgent: string): { active: WorkItem[]; pending: WorkItem[] } {
  const issues = issueChildrenOf(item)
  return {
    active: issues.filter((c) => isAgentOwnedIssue(c, ctxAgent)),
    pending: issues.filter((c) => isToolAdjudicable(c)),
  }
}

/** verify_tool step：reviewer-tool 视角本层报源 review 态 issue + 调用者可裁定的豁免申请（待裁定）。 */
function renderToolChildren(item: WorkItem, ctxAgent: string, exemptionCtx?: ExemptionHintCtx): string[] {
  const { active, pending } = toolPendingChildren(item, ctxAgent)
  const lines: string[] = []
  lines.push(...renderChildrenSection("Issue (待复核)", active, exemptionCtx))
  lines.push(...renderChildrenSection("Issue (待裁定是否可豁免)", pending, exemptionCtx))
  return lines
}

/** verify_tool 分支③（全量路径）证据区块：检查点增量口径的本次变更证据（文件清单 + 区间 diff 命令）。
 *  有检查点时标注「本次为自上次工具检查（checkpoint..HEAD）增量区间」，与 Worktree 区块「变更范围」
 *  （baseRef..HEAD 整个 change 累计口径）区分；无检查点（首次进入）时标注基线兜底口径，与变更范围一致；
 *  无检查点亦无基线基准时不渲染 diff 命令（无法界定区间）。仅渲染事实证据，不做变更性质判定——
 *  裁量语义由 workflow 配置操作指引单源承载。 */
function renderToolChangesEvidence(item: WorkItem, tg: TaskGroupState, toolChanges: DetectChangesResult): string[] {
  const checkpoint =
    typeof item.metadata["_tool_review_checkpoint"] === "string" ? item.metadata["_tool_review_checkpoint"] : undefined
  const baseRef = tg.baseRef ?? undefined
  const rangeRef = checkpoint ?? baseRef
  const lines = ["## 本次变更证据（自上次工具检查）", ""]
  if (checkpoint) {
    lines.push(
      `- **口径**: 本次为「自上次工具检查（${checkpoint}..HEAD）」的增量区间（含已提交与未提交的非 openspec 变更）；` +
        `与上方「变更范围」（${baseRef ?? "(无)"}..HEAD 整个 change 累计口径）不同`,
      "",
    )
  } else if (baseRef) {
    lines.push(
      `- **口径**: 本次区间以基线（${baseRef}..HEAD）兜底，与上方「变更范围」一致（首次进入，无上次工具检查记录；` +
        "含已提交与未提交的非 openspec 变更）",
      "",
    )
  } else {
    lines.push("- **口径**: 无检查点且无基线基准，无法界定已提交变更区间；本次变更仅按检出文件与未提交变更提示", "")
  }
  if (toolChanges.files.length > 0) {
    lines.push("- **变更文件清单**:", "")
    for (const f of toolChanges.files) lines.push(`  - \`${f}\``)
    lines.push("")
  } else {
    lines.push("- **变更文件清单**: （本区间未检出非 openspec 变更文件）", "")
  }
  if (rangeRef) {
    lines.push(`- **查看本次区间 diff**: \`git -C ${tg.worktreePath} diff ${rangeRef}..HEAD\``)
    lines.push("  - 该命令仅覆盖已提交区间；若存在未提交变更，另用 `git status` / `git diff` 查看工作区改动")
    lines.push("")
  }
  lines.push("")
  return lines
}

/** verify_tool 三分支①（直提）：自上次工具检查后无代码/配置变更且本层无待复核/待裁定项。
 *  替换式最小视图：不渲染 worktree/变更范围区块（避免与既有 baseRef..HEAD 累计口径提示冲突），
 *  文案只给结论，不展示检查点 hash。 */
function renderToolDirectSubmit(exemptedHits?: number): string {
  const lines = [
    "# ✅ 当前轮到你执行",
    "",
    "自上次工具检查后，worktree 无代码/配置变更（仅 openspec 文档变更或无变更），本层亦无待复核/待裁定 issue。",
    "",
  ]
  if ((exemptedHits ?? 0) > 0) {
    lines.push(
      `> **存量豁免提示**：本 change 存在 ${exemptedHits} 个命中项目级跨 change 豁免清单的存量问题（已按 Info 处理，不阻塞、无需重复豁免）。`,
      "",
    )
  }
  lines.push(
    "无需运行全量工具检查。",
    "",
    "## 操作指引",
    "",
    "1. 提交前须申报本轮必做清单处理结果：以一条 `step` 名首段为 `no_change` 的 validation_steps 条目声明本轮整体豁免必做清单（completed=false，并附结构化 skip_reason 注明判定依据），或按已加载质量门 skill 必做清单逐项申报（completed=true 附执行结果；无法执行项置 completed=false + 结构化 skip_reason）",
    `2. 结构化 skip_reason 格式：\`${SKIP_REASON_FORMAT}\``,
    `3. 调用 \`opx_agent_submit({ step_id: "verify_tool", verdict: "passed", validation_steps: <必做清单申报结果> })\` 提交通过后结束会话。`,
    "",
  )
  return lines.join("\n")
}

/** verify_tool 三分支②（仅处理待复核项）：无代码/配置变更但有本层待复核/待裁定项 →
 *  仅复核/裁定待处理项，不跑全量工具扫描，处理完成后提交。 */
function renderToolAdjudicateOnly(item: WorkItem, rec: EngineRecommendation, ctxAgent: string, exemptedHits?: number, exemptionCtx?: ExemptionHintCtx): string {
  const lines = [
    "# ✅ 当前轮到你执行",
    "",
    "自上次工具检查后，worktree 无代码/配置变更，无需运行全量工具检查。",
    "",
  ]
  if ((exemptedHits ?? 0) > 0) {
    lines.push(
      `> **存量豁免提示**：本 change 存在 ${exemptedHits} 个命中项目级跨 change 豁免清单的存量问题（已按 Info 处理，不阻塞、无需重复豁免）。`,
      "",
    )
  }
  lines.push("仅处理以下本层待复核 / 待裁定项，处理完成后提交：", "")
  lines.push(...renderToolChildren(item, ctxAgent, exemptionCtx))
  lines.push("## 操作指引", "")
  lines.push(
    "1. 逐项复核/裁定上方各项：待复核 issue 经 `recheck_adjudications` 复核（通过置 done、不通过驳回并附驳回原因）；待裁定豁免经 `exempt_adjudications` 裁定（dismissed/rejected）",
  )
  lines.push(
    "2. 提交前须申报本轮必做清单处理结果：以一条 `step` 名首段为 `no_change` 的 validation_steps 条目声明本轮整体豁免必做清单（completed=false + 结构化 skip_reason 注明判定依据），或按已加载质量门 skill 必做清单逐项申报",
  )
  lines.push(`3. 结构化 skip_reason 格式：\`${SKIP_REASON_FORMAT}\``)
  lines.push(`4. 全部处理完成 → commit → \`opx_agent_submit({ step_id: "${rec.stepId}", verdict: "passed", validation_steps: <必做清单申报结果> })\``)
  lines.push("")
  return lines.join("\n")
}

/** verify_task step：task children 待验证列表 + task 层 issue 主区块 + 调用者可裁定的豁免申请（待裁定）。 */
function renderTaskChildren(item: WorkItem, ctxAgent: string, exemptionCtx?: ExemptionHintCtx): string[] {
  const lines: string[] = []
  const pendingTasks = readTasks(item).filter((t) => t.status === "submitted")
  if (pendingTasks.length > 0) {
    lines.push("## Task (待验证)", "")
    for (const t of pendingTasks) lines.push(renderTaskItem(t))
    lines.push("")
  }
  const issues = issueChildrenOf(item)
  const own = issues.filter((c) => isAgentOwnedIssue(c, ctxAgent))
  lines.push(...renderChildrenSection("Issue (待复核)", own, exemptionCtx))
  const pending = issues.filter((c) => isTaskAdjudicable(c))
  lines.push(...renderChildrenSection("Issue (待裁定是否可豁免)", pending, exemptionCtx))
  return lines
}

/** verify_quality step：各维度 reviewer 渲染本维度报源 review 态 issue + 本维度豁免申请（待裁定）。 */
function renderQualityChildren(item: WorkItem, ctxAgent: string, exemptionCtx?: ExemptionHintCtx): string[] {
  const dimension = agentToDimension(ctxAgent)
  if (!dimension) return []
  // task child 无 dimension 归因（resolveChildIssueFields 缺省 style），必须按 type 排除
  const issues = issueChildrenOf(item)
  const own = issues.filter((c) => isAgentOwnedIssue(c, ctxAgent))
  const lines: string[] = []
  lines.push(...renderChildrenSection("Issue (待复核)", own, exemptionCtx))
  const pending = issues.filter((c) => isQualityAdjudicable(c, dimension))
  lines.push(...renderChildrenSection("Issue (待裁定是否可豁免)", pending, exemptionCtx))
  return lines
}

/** verify_cleanup step：developer 收尾视角。
 *  - 待修复：todo 态 issue（isAgentOwnedIssue 对 developer 仅命中 todo 态且非豁免申请）
 *  - 自报待复核：报源为当前 agent（openspec-developer）的 review 态 issue——收尾阶段自报自裁，
 *    经 recheck_adjudications 自行复核收敛（isAgentOwnedIssue 只命中 todo 态，此处显式补充）
 *  - 自报待裁定豁免：报源为当前 agent 且带 exempt_request 标记——经 exempt_adjudications 自行裁定
 */
function renderCleanupChildren(item: WorkItem, ctxAgent: string, exemptionCtx?: ExemptionHintCtx): string[] {
  const issues = issueChildrenOf(item)
  const lines: string[] = []
  const toFix = issues.filter((c) => isAgentOwnedIssue(c, ctxAgent))
  renderTodoFixBlocks(lines, toFix, exemptionCtx)
  const ownReview = issues.filter(
    (c) => readIssueSource(c) === ctxAgent && c.phase === "review" && c.metadata[EXEMPT_REQUEST_KEY] === undefined,
  )
  lines.push(...renderChildrenSection("Issue (自报待复核 · 本 step 自行复核裁定)", ownReview, exemptionCtx))
  const ownPending = issues.filter(
    (c) => readIssueSource(c) === ctxAgent && c.metadata[EXEMPT_REQUEST_KEY] !== undefined,
  )
  lines.push(...renderChildrenSection("Issue (自报豁免申请 · 待自行裁定)", ownPending, exemptionCtx))
  return lines
}

/** 调用者 agent → 审查维度（DIMENSION_AGENT_MAP 反查）。 */
function agentToDimension(agent: string): Dimension | undefined {
  return agentToReviewDimension(agent)
}

/** 渲染 children 区块：标题 + 逐条列表，空列表返回空数组。 */
function renderChildrenSection(title: string, children: WorkItem[], exemptionCtx?: ExemptionHintCtx): string[] {
  if (children.length === 0) return []
  const lines = [`## ${title}`, ""]
  for (const c of children) lines.push(renderChildIssue(c, exemptionCtx))
  lines.push("")
  return lines
}

/** 待修复 issue 区块渲染（implement 与 verify_cleanup 两处待修复清单共用）：blocking/info 拆分后渲染同标题区块。 */
function renderTodoFixBlocks(lines: string[], toFix: WorkItem[], exemptionCtx?: ExemptionHintCtx): void {
  const blocking = toFix.filter((c) => isBlockingSeverity(c.severity))
  const info = toFix.filter((c) => !isBlockingSeverity(c.severity))
  if (blocking.length > 0) {
    lines.push(...renderChildrenSection("Issue (待修复 · Low 及以上，必办)", blocking, exemptionCtx))
  }
  if (info.length > 0) {
    lines.push(...renderChildrenSection("Issue (待修复 · Info，建议修复，不阻塞提交)", info, exemptionCtx))
  }
}

/** 逐条 issue 的豁免相关只读提示（a：tool 层无规则名提示；b：疑似行号漂移提示）。纯渲染，不写任何状态。
 *  b 仅提示「(rule+file) 命中清单但 line 不同」的条目；已命中降级（exempted_hit 标记，
 *  即 (rule+file+line) 完全命中）的 issue 不重复提示漂移。 */
function appendExemptionHints(
  lines: string[],
  child: WorkItem,
  f: ReturnType<typeof resolveChildIssueFields>,
  exemptionCtx: ExemptionHintCtx | undefined,
): void {
  const rule = typeof child.metadata["rule"] === "string" ? child.metadata["rule"] : ""
  if (f.sourcePhase === "tool" && rule === "") {
    lines.push("  - 无规则名：豁免结论不会写入跨 change 清单，下个 change 将重新报此问题")
  }
  if (exemptionCtx && rule !== "" && f.file !== "" && child.metadata[EXEMPTED_HIT_KEY] === undefined) {
    const hitLine = exemptionCtx.ruleFileLines.get([rule, f.file].join("\u0000"))
    if (hitLine !== undefined && hitLine !== f.line) {
      lines.push(`  - 疑似行号漂移：豁免清单记录 line=${hitLine}，当前报 line=${f.line}，请核对是否同一问题`)
    }
  }
}

/** 单个 issue child 渲染（参考 views.renderIssueItem 风格，字段来自 WorkItem.metadata）。 */
function renderChildIssue(child: WorkItem, exemptionCtx?: ExemptionHintCtx): string {
  const f = resolveChildIssueFields(child)
  const id = child.externalId ?? child.id.replace(/^issue:/, "")
  const rule = typeof child.metadata["rule"] === "string" ? ` | ${child.metadata["rule"]}` : ""
  const lines = [
    `- Issue #${id}${rule ? ` | ${rule}` : ""}`,
  ]
  if (f.file) lines.push(`  - 文件：${formatFilePath(f.file, f.line)}`)
  lines.push(`  - 描述：${child.description}`)
  appendExemptionHints(lines, child, f, exemptionCtx)
  if (child.metadata[EXEMPTED_HIT_KEY] !== undefined) {
    const rule = typeof child.metadata[EXEMPTED_HIT_KEY] === "string" ? child.metadata[EXEMPTED_HIT_KEY] : ""
    lines.push(`  - ⚠️ 命中项目级豁免清单${rule ? `（rule=${rule}）` : ""}的存量问题，已按 Info 处理，无需重复豁免`)
  }
  if (typeof child.metadata["suggestion"] === "string") lines.push(`  - 建议：${child.metadata["suggestion"]}`)
  if (typeof child.metadata["reject_reason"] === "string") lines.push(`  - 驳回原因：${child.metadata["reject_reason"]}`)
  if (typeof child.metadata["refix_count"] === "number") lines.push(`  - 修复未过次数：${child.metadata["refix_count"]}`)
  if (child.metadata[EXEMPT_REQUEST_KEY] !== undefined) lines.push("  - 豁免申请中：等待裁定")
  return lines.join("\n")
}
