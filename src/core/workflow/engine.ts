import type {
  WorkItem,
  WorkItemPhase,
  Verdict,
  StepConfig,
  StepAdjudication,
} from "./types.js"
import { WORK_ITEM_PHASES, BLOCKING_SEVERITIES, stepAgentIds, EXEMPT_REQUEST_KEY } from "./types.js"
import type { LoadedWorkflow } from "./loader.js"
import { tagKey } from "./types.js"
import { reviewLayerFromMetadata, readIssueSource } from "../constants.js"

const TERMINAL_PHASES: WorkItemPhase[] = ["done", "cancelled"]

/** review 三个验证 step → 其可裁定的 issue 报源层（层感知门禁归因依据）。 */
export const REVIEW_STEP_TO_LAYER: Record<string, "tool" | "task" | "quality"> = {
  verify_tool: "tool",
  verify_task: "task",
  verify_quality: "quality",
}

/** 读取 issue child 的报源层（source 反推，source_phase 仅作历史兜底，缺省 tool）。 */
function childSourcePhase(child: WorkItem): "tool" | "task" | "quality" {
  return reviewLayerFromMetadata(child)
}

export function isTerminalPhase(phase: WorkItemPhase): boolean {
  return phase === "done" || phase === "cancelled"
}

export function isBlockingSeverity(severity: string | undefined): boolean {
  return severity !== undefined && (BLOCKING_SEVERITIES as readonly string[]).includes(severity)
}

export function isInfoSeverity(severity: string | undefined): boolean {
  return severity === "Info"
}

export function readInternalCount(item: WorkItem, key: string): number {
  const v = item.metadata[key]
  return typeof v === "number" ? v : 0
}

export function setInternalCount(item: WorkItem, key: string, value: number): void {
  item.metadata[key] = value
}

export function createInitialWorkItem(input: {
  id: string
  source: string
  externalId?: string
  type: "task" | "issue"
  title: string
  description: string
  labels?: string[]
  severity?: WorkItem["severity"]
}): WorkItem {
  return {
    id: input.id,
    source: input.source,
    externalId: input.externalId,
    type: input.type,
    title: input.title,
    description: input.description,
    phase: "todo",
    suspended: false,
    currentStep: null,
    tags: {},
    metadata: {},
    children: [],
    labels: input.labels ?? [],
    severity: input.severity,
  }
}

export function effectiveMaxRetries(workflow: LoadedWorkflow, step: StepConfig): number {
  return step.max_retries ?? workflow.max_retries
}

export function resolveCurrentStep(
  item: WorkItem,
  workflow: LoadedWorkflow,
): { step: StepConfig; phaseName: WorkItemPhase } | null {
  if (item.currentStep) {
    const entry = workflow.stepMap.get(item.currentStep)
    if (entry) return { step: entry.step, phaseName: entry.phase.name }
    return null
  }
  for (const phase of workflow.phases) {
    if (phase.name === item.phase && phase.steps.length > 0) {
      return { step: phase.steps[0], phaseName: phase.name }
    }
  }
  return null
}

/**
 * phase↔step 归属一致性判定：currentStep 非空时，其配置归属 phase 与 item.phase 错位视为状态异常。
 * - currentStep 为 null（todo 初始态 / 终态）恒为 false，不误报；
 * - currentStep 指向未声明 step（resolveCurrentStep 返 null）视为 true（安全侧，宁拒勿放）。
 * 正常一致态（各写入点原子一致）恒返回 false。
 */
export function phaseStepMismatch(item: WorkItem, workflow: LoadedWorkflow): boolean {
  if (item.currentStep === null) return false
  const current = resolveCurrentStep(item, workflow)
  if (!current) return true
  return current.phaseName !== item.phase
}

export function getStepVerdict(item: WorkItem, stepId: string, agentKey: string): Verdict {
  return item.tags[tagKey(stepId, agentKey)] ?? "pending"
}

