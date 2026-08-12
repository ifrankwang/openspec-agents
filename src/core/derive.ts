import type { TaskGroupState, IssueItem, OrchestrateState, Phase, QualityLayerProgress, ExecutionBoundary, BlockerItem } from "./types.ts"
import { BLOCKING_SEVERITIES } from "./constants.ts"
import type { WorkItem, WorkItemPhase } from "./workflow/types.ts"
import type { ToolContext } from "./tools/types.ts"
import { EXEMPT_REQUEST_KEY } from "./workflow/types.ts"
import { resolveChildIssueFields } from "./workflow/reset.ts"
import { taskListOf, issueChildrenOf } from "./task-children.ts"

export function createEmptyQualityProgress(): QualityLayerProgress {
  return {
    style: "pending",
    architecture: "pending",
    performance: "pending",
    security: "pending",
    maintainability: "pending",
  }
}

export function blockingIssues<T extends { severity: string; status?: string; sourcePhase?: string; dimension?: string }>(
  issues: T[],
  sourcePhase?: string,
  dimension?: string,
): T[] {
  return issues.filter(
    (i) =>
      (!sourcePhase || i.sourcePhase === sourcePhase) &&
      (!dimension || i.dimension === dimension) &&
      isStatusUnresolved(i.status) &&
      isBlockingIssue(i)
  )
}

export function hasBlockingIssues(issues: Array<{ severity: string; status?: string; sourcePhase?: string; dimension?: string }>, sourcePhase?: string, dimension?: string): boolean {
  return blockingIssues(issues, sourcePhase, dimension).length > 0
}

export function isBlockingIssue(i: { severity: string }): boolean {
  return (BLOCKING_SEVERITIES as readonly string[]).includes(i.severity)
}

export const ISSUE_UNRESOLVED_STATUSES = ["open", "rejected", "submitted", "exemption_requested"] as const

export function isStatusUnresolved(status?: string): boolean {
  return !status || (ISSUE_UNRESOLVED_STATUSES as readonly string[]).includes(status)
}

/** 独占工具权限校验：仅「编排视角」调用者（各 agent 主代理）可调用。 */
export function assertOrchestrator(ctx: ToolContext, toolName: string): void {
  if (!ctx.orchestrator) {
    throw new Error(`工具 "${toolName}" 仅限编排者（主代理）调用，当前调用者为 "${ctx.agent}"。`)
  }
}

export function assertAgent(agent: string, toolName: string, allowedAgents: string[]): void {
  if (!allowedAgents.includes(agent)) {
    throw new Error(`工具 "${toolName}" 仅限 [${allowedAgents.join(", ")}] 调用，当前调用者为 "${agent}"。`)
  }
}

export function findTaskGroup(state: OrchestrateState, id: string): TaskGroupState {
  const item = state.workItems.find((w) => w.id === `task:${id}`)
  if (!item) throw new Error(`任务组 "${id}" 不在任务清单中。`)
  return taskGroupFromWorkItem(item)
}

// ─── 单轨只读投影：workItems（事实源）→ TaskGroupState（旧流工具/视图读侧兼容）───

function childPhaseToIssueStatus(phase: WorkItemPhase): IssueItem["status"] {
  switch (phase) {
    case "done": return "verified"
    case "cancelled": return "exempted"
    case "review": return "submitted"
    default: return "open"
  }
}

/** child → IssueItem 投影（旧流工具/视图读侧兼容，children 为事实源）。 */
function projectIssueFromChild(child: WorkItem): IssueItem {
  const f = resolveChildIssueFields(child)
  const baseStatus = childPhaseToIssueStatus(child.phase)
  const hasExemptRequest = child.metadata[EXEMPT_REQUEST_KEY] !== undefined
  return {
    id: child.externalId ?? child.id.replace(/^issue:/, ""),
    dimension: f.dimension,
    sourcePhase: f.sourcePhase,
    severity: child.severity ?? "Info",
    file: f.file,
    line: f.line,
    description: child.description,
    suggestion: typeof child.metadata["suggestion"] === "string" ? child.metadata["suggestion"] : "",
    // 待裁定豁免项（exempt_request 标记）无条件投影 exemption_requested：申请豁免的 issue 已进入
    // review（待裁定）态，baseStatus 为 submitted，若限定 open 态会丢失豁免申请语义（被误标为待复核）。
    status: hasExemptRequest ? "exemption_requested" : baseStatus,
    refixCount: typeof child.metadata["refix_count"] === "number" ? child.metadata["refix_count"] : 0,
    rootCauseGuess: typeof child.metadata["root_cause_guess"] === "string" ? child.metadata["root_cause_guess"] : null,
    exemptReason: typeof child.metadata["exempt_reason"] === "string" ? child.metadata["exempt_reason"] : null,
    rejectReason: typeof child.metadata["reject_reason"] === "string" ? child.metadata["reject_reason"] : null,
    rule: typeof child.metadata["rule"] === "string" ? child.metadata["rule"] : undefined,
  }
}

/** WorkItem phase → 旧 tg.status（投影用；done 归 review 待收尾，cancelled 归 completed）。 */
function workItemPhaseToTaskGroupStatus(phase: WorkItemPhase): Phase {
  switch (phase) {
    case "todo": return "task_analysis"
    case "in_progress": return "dev_impl"
    case "review":
    case "done": return "review"
    default: return "completed"
  }
}

/**
 * workItems（单轨事实源）→ TaskGroupState 只读投影。
 * 供旧流工具（arch_submit 等）与旧视图读侧兼容：字段全部由 WorkItem.metadata/children 派生，
 * 变更不写回（单轨下 workItems 为唯一事实源）。reviews/phases 等旧结构无对应新流数据时给空值。
 */
export function taskGroupFromWorkItem(item: WorkItem): TaskGroupState {
  const m = item.metadata
  const tasks = taskListOf(item)
  return {
    id: item.externalId ?? item.id.replace(/^task:/, ""),
    name: typeof m["name"] === "string" ? m["name"] : item.title,
    taskCount: typeof m["task_count"] === "number" ? m["task_count"] : tasks.length,
    worktreePath: typeof m["worktree_path"] === "string" ? m["worktree_path"] : null,
    branchName: typeof m["branch_name"] === "string" ? m["branch_name"] : null,
    baseRef: typeof m["base_ref"] === "string" ? m["base_ref"] : null,
    executionBoundary: (m["execution_boundary"] as ExecutionBoundary) ?? null,
    relevantSpecs: Array.isArray(m["relevant_specs"]) ? (m["relevant_specs"] as string[]) : [],
    status: workItemPhaseToTaskGroupStatus(item.phase),
    phases: {
      architect_review: { completed: false },
      review: {
        retryCount: 0,
        lastResolvedRetryCount: 0,
        tool: { completed: false },
        task: { completed: false },
        quality: { progress: createEmptyQualityProgress() },
      },
    },
    tasks,
    issues: issueChildrenOf(item).map(projectIssueFromChild),
    blockers: Array.isArray(m["blockers"]) ? (m["blockers"] as BlockerItem[]) : [],
    agentSummaries: typeof m["agent_summaries"] === "object" ? (m["agent_summaries"] as Record<string, string>) : undefined,
  }
}
