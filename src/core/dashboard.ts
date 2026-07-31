import type { OrchestrateState } from "./types.js"
import { readStateByWorktree, readStateByChangeId, getStateDir } from "./state.js"
import { deriveStatus, isReviewCompleted } from "./derive.js"
import { readdirSync, existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "path"

export async function readDashboardState(worktree: string, changeId?: string) {
  if (changeId) {
    const state = await readStateByWorktree(worktree, changeId)
    if (!state) return null
    return {
      active: true,
      changeId: state.changeId,
      currentTaskGroupId: state.taskGroupId,
      baseBranch: state.baseBranch,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      taskGroups: state.taskGroups.map((tg) => ({
        id: tg.id,
        name: tg.name,
        taskCount: tg.taskCount,
        status: tg.status,
        lifecycle: deriveStatus(tg, state.taskGroupId),
        reviewCompleted: isReviewCompleted(tg),
        worktreePath: tg.worktreePath,
        branchName: tg.branchName,
        relevantSpecs: tg.relevantSpecs,
        phases: tg.phases,
        tasks: tg.tasks,
        issues: tg.issues,
        blockers: tg.blockers,
      })),
    }
  }

  const stateDir = getStateDir(worktree)
  if (!existsSync(stateDir)) return null
  const files = readdirSync(stateDir).filter(f => f.endsWith(".json"))
  const results: Array<{
    active: boolean
    changeId: string
    currentTaskGroupId: string
    baseBranch: string
    createdAt: string
    updatedAt: string
    taskGroups: Array<{
      id: string
      name: string
      taskCount: number
      status: string
      lifecycle: string
      reviewCompleted: boolean
      worktreePath: string | null
      branchName: string | null
      relevantSpecs: string[]
      phases: any
      tasks: any
      issues: any
      blockers: any
    }>
  }> = []
  for (const f of files) {
    try {
      const raw = await readFile(path.join(stateDir, f), "utf-8")
      const state = JSON.parse(raw) as OrchestrateState
      if (!state.changeId) continue
      results.push({
        active: true,
        changeId: state.changeId,
        currentTaskGroupId: state.taskGroupId,
        baseBranch: state.baseBranch,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        taskGroups: state.taskGroups.map((tg) => ({
          id: tg.id,
          name: tg.name,
          taskCount: tg.taskCount,
          status: tg.status,
          lifecycle: deriveStatus(tg, state.taskGroupId),
          reviewCompleted: isReviewCompleted(tg),
          worktreePath: tg.worktreePath,
          branchName: tg.branchName,
          relevantSpecs: tg.relevantSpecs,
          phases: tg.phases,
          tasks: tg.tasks,
          issues: tg.issues,
          blockers: tg.blockers,
        })),
      })
    } catch { /* skip unreadable */ }
  }
  if (results.length === 1) return results[0]
  return results.length > 0 ? results : null
}