/** 存在在途豁免申请（issue 带 exempt_request 标记且未终态）的报源 agent 集合。
 *  豁免申请由报源 reviewer 裁定（谁提谁裁定）：维度名下有未裁定豁免申请时必须被唤起履行裁定权（D1），
 *  且该维度不得被「issue 全终态 → 翻 passed」自愈误翻（D2 前提排除）。
 *  终态 issue 上的残留标记视为已裁定（adjudicateExempt 裁定即删标记），不计入在途。 */
export function agentsWithPendingExempt(item: WorkItem): string[] {
  const agents = new Set<string>()
  for (const child of item.children) {
    if (child.metadata[EXEMPT_REQUEST_KEY] === undefined) continue
    if (isTerminalPhase(child.phase)) continue
    const source = readIssueSource(child)
    if (source) agents.add(source)
  }
  return [...agents]
}

/** 限定到 step.agents 的在途豁免申请报源（recommendAgents 多 agent 分支唤起用）。 */
export function stepAgentsWithPendingExempt(item: WorkItem, step: StepConfig): string[] {
  const stepAgentSet = new Set(stepAgentIds(step))
  return agentsWithPendingExempt(item).filter((a) => stepAgentSet.has(a))
}

/** D2 维度翻盘前提：agent 名下存在 blocking 级 issue 且全部终态（done/cancelled）、无在途豁免申请。
 *  不自动取消/裁定 issue（谁提谁裁定不变），仅收敛维度结论。报源维度归因按 source 反推
 *  （谁提谁裁定：维度 verdict 只反映其自身报源 issue 的状态）。
 *  要求「至少一个 blocking issue」而非空集全称：failed 维度名下必有其报的 blocking issue
 *  （verify_quality failed 提交由 assertFailedHasReason 强制理由），空集是合成/异常态，
 *  保持 failed 交由聚合自愈重派收敛，不做翻盘。 */
function agentBlockingResolved(item: WorkItem, agent: string): boolean {
  if (agentsWithPendingExempt(item).includes(agent)) return false
  const owned = item.children.filter(
    (c) => c.type === "issue" && readIssueSource(c) === agent && isBlockingSeverity(c.severity),
  )
  if (owned.length === 0) return false
  return owned.every((c) => isTerminalPhase(c.phase))
}

export function adjudicateStep(item: WorkItem, step: StepConfig): StepAdjudication {
  const verdicts = step.agents.map((agent) => {
    const v = getStepVerdict(item, step.id, agent.id)
    // D2：仅多 agent step（verify_quality 5 维并行）做维度翻盘——维度 failed 但名下 blocking issue
    // 全部终态且无在途豁免申请时视为 passed，打破「failed 且无待办」的不可收敛死状态。
    // 单 agent step 不翻盘：failed 维度由 recommendAgents 单 agent 分支重派重提收敛，翻盘会使
    // 已提交的 step 呈现 passed 却无后续提交触发推进，造成新的静默死锁。
    if (v === "failed" && step.agents.length > 1 && agentBlockingResolved(item, agent.id)) return "passed"
    return v
  })
  if (verdicts.length > 0 && verdicts.every((v) => v === "passed")) return "passed"
  if (verdicts.some((v) => v === "failed")) return "failed"
  return "pending"
}

