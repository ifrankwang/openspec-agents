import type { TaskGroupState, TaskItem, IssueItem, OrchestrateState, Phase, OrchestrateStatus, ReviewDimension, DimensionVerdict, QualityLayerProgress, Phases } from "./types.js"
import { BLOCKING_SEVERITIES, MAX_RETRIES, ORCHESTRATOR_AGENT, DIMENSION_AGENT_MAP } from "./constants.js"
import { REVIEW_DIMENSIONS } from "./types.js"

export function createEmptyPhases(): Phases {
  return {
    architect_review: { completed: false },
    review: {
      retryCount: 0,
      lastResolvedRetryCount: 0,
      tool: { completed: false },
      task: { completed: false },
      quality: { progress: createEmptyQualityProgress() },
    },
  }
}

export function handleRetryCheckpoint(
  tg: TaskGroupState,
  unattended?: boolean
): { checkpoint: boolean; retryCount: number } | null {
  tg.phases.review.retryCount++
  if (unattended) {
    return { checkpoint: false, retryCount: tg.phases.review.retryCount }
  }
  const retryCount = tg.phases.review.retryCount
  if (retryCount > 0 && retryCount % MAX_RETRIES === 0) {
    return null
  }
  return { checkpoint: false, retryCount }
}

export function createEmptyQualityProgress(): QualityLayerProgress {
  return {
    style: "pending",
    architecture: "pending",
    performance: "pending",
    security: "pending",
    maintainability: "pending",
  }
}

export function deriveStatus(tg: TaskGroupState, currentTaskGroupId: string): OrchestrateStatus {
  if (tg.status === "completed") return "completed"
  if (tg.status === "task_analysis" && tg.id !== currentTaskGroupId && phasesAllEmpty(tg)) return "not_started"
  return "in_progress"
}

export function phasesAllEmpty(tg: TaskGroupState): boolean {
  const hasReviewActivity = tg.phases.review.retryCount > 0
  return !tg.phases.architect_review.completed
    && tg.status === "task_analysis"
    && tg.tasks.every((t) => t.status === "open")
    && !isReviewCompleted(tg)
    && tg.issues.length === 0
    && !hasReviewActivity
}

export function hasBlockingIssues(issues: Array<{ severity: string; status?: string; sourcePhase?: string; dimension?: string }>, sourcePhase?: string, dimension?: string): boolean {
  return issues.some(
    (i) =>
      (!sourcePhase || i.sourcePhase === sourcePhase) &&
      (!dimension || i.dimension === dimension) &&
      isStatusUnresolved(i.status) &&
      isBlockingIssue(i)
  )
}

export function isBlockingIssue(i: { severity: string }): boolean {
  return (BLOCKING_SEVERITIES as readonly string[]).includes(i.severity)
}

export const ISSUE_UNRESOLVED_STATUSES = ["open", "rejected", "submitted", "exemption_requested"] as const

export function isStatusUnresolved(status?: string): boolean {
  return !status || (ISSUE_UNRESOLVED_STATUSES as readonly string[]).includes(status)
}

export function allTasksVerified(tasks: TaskItem[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.status === "verified")
}

export function dimsWithPendingAction(tg: TaskGroupState): Set<string> {
  const dims = new Set<string>()
  for (const i of tg.issues) {
    if (i.sourcePhase === "quality" && (i.status === "submitted" || i.status === "exemption_requested")) dims.add(i.dimension)
  }
  return dims
}

export function isReviewCompleted(tg: TaskGroupState): boolean {
  return tg.phases.review.tool.completed
    && tg.phases.review.task.completed
    && REVIEW_DIMENSIONS.every(d => tg.phases.review.quality.progress[d] === "passed")
    && !hasBlockingIssues(tg.issues)
    && !tg.blockers.some((blocker) => blocker.status !== "resolved")
}

export function computeRequiredDims(tg: TaskGroupState): ReviewDimension[] {
  return REVIEW_DIMENSIONS.filter(d => tg.phases.review.quality.progress[d] !== "passed")
}

export function assertOrchestrator(agent: string, toolName: string): void {
  if (agent !== ORCHESTRATOR_AGENT) {
    throw new Error(
      `工具 "${toolName}" 仅限编排者 "${ORCHESTRATOR_AGENT}" 调用，当前调用者为 "${agent}"。`
    )
  }
}

export function assertAgent(agent: string, toolName: string, allowedAgents: string[]): void {
  if (!allowedAgents.includes(agent)) {
    throw new Error(`工具 "${toolName}" 仅限 [${allowedAgents.join(", ")}] 调用，当前调用者为 "${agent}"。`)
  }
}

export function deriveCurrentAgents(tg: TaskGroupState): string[] {
  if (tg.status === "task_analysis") return ["openspec-architect"]
  if (tg.status === "dev_impl") return tg.worktreePath && tg.baseRef ? ["openspec-developer"] : []
  if (tg.status === "review") {
    if (!tg.phases.review.tool.completed) return ["openspec-reviewer-tool"]
    if (!tg.phases.review.task.completed) return ["openspec-reviewer-task"]
    const requiredDims = computeRequiredDims(tg)
    return requiredDims.map((d) => DIMENSION_AGENT_MAP[d])
  }
  return []
}

export function assertPassWithIssues(passed: boolean, issues: Array<{ severity: string }>, toolName: string): void {
  if (passed && hasBlockingIssues(issues)) {
    throw new Error(
      `工具 "${toolName}"：报告声称 passed=true，但 issues 中包含 Low 及以上严重级别的问题。passed=true 只能带 Info 级别 issue；有 Low+ issue 时必须设 passed=false。`
    )
  }
}

export function findTaskGroup(state: OrchestrateState, id: string): TaskGroupState {
  const tg = state.taskGroups.find((g) => g.id === id)
  if (!tg) throw new Error(`任务组 "${id}" 不在任务清单中。`)
  return tg
}
