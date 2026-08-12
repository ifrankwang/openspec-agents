import path from "path"
import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, cpSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import type { OrchestrateState, TaskGroupState, Phase, IssueItem } from "./types.ts"
import type { WorkItem, WorkItemPhase, Severity } from "./workflow/types.ts"
import { createInitialWorkItem } from "./workflow/engine.ts"
import { EXEMPT_REQUEST_KEY } from "./workflow/submit.ts"
import { STATE_DIR_NAME, STATE_SUBDIR_NAME, LEGACY_STATE_DIR_NAME, LEGACY_STATE_SUBDIR_NAME } from "./constants.ts"
import { DIMENSION_AGENT_MAP } from "./constants.ts"
import { discoverRepoRoot } from "./git.ts"
import { generateIsolationNamespace } from "./namespace.ts"

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

/** 旧布局 .opencode/.orchestrate_state（读取兼容与迁移源）。 */
export function getLegacyStateDir(worktree: string): string {
  return path.join(worktree, LEGACY_STATE_DIR_NAME, LEGACY_STATE_SUBDIR_NAME)
}

/** Worktree 内用于存储 changeId/taskGroupId 指针的上下文文件（相对于 worktree 根） */
export const WORKTREE_CONTEXT_FILE = "openspec/states/context.json"
/** 旧布局 worktree 上下文指针（读取兼容）。 */
export const WORKTREE_CONTEXT_FILE_LEGACY = ".opencode/.orchestrate_state/context.json"

/**
 * 幂等迁移：旧 .opencode/.orchestrate_state/ 数据（主状态/exemptions/锁/context.json 指针）→
 * openspec/states/。新目录已存在（含空目录）即视为已迁移，重复调用无副作用；
 * 迁移只拷贝不删除旧文件，旧布局在迁移期间仍可读（双读兼容）。
 */
export function migrateLegacyStateDir(root: string): void {
  const legacyDir = getLegacyStateDir(root)
  if (!existsSync(legacyDir)) return
  const newDir = getStateDir(root)
  if (existsSync(newDir)) return
  mkdirSync(newDir, { recursive: true })
  for (const entry of readdirSync(legacyDir, { withFileTypes: true })) {
    const src = path.join(legacyDir, entry.name)
    const dst = path.join(newDir, entry.name)
    try {
      if (entry.isDirectory()) {
        cpSync(src, dst, { recursive: true })
      } else {
        copyFileSync(src, dst)
      }
    } catch {
      // 单文件迁移失败不阻塞整体迁移（其余条目继续）
    }
  }
}

/**
 * 从 worktree 中读取上下文指针（changeId + taskGroupId）。
 * 新布局 openspec/states/context.json 优先，旧 .opencode/.orchestrate_state/context.json 双读兼容。
 * 文件不存在时返回 null。
 */
export async function readContextFromWorktree(worktreePath: string): Promise<{ changeId: string; taskGroupId: string } | null> {
  const fp = path.join(worktreePath, WORKTREE_CONTEXT_FILE)
  const fpLegacy = path.join(worktreePath, WORKTREE_CONTEXT_FILE_LEGACY)
  for (const p of [fp, fpLegacy]) {
    try {
      const raw = await readFile(p, "utf-8")
      return JSON.parse(raw) as { changeId: string; taskGroupId: string }
    } catch {
      // 该布局无指针，尝试下一个
    }
  }
  return null
}

/**
 * 向 worktree 写入上下文指针（changeId + taskGroupId）。
 * 自动创建所需目录；首次写入新布局前把旧布局指针幂等迁移到新位置。
 */
export async function writeContextToWorktree(worktreePath: string, changeId: string, taskGroupId: string): Promise<void> {
  const fp = path.join(worktreePath, WORKTREE_CONTEXT_FILE)
  const fpLegacy = path.join(worktreePath, WORKTREE_CONTEXT_FILE_LEGACY)
  if (!existsSync(fp) && existsSync(fpLegacy)) {
    migrateLegacyStateDir(worktreePath)
  }
  const dir = path.dirname(fp)
  mkdirSync(dir, { recursive: true })
  await writeFile(fp, JSON.stringify({ changeId, taskGroupId }, null, 2))
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
  // 非 worktree 且未传 changeId：无可用编排上下文，与「无可用编排会话」语义一致，返回 null 兜底
  return null
}