export function recommendAgents(item: WorkItem, step: StepConfig): string[] {
  if (step.always_run) return stepAgentIds(step)
  // 多 agent step（verify_quality 5 维并行）：
  // - 存在 pending → 聚合等待期仅重派 pending（已 failed 维度不重复分派，避免单维失败过早重派）；
  //   D1：维度名下有在途豁免申请（报源 reviewer 尚未裁定）时必须一并唤起——「谁提谁裁定」要求
  //   报源 reviewer 履行裁定权，否则豁免申请滞留、维度恒 failed 且永不重派（聚合等待期死锁）。
  // - 无任何 pending → 引擎级自愈：回退返回 failed 维度（failed tag 残留如历史 state
  //   归因无法反推到对应维导致的重派，静默死锁转为可见循环并被既有机制收敛；语义与 main 分支非 passed 全重派收敛）。
  //   该分支已覆盖 failed 维（含带在途豁免申请的 failed 维），无需再叠加 D1。
  if (step.agents.length > 1) {
    const pending = step.agents.filter((agent) => getStepVerdict(item, step.id, agent.id) === "pending")
    if (pending.length > 0) {
      const exemptPending = stepAgentsWithPendingExempt(item, step)
      const dispatch = new Set(pending.map((a) => a.id))
      for (const id of exemptPending) dispatch.add(id)
      return [...dispatch]
    }
    return step.agents.filter((agent) => getStepVerdict(item, step.id, agent.id) === "failed").map((a) => a.id)
  }
  // 单 agent step：返回非 passed 的 agent（analyze 同 phase 回退不清 tag，必须返回 failed 的 architect 重审）。
  return step.agents.filter((agent) => getStepVerdict(item, step.id, agent.id) !== "passed").map((a) => a.id)
}

export function applyAgentVerdict(item: WorkItem, stepId: string, agentKey: string, verdict: Verdict): void {
  item.tags[tagKey(stepId, agentKey)] = verdict
}

export function clearStepTags(item: WorkItem, stepId: string): void {
  for (const key of Object.keys(item.tags)) {
    if (key.startsWith(`${stepId}:`)) delete item.tags[key]
  }
}

export function stepCanPass(item: WorkItem, step: StepConfig): boolean {
  if (adjudicateStep(item, step) !== "passed") return false
  const blockers = item.children.filter((child) => isBlockingSeverity(child.severity))
  if (step.id === "implement") {
    // implement 门禁 carve-out：review 态 blocking issue 已由 dev 提交进入待复核（等待对应 reviewer 裁定），
    // 不阻塞 dev 提交推进（防 dev 死锁在 implement）；其余 blocking issue 仍须终态。
    return blockers.every((child) => child.phase === "review" || isTerminalPhase(child.phase))
  }
  const layer = REVIEW_STEP_TO_LAYER[step.id]
  if (layer) {
    // 层感知门禁 carve-out：verify_tool/verify_task/verify_quality 仅要求本层可裁定的 blocking issue 为终态
    // （防止末位提交时本层未复核 issue 假收尾），其他层 review 态 issue 不阻塞本 step。
    return blockers.every((child) => childSourcePhase(child) !== layer || isTerminalPhase(child.phase))
  }
  return blockers.every((child) => isTerminalPhase(child.phase))
}

export function phaseStepsAllPassed(item: WorkItem, workflow: LoadedWorkflow, phaseName: WorkItemPhase): boolean {
  const phase = workflow.phases.find((p) => p.name === phaseName)
  if (!phase || phase.steps.length === 0) return false
  return phase.steps.every((step) => adjudicateStep(item, step) === "passed")
}

export function childReachedPhase(child: WorkItem, targetPhase: WorkItemPhase): boolean {
  if (isTerminalPhase(child.phase)) return true
  const targetIdx = WORK_ITEM_PHASES.indexOf(targetPhase)
  const childIdx = WORK_ITEM_PHASES.indexOf(child.phase)
  return childIdx >= targetIdx
}

export function forwardGatePassed(item: WorkItem, workflow: LoadedWorkflow, targetPhase: WorkItemPhase): boolean {
  if (!phaseStepsAllPassed(item, workflow, item.phase)) return false
  const issuesOk = item.children
    .filter((child) => isBlockingSeverity(child.severity))
    .every((child) => childReachedPhase(child, targetPhase))
  if (!issuesOk) return false
  // task children（子任务）仅当跨入 review 及之后（targetPhase index >= 2）才纳入检查：
  // analyze(todo)→implement(in_progress) 跨 phase 时 task child 为 todo 态，纳入会全流程死锁。
  if (phaseOrderIndex(targetPhase) >= 2) {
    const tasksOk = item.children
      .filter((child) => child.type === "task")
      .every((child) => childReachedPhase(child, targetPhase))
    if (!tasksOk) return false
  }
  return true
}

