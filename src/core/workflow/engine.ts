import type {
  WorkItem,
  WorkItemPhase,
  Verdict,
  StepConfig,
  StepAdjudication,
} from "./types.js"
import { WORK_ITEM_PHASES, BLOCKING_SEVERITIES } from "./types.js"
import type { LoadedWorkflow } from "./loader.js"
import { tagKey } from "./types.js"

const TERMINAL_PHASES: WorkItemPhase[] = ["done", "cancelled"]

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

function resolveCurrentStep(
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

export function getStepVerdict(item: WorkItem, stepId: string, agentKey: string): Verdict {
  return item.tags[tagKey(stepId, agentKey)] ?? "pending"
}

export function adjudicateStep(item: WorkItem, step: StepConfig): StepAdjudication {
  const verdicts = step.agents.map((agent) => getStepVerdict(item, step.id, agent))
  if (verdicts.length > 0 && verdicts.every((v) => v === "passed")) return "passed"
  if (verdicts.some((v) => v === "failed")) return "failed"
  return "pending"
}

export function recommendAgents(item: WorkItem, step: StepConfig): string[] {
  if (step.always_run) return [...step.agents]
  // 多 agent step（verify_quality 5 维并行）：仅返回 pending 的 agent。
  // 聚合等待期已 failed 维度不再重复分派；回退重审期 failed 维度已被 resetReviewTagsOnFix 清成 pending 自然返回。
  if (step.agents.length > 1) {
    return step.agents.filter((agent) => getStepVerdict(item, step.id, agent) === "pending")
  }
  // 单 agent step：返回非 passed 的 agent（analyze 同 phase 回退不清 tag，必须返回 failed 的 architect 重审）。
  return step.agents.filter((agent) => getStepVerdict(item, step.id, agent) !== "passed")
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
  return item.children
    .filter((child) => isBlockingSeverity(child.severity))
    .every((child) => isTerminalPhase(child.phase))
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
  return item.children.some((child) => !isTerminalPhase(child.phase))
}

export function checkpointTriggered(item: WorkItem, workflow: LoadedWorkflow, step: StepConfig): boolean {
  const retryCount = readInternalCount(item, "_retryCount")
  if (retryCount <= 0) return false
  if (retryCount % effectiveMaxRetries(workflow, step) !== 0) return false
  return hasUnresolvedChildren(item)
}

export function applyCheckpointContinue(item: WorkItem, step: StepConfig): void {
  clearStepTags(item, step.id)
  item.metadata["_checkpoint"] = false
}

export function applyCheckpointGiveup(item: WorkItem, step: StepConfig): void {
  for (const child of item.children) {
    if (!isTerminalPhase(child.phase)) child.phase = "cancelled"
  }
  for (const agent of step.agents) {
    applyAgentVerdict(item, step.id, agent, "passed")
  }
  item.metadata["_checkpoint"] = false
}

export function incrementRetry(item: WorkItem): void {
  setInternalCount(item, "_retryCount", readInternalCount(item, "_retryCount") + 1)
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
      return {
        status: "blocked",
        stepId: current.step.id,
        agents: [],
        blockedReason: "step 全部 agent 已 passed 但存在未到终态的 children，暂不沿 on:pass 推进。",
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