// ─── 旧格式读兼容迁移：taskGroups → workItems（单轨化后 taskGroups 不再持久化）───
// 以下映射仅服务于旧格式状态文件升级为 workItems 的迁移入口，非双轨同步逻辑。
// 升级后 taskGroups 字段不再写回，workItems 为唯一事实源。

/** 旧 tg.status → WorkItem phase（迁移用） */
function taskGroupStatusToPhase(status: Phase): WorkItemPhase {
  switch (status) {
    case "task_analysis": return "todo"
    case "dev_impl": return "in_progress"
    case "review": return "review"
    case "completed": return "done"
  }
}

/** 旧 tg.status → WorkItem currentStep（迁移用，各阶段入口 step） */
function taskGroupStatusToStep(status: Phase): string | null {
  switch (status) {
    case "task_analysis": return "analyze"
    case "dev_impl": return "implement"
    case "review": return "verify_tool"
    case "completed": return null
  }
}

/** 旧 issue status → child phase（迁移用：verified→done、exempted→cancelled、submitted→review，其余→todo） */
function issueStatusToChildPhase(status: IssueItem["status"]): WorkItemPhase {
  switch (status) {
    case "verified": return "done"
    case "exempted": return "cancelled"
    case "submitted": return "review"
    default: return "todo"
  }
}

/** 由旧 issue 归因（sourcePhase+dimension）反推真实报源审查 agent（迁移 metadata.source 用，兼 exempt_request.requestedBy 兜底）。 */
function issueReporterAgent(issue: IssueItem): string {
  if (issue.sourcePhase === "quality") return DIMENSION_AGENT_MAP[issue.dimension] ?? "openspec-reviewer-tool"
  if (issue.sourcePhase === "task") return "openspec-reviewer-task"
  return "openspec-reviewer-tool"
}

/** 由 issue 构造 issue 类型 WorkItem child。 */
export function buildIssueWorkItem(issue: IssueItem): WorkItem {
  const reporterAgent = issueReporterAgent(issue)
  const child = createInitialWorkItem({
    id: `issue:${issue.id}`,
    source: reporterAgent,
    externalId: issue.id,
    type: "issue",
    title: issue.description,
    description: issue.description,
    severity: issue.severity as Severity,
  })
  child.phase = issueStatusToChildPhase(issue.status)
  // 迁移时写入真实报源 agent 到 metadata.source：新流报源层（tool/task/quality）由 source 反推，
  // 无 source 的迁移 issue 无法归层/裁定（原 workflow/submit.ts 报错路径）。source_phase 保留透传作
  // 历史兼容兜底（消费端仅认 source 反推，见 reviewLayerFromMetadata）。
  child.metadata["source"] = reporterAgent
  child.metadata["source_phase"] = issue.sourcePhase
  child.metadata["dimension"] = issue.dimension
  child.metadata["file"] = issue.file
  child.metadata["line"] = issue.line
  if (issue.status === "exemption_requested") {
    // 迁移时保留豁免申请语义：exempt_request 标记使 sync 回写保持 exemption_requested，
    // 避免 child 落 todo 后被覆写回 open 丢失豁免申请。
    child.metadata[EXEMPT_REQUEST_KEY] = {
      requestedBy: reporterAgent,
      reason: issue.exemptReason,
    }
  }
  return child
}