export function rollbackChildren(item: WorkItem): void {
  for (const child of item.children) {
    if (isTerminalPhase(child.phase)) continue
    if (child.phase === "review") continue
    child.phase = "todo"
    child.currentStep = null
  }
}

export function hasUnresolvedChildren(item: WorkItem): boolean {
  return item.children.some((child) => {
    // Info 级 issue 不阻塞任何门禁（stepCanPass/forwardGatePassed/complete 均按 blocking 过滤），
    // 常驻不应触发检查点：仅 task child 与 Low 及以上级别 issue 参与判定。
    if (child.type === "issue" && isInfoSeverity(child.severity)) return false
    return !isTerminalPhase(child.phase)
  })
}

export function checkpointTriggered(item: WorkItem, workflow: LoadedWorkflow, step: StepConfig): boolean {
  // A1 窄短路：step 已全部通过（adjudicateStep 返回 passed，含 D2 维度翻盘）时跳过检查点判定，
  // 避免已通过的 step 在重试边界被打断；always_run 的 step 不享受短路（口径与 recommendForItem 一致）。
  if (adjudicateStep(item, step) === "passed" && !step.always_run) return false
  const retryCount = readInternalCount(item, "_retryCount")
  if (retryCount <= 0) return false
  if (retryCount % effectiveMaxRetries(workflow, step) !== 0) return false
  return hasUnresolvedChildren(item)
}

export function applyCheckpointContinue(item: WorkItem, step: StepConfig): void {
  clearStepTags(item, step.id)
  item.metadata["_checkpoint"] = false
  // 重置内部重试计数：checkpointTriggered 按 _retryCount 实时计算，continue 后若不重置，
  // 残留计数 + 未终态 children 会让检查点视图恒成立，编排无法获得下一步分派指令（死锁）。
  resetInternalRetryCount(item)
}

export function applyCheckpointGiveup(item: WorkItem, step: StepConfig): void {
  for (const child of item.children) {
    if (!isTerminalPhase(child.phase)) child.phase = "cancelled"
  }
  for (const agent of step.agents) {
    applyAgentVerdict(item, step.id, agent.id, "passed")
  }
  item.metadata["_checkpoint"] = false
  // 与 continue 对称重置：跨 step 差异化 max_retries 时，防止上一 step 残留计数污染下一 step 检查点判定。
  resetInternalRetryCount(item)
}

export function incrementRetry(item: WorkItem): void {
  setInternalCount(item, "_retryCount", readInternalCount(item, "_retryCount") + 1)
}

/** 归零内部重试计数：checkpoint 决策与 recovery 恢复后须清空残留计数，防止检查点判定死锁或跨 step 污染。 */
export function resetInternalRetryCount(item: WorkItem): void {
  setInternalCount(item, "_retryCount", 0)
}

export function suspendItem(item: WorkItem, reason: string): void {
  item.suspended = true
  item.metadata["suspend_reason"] = reason
}

export type TransitionDirection = "pass" | "fail"

export interface TransitionResult {
  advanced: boolean
  reason?: string
  target?: "done" | "halt" | string
}

function resolveStepInPhase(workflow: LoadedWorkflow, stepId: string): { step: StepConfig; phaseName: WorkItemPhase } | null {
  const entry = workflow.stepMap.get(stepId)
  if (!entry) return null
  return { step: entry.step, phaseName: entry.phase.name }
}

function phaseOrderIndex(phase: WorkItemPhase): number {
  return WORK_ITEM_PHASES.indexOf(phase)
}

/**
 * 沿当前 step 的 transition 推进状态机。
 * - done: item 进入终态（phase=done）并触发写回
 * - halt: item 置为 suspended=true 保留当前列
 * - step id:
 *   - 目标与当前同 phase：仅切换 currentStep
 *   - 目标跨 phase：正向需 phase 门禁（当前 phase 全部 step passed 且 Low+ children 达到目标 phase），反向直接迁移
 */
