import type { OrchestrateState } from "./types.ts"
import { readStateByWorktree, readStateByChangeId, getStateDir } from "./state.ts"
import { readdirSync, existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "path"
import type { WorkItem, WorkItemType, WorkItemPhase, Verdict } from "./workflow/types.ts"

/** 看板卡片投影：WorkItem → 前端可渲染结构。 */
export interface WorkItemCard {
  id: string
  type: WorkItemType
  title: string
  description: string
  phase: WorkItemPhase
  suspended: boolean
  suspendReason?: string
  currentStep: string | null
  labels: string[]
  source: string
  severity?: string
  agentVerdicts: Array<{ stepId: string; agentKey: string; verdict: Verdict }>
  children: Array<{ id: string; type: WorkItemType; title: string; phase: WorkItemPhase; severity?: string }>
}

/** taskGroup → 看板投影（旧三面板视图已随单轨化移除）。 */

/**
 * WorkItem → 看板卡片。
 * tags 键为 `${stepId}:${agentKey}`，拆解为可渲染的 agent 裁决数组；
 * metadata 仅暴露无下划线前缀的业务字段（suspend_reason），内部字段（_ 前缀）不泄露。
 */
function toWorkItemCard(item: WorkItem): WorkItemCard {
  const agentVerdicts = Object.entries(item.tags).map(([key, verdict]) => {
    const sep = key.indexOf(":")
    return {
      stepId: sep === -1 ? key : key.slice(0, sep),
      agentKey: sep === -1 ? key : key.slice(sep + 1),
      verdict,
    }
  })
  const suspendReason =
    typeof item.metadata["suspend_reason"] === "string" ? (item.metadata["suspend_reason"] as string) : undefined
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    description: item.description,
    phase: item.phase,
    suspended: item.suspended,
    suspendReason,
    currentStep: item.currentStep,
    labels: item.labels,
    source: item.source,
    severity: item.severity,
    agentVerdicts,
    children: item.children.map((child) => ({
      id: child.id,
      type: child.type,
      title: child.title,
      phase: child.phase,
      severity: child.severity,
    })),
  }
}

/** OrchestrateState → 看板投影（workItems 单轨 + workItemCards 5 列视图）。 */
function projectState(state: OrchestrateState) {
  return {
    active: true,
    changeId: state.changeId,
    currentTaskGroupId: state.taskGroupId,
    baseBranch: state.baseBranch,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    workItems: state.workItems,
    workItemCards: state.workItems.map(toWorkItemCard),
  }
}

export async function readDashboardState(worktree: string, changeId?: string) {
  if (changeId) {
    const state = await readStateByWorktree(worktree, changeId)
    if (!state) return null
    return projectState(state)
  }

  const stateDir = getStateDir(worktree)
  if (!existsSync(stateDir)) return null
  const files = readdirSync(stateDir).filter(f => f.endsWith(".json"))
  const results: ReturnType<typeof projectState>[] = []
  for (const f of files) {
    try {
      const raw = await readFile(path.join(stateDir, f), "utf-8")
      const state = JSON.parse(raw) as OrchestrateState
      if (!state.changeId) continue
      results.push(projectState(state))
    } catch { /* skip unreadable */ }
  }
  if (results.length === 1) return results[0]
  return results.length > 0 ? results : null
}