/** 由 taskGroup 构造 task 类型 WorkItem（含其 issue children 与 task 清单）。 */
export function buildTaskWorkItemFromTaskGroup(tg: TaskGroupState): WorkItem {
  const item = createInitialWorkItem({
    id: `task:${tg.id}`,
    source: "openspec",
    externalId: tg.id,
    type: "task",
    title: tg.name,
    description: tg.name,
    labels: ["openspec-change"],
  })
  item.phase = taskGroupStatusToPhase(tg.status)
  item.currentStep = taskGroupStatusToStep(tg.status)
  item.metadata = { source: "openspec", tasks: JSON.parse(JSON.stringify(tg.tasks ?? [])) }
  // 迁移透传 worktree 引用（worktree_path/branch_name/base_ref）：旧格式升级后 worktree 就绪判定与提交门禁须保持一致
  if (tg.worktreePath) item.metadata["worktree_path"] = tg.worktreePath
  if (tg.branchName) item.metadata["branch_name"] = tg.branchName
  if (tg.baseRef) item.metadata["base_ref"] = tg.baseRef
  item.children = tg.issues.map(buildIssueWorkItem)
  return item
}

/**
 * 从旧格式 taskGroups 批量构造 workItems（旧状态文件自动升级入口）。
 * 单轨化后仅由 readStateByChangeId 在旧格式（有 taskGroups 无 workItems）时调用，
 * 升级结果落盘后 taskGroups 字段不再写回。
 */
export function upgradeWorkItemsFromTaskGroups(groups: TaskGroupState[]): WorkItem[] {
  return groups.map(buildTaskWorkItemFromTaskGroup)
}

interface LegacyState extends OrchestrateState {
  taskGroups?: TaskGroupState[]
}

export async function readStateByChangeId(worktree: string, changeId: string): Promise<OrchestrateState | null> {
  const fp = getStatePath(worktree, changeId)
  const fpLegacy = path.join(getLegacyStateDir(worktree), `${changeId}.json`)
  // 双读兼容：新布局 openspec/states/ 优先，旧 .opencode/.orchestrate_state/ 兜底（迁移前仍可读）
  const readPath = existsSync(fp) ? fp : existsSync(fpLegacy) ? fpLegacy : null
  let raw: unknown
  try {
    raw = readPath ? JSON.parse(await readFile(readPath, "utf-8")) : null
  } catch {
    raw = null
  }
  if (raw === null) return null
  const legacy = raw as LegacyState
  const sampleGroup = legacy.taskGroups?.[0]
  if (sampleGroup && !("tasks" in sampleGroup)) {
    throw new Error(
      `状态文件 "${legacy.changeId}" 是旧版本格式，不兼容当前版本。请重新初始化编排会话（opx_orch_init）。`
    )
  }
  if (!legacy.isolationNamespace) {
    legacy.isolationNamespace = generateIsolationNamespace(legacy.changeId)
  }
  // 旧格式归一化：blocker 状态兼容 + task_analysis 自动推进（仅在迁移前生效）
  for (const group of legacy.taskGroups || []) {
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

  const needsUpgrade = !Array.isArray(legacy.workItems) || legacy.workItems.length === 0
  // 单轨组装：仅保留 workItems 为唯一事实源，taskGroups 字段丢弃不再写回
  const state: OrchestrateState = {
    changeId: legacy.changeId,
    isolationNamespace: legacy.isolationNamespace,
    taskGroupId: legacy.taskGroupId,
    baseBranch: legacy.baseBranch,
    workItems: needsUpgrade
      ? upgradeWorkItemsFromTaskGroups(legacy.taskGroups ?? [])
      : (legacy.workItems as WorkItem[]),
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    unattended: legacy.unattended,
  }
  if (needsUpgrade) {
    // 迁移产物一次性落盘固定单轨形态，避免每次读取都重建（首次写新目录前幂等迁移旧数据）
    migrateLegacyStateDir(worktree)
    mkdirSync(getStateDir(worktree), { recursive: true })
    await writeFile(fp, JSON.stringify(state, null, 2))
  }
  return state
}

export async function resolveStateRoot(worktree: string): Promise<string> {
  return isWorktreePath(worktree) ? await discoverRepoRoot(worktree) : worktree
}

export async function writeState(worktree: string, state: OrchestrateState): Promise<void> {
  const target = await resolveStateRoot(worktree)
  // 首次新目录写入前幂等迁移旧 .opencode 数据（主状态/exemptions/锁），重复迁移无副作用
  migrateLegacyStateDir(target)
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