export function applyTransition(
  item: WorkItem,
  workflow: LoadedWorkflow,
  direction: TransitionDirection,
): TransitionResult {
  const current = resolveCurrentStep(item, workflow)
  if (!current) {
    return { advanced: false, reason: `WorkItem phase="${item.phase}" 在 workflow 中无对应 step 容器。` }
  }

  const target = direction === "pass" ? current.step.transitions.on_pass : current.step.transitions.on_fail

  if (target === "done") {
    // done 转移不走 forwardGatePassed（短路），置 done 前须显式检查 task children 全部终态
    // （未完成子任务不得收尾；issue blocking 检查已在 stepCanPass 处理）。
    const unfinishedTasks = item.children.filter((child) => child.type === "task" && !isTerminalPhase(child.phase))
    if (unfinishedTasks.length > 0) {
      return { advanced: false, reason: "存在未完成的子任务（task children 未达终态），无法进入 done。" }
    }
    item.phase = "done"
    item.currentStep = null
    return { advanced: true, target: "done" }
  }
  if (target === "halt") {
    suspendItem(item, "halt")
    return { advanced: true, target: "halt" }
  }

  const resolved = resolveStepInPhase(workflow, target)
  if (!resolved) {
    return { advanced: false, reason: `transition 目标 "${target}" 无法解析。` }
  }

  if (resolved.phaseName === item.phase) {
    item.currentStep = resolved.step.id
    return { advanced: true, target: target }
  }

  if (direction === "pass") {
    if (!forwardGatePassed(item, workflow, resolved.phaseName)) {
      return {
        advanced: false,
        reason: `跨 phase 正向推进被门禁拦截：当前 phase "${item.phase}" 未全部 step passed 或存在 Low+ children 未达到目标 phase "${resolved.phaseName}"。`,
      }
    }
    item.phase = resolved.phaseName
    item.currentStep = resolved.step.id
    return { advanced: true, target: target }
  }

  rollbackChildren(item)
  incrementRetry(item)
  // 回退目标 step 的裁决 tags 一并重置：残留 passed/failed 会让 recommendForItem 误判
  // 该 step 已裁决而不重新分派（review failed 回退 implement 时 developer passed 残留 → blocked 死锁）。
  clearStepTags(item, resolved.step.id)
  item.phase = resolved.phaseName
  item.currentStep = resolved.step.id
  return { advanced: true, target: target }
}

export function isForwardTransition(item: WorkItem, workflow: LoadedWorkflow, direction: TransitionDirection): boolean {
  const current = resolveCurrentStep(item, workflow)
  if (!current) return false
  const target = direction === "pass" ? current.step.transitions.on_pass : current.step.transitions.on_fail
  if (target === "done" || target === "halt") return false
  const resolved = resolveStepInPhase(workflow, target)
  if (!resolved) return false
  return phaseOrderIndex(resolved.phaseName) > phaseOrderIndex(item.phase)
}

/**
 * 评估当前 step 沿 on:pass 正向推进是否会被 applyTransition 拦截（只读，不修改 item）。
 * 与 applyTransition(pass) 的门禁口径一致：
 * - done 目标：task children 须全部终态（否则 applyTransition 拦截）；
 * - 跨 phase 正向目标：forwardGatePassed 须通过（否则 applyTransition 拦截）。
 * 返回拦截原因（供 blocked 视图展示），无拦截返回 undefined。
 */
