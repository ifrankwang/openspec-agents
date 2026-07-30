import path from "path"
import { mkdirSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import type { OrchestrateState } from "./types.js"
import { STATE_DIR_NAME, STATE_SUBDIR_NAME } from "./constants.js"
import { discoverRepoRoot } from "./git.js"

export function getStateDir(worktree: string): string {
  return path.join(worktree, STATE_DIR_NAME, STATE_SUBDIR_NAME)
}

/** Worktree 内用于存储 changeId/taskGroupId 指针的上下文文件（相对于 worktree 根） */
export const WORKTREE_CONTEXT_FILE = ".opencode/.orchestrate_state/context.json"

/**
 * 从 worktree 中读取上下文指针（changeId + taskGroupId）。
 * 文件不存在时返回 null。
 */
export async function readContextFromWorktree(worktreePath: string): Promise<{ changeId: string; taskGroupId: string } | null> {
  const fp = path.join(worktreePath, WORKTREE_CONTEXT_FILE)
  try {
    const raw = await readFile(fp, "utf-8")
    return JSON.parse(raw) as { changeId: string; taskGroupId: string }
  } catch {
    return null
  }
}

/**
 * 向 worktree 写入上下文指针（changeId + taskGroupId）。
 * 自动创建所需目录。
 */
export async function writeContextToWorktree(worktreePath: string, changeId: string, taskGroupId: string): Promise<void> {
  const dir = path.dirname(path.join(worktreePath, WORKTREE_CONTEXT_FILE))
  mkdirSync(dir, { recursive: true })
  await writeFile(path.join(worktreePath, WORKTREE_CONTEXT_FILE), JSON.stringify({ changeId, taskGroupId }, null, 2))
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
  // 检测是否为 git worktree（.git 是文件）还是主仓库根（.git 是目录）
  const gitPath = path.join(worktree, ".git")
  try {
    const gitStat = statSync(gitPath)
    if (gitStat.isFile()) {
      // Worktree 模式：读取 context.json 获取 changeId，通过 discoverRepoRoot 推导主仓库路径，
      // 再从主仓库加载 state
      const ctx = await readContextFromWorktree(worktree)
      if (!ctx) return null
      const repoRoot = await discoverRepoRoot(worktree)
      return readStateByChangeId(repoRoot, ctx.changeId)
    }
    // .git 是目录 → 主仓库根模式，走现有逻辑
  } catch {
    // .git 不存在，走现有逻辑（可能返回 null）
  }

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
