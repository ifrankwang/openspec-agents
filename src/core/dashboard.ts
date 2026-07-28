import type { OrchestrateState } from "./types.js"
import { readStateByWorktree } from "./state.js"
import { deriveStatus, isReviewCompleted } from "./derive.js"

export async function readDashboardState(worktree: string) {
  const state = await readStateByWorktree(worktree)
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
      lastFilesChanged: tg.lastFilesChanged,
      phases: tg.phases,
      tasks: tg.tasks,
      issues: tg.issues,
      blockers: tg.blockers,
    })),
  }
}