function forwardAdvanceBlockReason(item: WorkItem, workflow: LoadedWorkflow, step: StepConfig): string | undefined {
  const target = step.transitions.on_pass
  if (target === "done") {
    const unfinishedTasks = item.children.filter((c) => c.type === "task" && !isTerminalPhase(c.phase))
    if (unfinishedTasks.length > 0) {
      return `存在 ${unfinishedTasks.length} 个未达终态的 task child（#${unfinishedTasks.map((c) => c.id).join("、")}），无法推进到 done。`
    }
    return undefined
  }
  if (target === "halt") return undefined
  const resolved = resolveStepInPhase(workflow, target)
  if (!resolved) return `transition 目标 "${target}" 无法解析。`
  if (resolved.phaseName === item.phase) return undefined
  if (!forwardGatePassed(item, workflow, resolved.phaseName)) {
    const notReached = item.children.filter(
      (c) => c.type === "task" && !childReachedPhase(c, resolved.phaseName)
    )
    if (notReached.length > 0) {
      return `跨 phase 正向推进被门禁拦截：目标 phase "${resolved.phaseName}" 要求全部 task child 达 ${resolved.phaseName} 态，以下 task 未达标：#${notReached.map((c) => c.id).join("、")}。`
    }
    return `跨 phase 正向推进被门禁拦截：当前 phase "${item.phase}" 未全部 step passed 或存在 Low+ children 未达到目标 phase "${resolved.phaseName}"。`
  }
  return undefined
}

/**
 * 当前 step 门禁相关阻塞 children（blocked 推导与视图诊断共用）：
 * - review 验证 step（verify_tool/verify_task/verify_quality）：层感知口径——本层可裁定的非终态 blocking issue
 *   （childSourcePhase 与 REVIEW_STEP_TO_LAYER[step.id] 一致）。非本层 review 态 issue 不阻塞本 step，故不列出。
 * - implement：镜像 stepCanPass 的 carve-out——review 态 blocking issue 已由 dev 提交进入待复核（等待对应
 *   reviewer 裁定），不阻塞 dev 提交推进，故不计入；其余非终态 blocking issue 列出。
 * - 其他非 review step：全部非终态 blocking issue。
 */
export function blockingStepChildren(item: WorkItem, step: StepConfig): WorkItem[] {
  const layer = REVIEW_STEP_TO_LAYER[step.id]
  return item.children.filter((child) => {
    if (!isBlockingSeverity(child.severity)) return false
    if (isTerminalPhase(child.phase)) return false
    if (step.id === "implement" && child.phase === "review") return false
    if (layer && childSourcePhase(child) !== layer) return false
    return true
  })
}

/**
 * blocked step 应补交裁定的 reviewer 推导（谁提谁裁定）：
 * - 带 exempt_request 标记的 child → 报源 reviewer 补交 exempt_adjudications
 * - review 态 child → 报源 reviewer 补交 recheck_adjudications
 * - todo/in_progress 等其他态 child → 不派 reviewer（补交无法解决），不加入 agents
 * 报源解析：child.metadata.source（完整 agent 名）必须属于当前 step agents，否则跳过该 child——
 * 裁定逻辑（submit.resolveAdjudicatorStepForIssue）硬性要求报源合法，非法报源派发出去提交即被拒，
 * 形成不闭合循环；报源缺失/非法一律不派 reviewer，落入空派由视图输出诊断清单引导 recovery。
 */
export function blockedSupplementAgents(item: WorkItem, step: StepConfig): string[] {
  const agents = new Set<string>()
  const stepAgentSet = new Set(stepAgentIds(step))
  for (const child of blockingStepChildren(item, step)) {
    if (child.metadata[EXEMPT_REQUEST_KEY] === undefined && child.phase !== "review") continue
    const source = readIssueSource(child)
    if (!source || !stepAgentSet.has(source)) continue
    agents.add(source)
  }
  return [...agents]
}

export interface EngineRecommendation {
  status: "recommend" | "suspended" | "checkpoint" | "blocked" | "terminal"
  stepId: string | null
  agents: string[]
  checkpoint?: { retryCount: number; effectiveMaxRetries: number }
  blockedReason?: string
  message?: string
}

/**
 * 引擎调度推荐。只读模式：不修改 item，仅返回推荐。
 * 上游（submit 工具）在调用后自行应用状态迁移。
 */
