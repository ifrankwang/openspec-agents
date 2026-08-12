import type { TaskItem, TaskStatus } from "./types.ts"
import type { WorkItem, WorkItemPhase } from "./workflow/types.ts"

/**
 * 子任务（task child）共享投影助手。
 *
 * 子任务建模为 type==="task" 的 WorkItem 挂入主任务 item.children（metadata.tasks 已废弃），
 * 走统一 phase 状态机：todo（open/rejected）→ review（submitted）→ done/cancelled（终态）。
 * task child 的 id 为短数字（如 "1"、"2"），externalId 存 taskNumber（如 "1.1"）。
 */

/** 过滤 item.children 中 type==="task" 的子任务。 */
export function taskChildrenOf(item: WorkItem): WorkItem[] {
  return (item.children ?? []).filter((c) => c.type === "task")
}

/** 过滤 item.children 中 type==="issue" 的 issue child（task child 不参与 issue 渲染/归因）。 */
export function issueChildrenOf(item: WorkItem): WorkItem[] {
  return (item.children ?? []).filter((c) => c.type === "issue")
}

/** 按 id（数字字符串或 taskNumber）查 task child，未命中返回 null。 */
export function taskChildById(item: WorkItem, id: string): WorkItem | null {
  return (
    item.children.find((c) => c.type === "task" && (c.id === id || c.externalId === id)) ?? null
  )
}

/** 将 taskNumber（如 "1.1"）映射为数字 id（task child 的 externalId 存 taskNumber，id 存数字），未命中按原样返回。 */
export function normalizeTaskChildIds(rawIds: string[], item: WorkItem): string[] {
  const byNumber = new Map<string, string>()
  for (const c of taskChildrenOf(item)) {
    if (c.externalId !== undefined) byNumber.set(c.externalId, c.id)
  }
  return rawIds.map((id) => byNumber.get(id) ?? id)
}

/** task child phase → TaskStatus 反查（TaskItem 兼容投影）。 */
function phaseToTaskStatus(phase: WorkItemPhase, hasRejectReason: boolean): TaskStatus {
  switch (phase) {
    case "review": return "submitted"
    case "done":
    case "cancelled": return "verified"
    case "todo": return hasRejectReason ? "rejected" : "open"
    default: return "open"
  }
}

/** 从 task child 投影 TaskItem 兼容结构（status.ts 视图渲染与旧工具读侧使用）。 */
export function taskListOf(item: WorkItem): TaskItem[] {
  return taskChildrenOf(item).map((c) => ({
    id: c.id,
    specTrace: typeof c.metadata["specTrace"] === "string" ? c.metadata["specTrace"] : "",
    title: c.title,
    status: phaseToTaskStatus(c.phase, c.metadata["reject_reason"] !== undefined),
    taskNumber: typeof c.externalId === "string" ? c.externalId : "",
    rejectReason: typeof c.metadata["reject_reason"] === "string" ? c.metadata["reject_reason"] : null,
  }))
}
