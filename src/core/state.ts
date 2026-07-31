import path from "path"
import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import type { OrchestrateState } from "./types.js"
import { STATE_DIR_NAME, STATE_SUBDIR_NAME } from "./constants.js"
import { discoverRepoRoot } from "./git.js"

const LOCK_POLL_INTERVAL_MS = 50
const LOCK_META_FILENAME = "meta.json"
const LOCK_STALE_THRESHOLD_MS = 10000

function isWorktreePath(worktree: string): boolean {
  const gitPath = path.join(worktree, ".git")
  try {
    return statSync(gitPath).isFile()
  } catch {
    return false
  }
}

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

export async function readStateByWorktree(worktree: string, changeId?: string): Promise<OrchestrateState | null> {
  if (isWorktreePath(worktree)) {
    const ctx = await readContextFromWorktree(worktree)
    if (!ctx) return null
    const repoRoot = await discoverRepoRoot(worktree)
    return readStateByChangeId(repoRoot, ctx.changeId)
  }
  if (changeId) {
    return readStateByChangeId(worktree, changeId)
  }
  throw new Error("change_id required for non-worktree context")
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

export async function resolveStateRoot(worktree: string): Promise<string> {
  return isWorktreePath(worktree) ? await discoverRepoRoot(worktree) : worktree
}

export async function writeState(worktree: string, state: OrchestrateState): Promise<void> {
  const target = await resolveStateRoot(worktree)
  mkdirSync(getStateDir(target), { recursive: true })
  state.updatedAt = new Date().toISOString()
  await writeFile(getStatePath(target, state.changeId), JSON.stringify(state, null, 2))
}

export async function getLockPath(worktree: string, changeId: string): Promise<string> {
  const root = await resolveStateRoot(worktree)
  return path.join(getStateDir(root), `${changeId}.review.lock`)
}

function readLockMeta(lockPath: string): { pid: number; acquiredAt: number } | null {
  try {
    const meta = JSON.parse(readFileSync(path.join(lockPath, LOCK_META_FILENAME), "utf-8"))
    if (meta && typeof meta.acquiredAt === "number") return meta
    return null
  } catch {
    return null
  }
}

export function acquireLock(lockPath: string, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tryAcquire = () => {
      try {
        mkdirSync(lockPath)
        try {
          writeFileSync(
            path.join(lockPath, LOCK_META_FILENAME),
            JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })
          )
        } catch (metaErr) {
          rmSync(lockPath, { recursive: true, force: true })
          reject(metaErr as Error)
          return
        }
        resolve()
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== "EEXIST") {
          reject(err as Error)
          return
        }
        const meta = readLockMeta(lockPath)
        if (meta && Date.now() - meta.acquiredAt >= LOCK_STALE_THRESHOLD_MS) {
          rmSync(lockPath, { recursive: true, force: true })
          setTimeout(tryAcquire, LOCK_POLL_INTERVAL_MS)
          return
        }
        if (Date.now() >= deadline) {
          reject(new Error(`获取锁超时：${lockPath}（${timeoutMs}ms 内未获得锁）`))
          return
        }
        setTimeout(tryAcquire, LOCK_POLL_INTERVAL_MS)
      }
    }
    tryAcquire()
  })
}

export function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath, { recursive: true, force: true })
  } catch {
    // 锁目录不存在时静默忽略
  }
}