export function recommendForItem(item: WorkItem, workflow: LoadedWorkflow): EngineRecommendation {
  if (item.suspended) {
    const reason = (item.metadata["suspend_reason"] as string) || "suspended"
    return {
      status: "suspended",
      stepId: item.currentStep,
      agents: [],
      message: `WorkItem 已暂停（${reason}），跳过调度。`,
    }
  }

  const current = resolveCurrentStep(item, workflow)
  if (!current) {
    return {
      status: "blocked",
      stepId: null,
      agents: [],
      blockedReason: `WorkItem phase="${item.phase}" 在 workflow 中无对应 step 容器。`,
    }
  }

  if (checkpointTriggered(item, workflow, current.step)) {
    return {
      status: "checkpoint",
      stepId: current.step.id,
      agents: [],
      checkpoint: {
        retryCount: readInternalCount(item, "_retryCount"),
        effectiveMaxRetries: effectiveMaxRetries(workflow, current.step),
      },
    }
  }

  const adjudication = adjudicateStep(item, current.step)
  if (adjudication === "passed" && !current.step.always_run) {
    if (!stepCanPass(item, current.step)) {
      // 本层 blocking children 未终态（reviewer 漏带 recheck/豁免裁定导致）：推导应补交裁定的报源 reviewer，
      // 不再恒返回 agents=[]（否则 orchestrator 收不到"下一步分派谁"的指令，形成静默死锁）。
      // 仅 review step（verify_tool/verify_task/verify_quality）走 supplement 派生：implement 的
      // stepCanPass carve-out 已把 review 态 child 排除在阻塞之外，其 blocked 恒为待修复/豁免申请中条目，
      // 补交裁定无意义，保持 agents=[] 走诊断清单。
      const blockingChildren = blockingStepChildren(item, current.step)
      const recheckCount = blockingChildren.filter(
        (c) => c.phase === "review" && c.metadata[EXEMPT_REQUEST_KEY] === undefined,
      ).length
      const exemptCount = blockingChildren.filter((c) => c.metadata[EXEMPT_REQUEST_KEY] !== undefined).length
      const todoCount = blockingChildren.length - recheckCount - exemptCount
      const isReviewStep = REVIEW_STEP_TO_LAYER[current.step.id] !== undefined
      const agents = isReviewStep ? blockedSupplementAgents(item, current.step) : []
      const blockedReason =
        agents.length > 0
          ? `step 全部 agent 已 passed 但存在 ${blockingChildren.length} 个本层待复核/待裁定 blocking children（待复核 ${recheckCount}、豁免申请中 ${exemptCount}），需报源 reviewer 补交复核/裁定解除阻塞。`
          : todoCount > 0
            ? `step 全部 agent 已 passed 但存在 ${blockingChildren.length} 个未到终态的 blocking children（待修复 ${todoCount}、豁免申请中 ${exemptCount}），需 developer 修复后重新提交审查。`
            : `step 全部 agent 已 passed 但存在 ${blockingChildren.length} 个待复核/豁免申请中的 blocking children 且无法推导需补交的 reviewer，请核对 state 后按需调用 opx_orch_init(recovery=...) 恢复。`
      return {
        status: "blocked",
        stepId: current.step.id,
        agents,
        blockedReason,
      }
    }
    // step 全 passed 且 children 达标后仍可能被跨 phase 门禁或 done 的 task children 终态检查拦截
    // （如重复 task child / 未完成子任务）。显式返回 blocked + 原因而非 terminal，
    // 避免"step 已通过"误导造成无人再触发迁移的静默死锁。
    const gateBlock = forwardAdvanceBlockReason(item, workflow, current.step)
    if (gateBlock) {
      return {
        status: "blocked",
        stepId: current.step.id,
        agents: [],
        blockedReason: gateBlock,
      }
    }
    return {
      status: "terminal",
      stepId: current.step.id,
      agents: [],
      message: "step 已通过，沿 transitions.on_pass 推进（由 submit 工具执行状态迁移）。",
    }
  }

  const agents = recommendAgents(item, current.step)
  return {
    status: "recommend",
    stepId: current.step.id,
    agents,
  }
}
