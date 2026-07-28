import path from "path"
import { mkdirSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import type { OrchestrateState } from "./types.js"
import { STATE_DIR_NAME, STATE_SUBDIR_NAME } from "./constants.js"

export function getStateDir(worktree: string): string {
  return path.join(worktree, STATE_DIR_NAME, STATE_SUBDIR_NAME)
}

export function getStatePath(worktree: string, changeId: string): string {
  return path.join(getStateDir(worktree), `${changeId}.json`)
}

export function getCurrentPointerPath(worktree: string): string {
  return path.join(getStateDir(worktree), "current.json")
}

export async function readCurrentChangeId(worktree: string): Promise<string> {
  const fp = getCurrentPointerPath(worktree)
  try {
    const raw = await readFile(fp, "utf-8")
    const data = JSON.parse(raw) as { changeId: string }
    return data.changeId || ""
  } catch {
    return ""
  }
}

export async function writeCurrentChangeId(worktree: string, changeId: string): Promise<void> {
  mkdirSync(getStateDir(worktree), { recursive: true })
  await writeFile(getCurrentPointerPath(worktree), JSON.stringify({ changeId }, null, 2))
}

export async function readStateByWorktree(worktree: string): Promise<OrchestrateState | null> {
  const changeId = await readCurrentChangeId(worktree)
  if (!changeId) return null
  return readStateByChangeId(worktree, changeId)
}

export async function readStateByChangeId(worktree: string, changeId: string): Promise<OrchestrateState | null> {
  const fp = getStatePath(worktree, changeId)
  let state: OrchestrateState
  try {
    const raw = await readFile(fp, "utf-8")
    state = JSON.parse(raw) as OrchestrateState
  } catch {
    return null
  }
  const sampleGroup = state.taskGroups?.[0]
  if (sampleGroup && !('tasks' in sampleGroup)) {
    throw new Error(
      `状态文件 "${state.changeId}" 是旧版本格式，不兼容当前版本。请重新初始化编排会话（opx_orch_init）。`
    )
  }
  for (const group of state.taskGroups || []) {
    group.blockers ??= []
    for (const blocker of group.blockers) {
      if ((blocker.status as string) === "reported" || (blocker.status as string) === "ready_for_architect") {
        blocker.status = "awaiting_user"
      }
    }
    if (group.status === "task_analysis" && group.phases?.architect_review?.completed && !group.blockers.some((blocker) => blocker.status !== "resolved")) {
      group.status = "dev_impl"
    }
  }
  return state
}

export async function writeState(worktree: string, state: OrchestrateState): Promise<void> {
  mkdirSync(getStateDir(worktree), { recursive: true })
  await writeCurrentChangeId(worktree, state.changeId)
  state.updatedAt = new Date().toISOString()
  await writeFile(getStatePath(worktree, state.changeId), JSON.stringify(state, null, 2))
}
