import path from "path"
import { rmdir } from "node:fs/promises"
import type { OrchestrateState, TaskItem, TaskStatus, WorkflowMode, ReviewScope } from "../types.ts"
import { BUILD_PHASE_TARGETS, REVIEW_LAYERS, REVIEW_VERIFY_STEPS, SIMPLE_REVIEW_STEPS, REVIEW_TASK_GROUP_ID } from "../types.ts"
import { agentToReviewLayer } from "../constants.ts"
import { runGit, runGitChecked, getCurrentBranch, getMergeBase, isAncestor, isWorktreeClean, markTaskGroupCheckboxesComplete, mergeBranchToTarget, discoverDiskWorktrees, detectMainRepoPollution, detectChanges, removeTaskGroupWorktree, isLocalBranch, listLocalBranches, pathExists, type DetectChangesResult } from "../git.ts"
import { readStateByWorktree, readStateByChangeId, writeState, writeContextToWorktree, getLockPath, acquireLock, releaseLock } from "../state.ts"
import { generateIsolationNamespace } from "../namespace.ts"
import { readExemptions } from "../exemptions.ts"
import { parseAllTaskGroupsFromMd, parseTasksMdForGroup, extractRelevantSpecsFromTasks } from "../tasks-md.ts"
import type { ParsedTask } from "../tasks-md.ts"
import { assertOrchestrator, findTaskGroup } from "../derive.ts"
import { assertPathWithin } from "../paths.ts"
import { loadWorkflowFile, resolveWorkflowPath, type LoadedWorkflow } from "../workflow/loader.ts"
import { createInitialWorkItem, isBlockingSeverity, isTaskGroupSettled, isFinalTaskGroup, isTerminalPhase, recommendForItem, resetInternalRetryCount, adjudicateStep, clearStepTags, REVIEW_FIX_POLICY_KEY } from "../workflow/engine.ts"
import { renderWorkflowStatusView } from "../workflow/status.ts"
import { taskChildrenOf } from "../task-children.ts"
import type { WorkItem, WorkItemPhase } from "../workflow/types.ts"
import type { InitParams, SetWorktreeParams, UnattendedParams, ToolContext, StatusParams } from "./types.ts"

/** 由 tasks.md 解析结果构造 task child WorkItem（初始 todo；externalId 存 taskNumber，id 存数字索引）。 */
function taskChildFromParsed(p: ParsedTask, index: number): WorkItem {
  const child = createInitialWorkItem({
    id: String(index + 1),
    source: "openspec",
    externalId: p.taskNumber,
    type: "task",
    title: p.title,
    description: p.title,
  })
  child.metadata["specTrace"] = p.specTrace
  child.metadata["taskNumber"] = p.taskNumber
  return child
}

/**
 * 按 tasks.md 同步 task children（整体重建）：
 * - 先自愈：现存 task children 重复 id 时合并去重——保留第一出现条目（含进度），丢弃重复条目，
 *   不得因重复抛错（否则封死 recovery=task_analysis 等逃生路径）；
 * - 以 parsed 为基准整体重建 task 部分：forceOpen=false 时复用同 id 旧 child（保留 phase/tags/metadata
 *   进度），forceOpen=true 或旧 child 不存在则新建，新建时按 opts.defaultStatus 赋初始 phase；
 * - 移除 tasks.md 已删除的 task child，issue children 不受影响。
 */
function syncTaskChildren(item: WorkItem, parsed: ParsedTask[], opts: { forceOpen?: boolean; defaultStatus?: WorkItemPhase }): void {
  // 自愈：现存 task children 重复 id 时合并去重（保留第一出现条目含进度），杜绝"保留旧 + 追加新"产生的重复。
  const seen = new Set<string>()
  const deduped: WorkItem[] = []
  for (const c of item.children) {
    if (c.type === "task") {
      if (seen.has(c.id)) continue
      seen.add(c.id)
    }
    deduped.push(c)
  }
  item.children = deduped

  const prev = new Map(taskChildrenOf(item).map((c) => [c.id, c]))
  const built = parsed.map((p, i) => {
    const id = String(i + 1)
    const old = prev.get(id)
    if (old && !opts.forceOpen) {
      // 复用旧 child 保留进度（phase/tags/metadata），按 parsed 刷新标题/编号等展示字段
      old.title = p.title
      old.description = p.title
      old.externalId = p.taskNumber
      old.metadata["specTrace"] = p.specTrace
      old.metadata["taskNumber"] = p.taskNumber
      return old
    }
    const child = taskChildFromParsed(p, i)
    if (!opts.forceOpen && opts.defaultStatus) child.phase = opts.defaultStatus
    return child
  })
  // 整体替换 task 部分：旧 task child 全部移除，以 parsed 为基准重建；issue children 不受影响。
  item.children = [...item.children.filter((c) => c.type !== "task"), ...built]
}

/** TaskStatus → task child phase 反查（旧 state metadata.tasks 迁移用）。 */
function taskStatusToPhase(status: TaskStatus): WorkItemPhase {
  switch (status) {
    case "submitted": return "review"
    case "verified": return "done"
    case "rejected": return "todo"
    default: return "todo"
  }
}

/**
 * 旧 state 迁移：metadata.tasks（TaskItem[]）→ task children。
 * 无 task child 时按 status 反查 phase 重建并挂入 children；随后删除 metadata.tasks（已废弃）。
 */
function migrateLegacyTasks(item: WorkItem): void {
  const raw = item.metadata["tasks"]
  if (!Array.isArray(raw)) return
  if (taskChildrenOf(item).length === 0) {
    for (const t of raw as TaskItem[]) {
      const child = createInitialWorkItem({
        id: String(t.id),
        source: "openspec",
        externalId: t.taskNumber || undefined,
        type: "task",
        title: t.title,
        description: t.title,
      })
      child.metadata["specTrace"] = t.specTrace
      if (t.taskNumber) child.metadata["taskNumber"] = t.taskNumber
      if (t.rejectReason) child.metadata["reject_reason"] = t.rejectReason
      child.phase = taskStatusToPhase(t.status)
      item.children.push(child)
    }
  }
  delete item.metadata["tasks"]
}

/**
 * 扫描 review 阶段第一个未全 passed 的 step（按 workflow 声明顺序 verify_tool → verify_task → verify_quality）。
 * 一个 step 全 passed 由 adjudicateStep 判定（该 step 所有 agent 的 tag 均为 passed）；全部通过返回 null。
 */
function firstUnpassedReviewStep(item: WorkItem, workflow: LoadedWorkflow): string | null {
  const review = workflow.phases.find((p) => p.name === "review")
  if (!review) return null
  for (const step of review.steps) {
    if (adjudicateStep(item, step) !== "passed") return step.id
  }
  return null
}

/**
 * 按 recovery 合成活跃组 WorkItem 的 phase/currentStep/tags/task children。
 * - task_analysis：todo/analyze、tags 清空、task children 全 todo（全新开始）
 * - dev_impl：in_progress/implement、analyze 已 passed、task children 保留既有进度（无则 todo）
 * - review：review/verify_*（增量合并——已 passed 的审查标记保留、failed 重置为 pending，currentStep
 *   前移到第一个未全 passed 的子层；review_layer 决定强制前置哪些子层）、analyze+implement 已 passed、
 *   task children 保留既有进度（无则 done——review 恢复时子任务应视为已验证，否则 G21 remaining 会让 implement 无法提交）
 * simple 分支（mode === "simple"，3.2）：无 analyze / verify_* step，task_analysis / dev_impl 均落
 *   in_progress/implement（task_analysis 重置 task children 全 todo，dev_impl 保留既有进度）；review 落
 *   review 第一个未全 passed 的审查 step（quality_review，或全 passed 时 verify_cleanup）——implement 置
 *   passed、quality_review 的 failed tag 删除回 pending（passed 保留）、task children 缺省 done；reset_steps
 *   按模式生效（simple 仅接受 quality_review，含该值时清空 quality_review 全部 tags——passed 也清，
 *   强制重审正是该参数的目的，清空后引擎重派该 step 审查者）；review_layer 在 simple 下无对应子层
 *   （仅 quality_review 单层），接受但不生效，init 返回体输出警告。
 */
function applyRecoveryState(
  item: WorkItem,
  recovery: InitParams["recovery"],
  parsedTasks: ParsedTask[],
  state: Pick<OrchestrateState, "mode" | "kind" | "reviewScope">,
): void {
  // 恢复重建为已知状态后清除残留推进阻塞原因，避免 orchestrator 视图展示过期信息
  delete item.metadata["_advance_block_reason"]
  // 清除内部重试计数：recovery 恢复后残留 _retryCount 会在下次回退时立即再次触发检查点（死锁）。
  resetInternalRetryCount(item)
  // 清除检查点标记残留：恢复重建为已知状态后 _checkpoint 已无意义（checkpoint 态属于中断中的 step）。
  delete item.metadata["_checkpoint"]
  if (state.kind === "review") {
    // 独立审查会话恢复：无 analyze 前置、无 task children；phase 值域入口已收敛为 review / dev_impl。
    const phase = recovery?.phase
    if (!phase || phase === "dev_impl") {
      // 恢复进 implement：tags 整体重置（不残留 implement passed，否则 dev 不会被重派）
      item.phase = "in_progress"
      item.currentStep = "implement"
      item.tags = {}
      return
    }
    // review 分支：恢复进 review 时 implement 必然已通过
    item.phase = "review"
    item.tags["implement:openspec-developer"] = "passed"
    // failed 审查标记删除回 pending（passed 保留——已审查通过无需重跑），对 review 两种颗粒度的
    // step id（verify_* / quality_review）统一处理
    for (const key of Object.keys(item.tags)) {
      if (
        key.startsWith("verify_tool:") || key.startsWith("verify_task:") ||
        key.startsWith("verify_quality:") || key.startsWith("quality_review:")
      ) {
        if (item.tags[key] !== "passed") delete item.tags[key]
      }
    }
    // reset_steps：清空指定审查 step 全部 tags（passed 也清，强制重审），值域已按形态校验
    for (const stepId of recovery?.reset_steps ?? []) {
      clearStepTags(item, stepId)
    }
    // currentStep 前移到第一个未全 passed 的审查 step（review workflow 生效，按颗粒度选文件）
    const workflow = loadWorkflowFile(resolveWorkflowPath(state))
    item.currentStep = firstUnpassedReviewStep(item, workflow)
    // 全 passed 收口 done：review 会话无 task children，终态检查天然通过
    if (item.currentStep === null) item.phase = "done"
    return
  }
  const mode = state.mode
  if (mode === "simple") {
    const phase = recovery?.phase
    if (!phase || phase === "task_analysis" || phase === "dev_impl") {
      // simple 无 analyze：无 recovery（全新初始化）/ task_analysis / dev_impl 均落 in_progress/implement。
      // tags 整体重置——不残留 implement:openspec-developer passed（否则 dev 不会重派，恢复失去意义）。
      item.phase = "in_progress"
      item.currentStep = "implement"
      item.tags = {}
      if (!phase || phase === "task_analysis") {
        // 重置 task children 全 todo（全新开始）
        syncTaskChildren(item, parsedTasks, { forceOpen: true })
      } else {
        // dev_impl 保留既有进度（无则 todo）
        syncTaskChildren(item, parsedTasks, { defaultStatus: "todo" })
      }
      return
    }
    // review 分支：恢复进 review 时 implement 必然已通过
    item.phase = "review"
    item.tags["implement:openspec-developer"] = "passed"
    // quality_review 的 failed tag 删除回 pending（passed 保留——已审查通过无需重跑）
    for (const key of Object.keys(item.tags)) {
      if (key.startsWith("quality_review:")) {
        if (item.tags[key] !== "passed") delete item.tags[key]
      }
    }
    // reset_steps（simple 模式仅 quality_review）：含该值时清空该 step 全部 tags（passed 也清——
    // 强制重审正是该参数的目的，含「已通过但任务验证/裁定遗漏」场景），tag 清空后引擎重派该 step 审查者
    if (((recovery?.reset_steps ?? []) as string[]).includes("quality_review")) {
      clearStepTags(item, "quality_review")
    }
    // review_layer 在 simple 下无对应子层，接受但不生效（init 返回体对该组合输出警告）
    // currentStep 前移到第一个未全 passed 的审查 step（与 full 口径一致；simple 的 review 阶段含
    // quality_review 与 verify_cleanup 两个 step——verify_cleanup 仅作漂移/冲突回退落点，正常流转不经过）
    const workflow = loadWorkflowFile(resolveWorkflowPath(state))
    item.currentStep = firstUnpassedReviewStep(item, workflow)
    // 全 passed 收口 done：存在未终态 task child 则停在 quality_review（recommendForItem 会返回
    // blocked 而非 terminal，安全）
    if (item.currentStep === null) {
      const unfinishedTasks = item.children.filter((child) => child.type === "task" && !isTerminalPhase(child.phase))
      if (unfinishedTasks.length === 0) {
        item.phase = "done"
      } else {
        item.currentStep = "quality_review"
      }
    }
    syncTaskChildren(item, parsedTasks, { defaultStatus: "done" })
    return
  }
  const phase = recovery?.phase
  if (!phase || phase === "task_analysis") {
    item.phase = "todo"
    item.currentStep = "analyze"
    item.tags = {}
    syncTaskChildren(item, parsedTasks, { forceOpen: true })
    return
  }
  if (phase === "dev_impl") {
    item.phase = "in_progress"
    item.currentStep = "implement"
    item.tags = { "analyze:openspec-architect": "passed" }
    syncTaskChildren(item, parsedTasks, { defaultStatus: "todo" })
    return
  }
  item.phase = "review"
  // 前置层保证：恢复进 review 时 analyze/implement 必然已通过
  item.tags["analyze:openspec-architect"] = "passed"
  item.tags["implement:openspec-developer"] = "passed"
  // 增量合并 review 审查标记：值为 passed 的保留（已审查通过层无需重跑），failed 删除回到 pending
  for (const key of Object.keys(item.tags)) {
    if (key.startsWith("verify_tool:") || key.startsWith("verify_task:") || key.startsWith("verify_quality:")) {
      if (item.tags[key] !== "passed") delete item.tags[key]
    }
  }
  // reset_steps：把指定 verify step 的全部 tags 重置为 pending（删除 tag 键），使 currentStep 落在
  // 第一个未全部通过的 verify step，可能早于被重置的 step——用于已 passed 但被本层遗漏复核/裁定
  // 阻塞的 review step 强制重新审查（与 resetReviewTagsOnFix 删除 tag 的既有语义一致）。
  for (const stepId of recovery?.reset_steps ?? []) {
    clearStepTags(item, stepId)
  }
  // review_layer 强制前置：tool→task 时 verify_tool 强制 passed；quality 时 verify_tool+verify_task 强制 passed
  if (recovery?.review_layer === "task" || recovery?.review_layer === "quality") {
    item.tags["verify_tool:openspec-reviewer-tool"] = "passed"
  }
  if (recovery?.review_layer === "quality") {
    item.tags["verify_task:openspec-reviewer-task"] = "passed"
  }
  // currentStep 前移：显式指向第一个未全 passed 的 review step（已全 passed 的子层跳过）。
  // 按 mode 选择 workflow 文件：simple 模式 review 阶段仅 quality_review 一个 step。
  const workflow = loadWorkflowFile(resolveWorkflowPath({ mode }))
  item.currentStep = firstUnpassedReviewStep(item, workflow)
  // 全 passed 收口 done：三个 review step 全 passed 时，仅当 task children 全部终态才收口；
  // 存在未终态 task child 则停在 verify_quality（recommendForItem 会返回 blocked 而非 terminal，安全）。
  if (item.currentStep === null) {
    const unfinishedTasks = item.children.filter((child) => child.type === "task" && !isTerminalPhase(child.phase))
    if (unfinishedTasks.length === 0) {
      item.phase = "done"
    } else {
      item.currentStep = "verify_quality"
    }
  }
  syncTaskChildren(item, parsedTasks, { defaultStatus: "done" })
}

/**
 * recovery 参数值域校验（入口显式拒绝，早于任何状态变更）：
 * - phase 必须为合法恢复阶段（task_analysis/dev_impl/review），缺失/非法即抛错并列出合法值；
 * - review_layer 必须为合法子层（tool/task/quality），非法即抛错；
 * - review_layer 仅当 phase=review 时允许存在，其余 phase 组合复用既有组合错误消息；
 * - reset_steps 必须为非空数组，仅当 phase=review 时允许存在，且与 review_layer 互斥
 *   （二者都操纵哪些 review step 通过）。reset_steps 的 step 值域按模式生效（full 仅
 *   verify_tool/verify_task/verify_quality，simple 仅 quality_review），由
 *   assertValidResetStepValues 在 state 读取后做模式感知校验——本函数仅做与模式无关的组合校验。
 */
function assertValidRecovery(recovery: InitParams["recovery"]): void {
  if (recovery === undefined) return
  if (!(BUILD_PHASE_TARGETS as readonly string[]).includes(recovery.phase)) {
    throw new Error(
      `recovery.phase 不合法，合法值：${BUILD_PHASE_TARGETS.join("、")}。传入值："${String(recovery.phase)}"。`
    )
  }
  if (recovery.review_layer !== undefined && !(REVIEW_LAYERS as readonly string[]).includes(recovery.review_layer)) {
    throw new Error(
      `recovery.review_layer 不合法，合法值：${REVIEW_LAYERS.join("、")}。传入值："${String(recovery.review_layer)}"。`
    )
  }
  if (recovery.review_layer && recovery.phase !== "review") {
    throw new Error(`review_layer 参数仅当 recovery.phase 为 review 时有效，当前 phase 为 "${recovery.phase}"。`)
  }
  if (recovery.reset_steps !== undefined) {
    if (recovery.phase !== "review") {
      throw new Error(`reset_steps 参数仅当 recovery.phase 为 review 时有效，当前 phase 为 "${recovery.phase}"。`)
    }
    if (recovery.review_layer) {
      throw new Error("reset_steps 与 review_layer 互斥，不可同时使用。")
    }
    if (recovery.reset_steps.length === 0) {
      throw new Error("reset_steps 不能为空数组，请至少指定一个审查 step。")
    }
  }
}

/**
 * reset_steps 值域的形态感知校验（state 读取/固化后调用）：
 * - 独立审查会话按颗粒度：thorough 仅接受 verify_tool/verify_task/verify_quality，simple 仅接受 quality_review；
 * - change 会话 full 模式仅接受 verify_tool/verify_task/verify_quality，simple 模式仅接受 quality_review。
 * 跨形态值抛错并列出当前形态的合法值。phase/review_layer/组合校验在 assertValidRecovery 前置
 * （错误早于任何状态变更且不落盘），值域校验依赖 state 故后置到 state 读取之后——
 * state 读取不是状态变更，该原则不破坏。
 */
function assertValidResetStepValues(
  recovery: InitParams["recovery"],
  state: Pick<OrchestrateState, "mode" | "kind" | "reviewScope">,
): void {
  if (!recovery?.reset_steps?.length) return
  let valid: readonly string[]
  let formLabel: string
  if (state.kind === "review") {
    if (state.reviewScope?.granularity === "simple") {
      valid = SIMPLE_REVIEW_STEPS
      formLabel = "独立审查会话（simple 颗粒度）"
    } else {
      valid = REVIEW_VERIFY_STEPS
      formLabel = "独立审查会话（thorough 颗粒度）"
    }
  } else if ((state.mode ?? "full") === "simple") {
    valid = SIMPLE_REVIEW_STEPS
    formLabel = "simple 模式"
  } else {
    valid = REVIEW_VERIFY_STEPS
    formLabel = "full 模式"
  }
  for (const stepId of recovery.reset_steps) {
    if (!valid.includes(stepId)) {
      throw new Error(
        `reset_steps 中的 step "${stepId}" 不属于当前会话形态（${formLabel}）的审查 step，` +
        `合法值：${valid.join("、")}。传入值："${stepId}"。`
      )
    }
  }
}

/**
 * 判断目标组以外的全部任务组（workItems 中 `task:` 前缀、非目标组）是否"终态或从未激活"，
 * 即 mode 切换窗口（W1 切组 / W2 重制当前组）的共同前置条件（判定单一事实源：isTaskGroupSettled）。
 */
function otherTaskGroupsSettled(state: OrchestrateState, targetGroupId: string): boolean {
  return state.workItems
    .filter((w) => w.id.startsWith("task:") && w.id !== `task:${targetGroupId}`)
    .every(isTaskGroupSettled)
}

// ─── 独立审查会话（kind=review，不绑定 OpenSpec change）───

/** 分支名等非法字符归一为 -（会话 id 推导用，保持确定性）。 */
function normalizeSessionToken(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "head"
}

/** 独立审查会话 id 确定性推导：pr → review-pr-<base>-<head>；full → review-full-<当前分支>-<yyyymmdd>。 */
function deriveReviewSessionId(scope: ReviewScope, currentBranch: string): string {
  if (scope.scopeType === "pr") {
    return `review-pr-${normalizeSessionToken(scope.baseRef ?? "")}-${normalizeSessionToken(scope.headRef ?? "")}`
  }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  return `review-full-${normalizeSessionToken(currentBranch)}-${day}`
}

/** 审查范围等价判定（幂等复用判定：scopeType/推导后的 baseRef/headRef/granularity/fix 全等）。 */
function reviewScopeEquals(a: ReviewScope, b: ReviewScope): boolean {
  return (
    a.scopeType === b.scopeType && a.baseRef === b.baseRef && a.headRef === b.headRef &&
    a.granularity === b.granularity && a.fix === b.fix
  )
}

/** 校验独立审查入口的分支必须为存在的本地分支（收尾合并以 update-ref 推进本地分支引用，
 *  origin/* 等远端 ref 会静默创建错误的本地分支，故显式拒绝）。 */
async function assertLocalReviewBranch(worktree: string, branch: string, role: string): Promise<void> {
  if (typeof branch !== "string" || branch.trim() === "" || /\s/.test(branch)) {
    throw new Error(`独立审查会话的 ${role} 分支名不合法："${String(branch)}"。`)
  }
  if (branch.startsWith("origin/") || branch.startsWith("refs/remotes/")) {
    throw new Error(
      `独立审查会话的 ${role} 分支 "${branch}" 是远端引用：收尾合并只推进本地分支引用，远端引用会静默创建错误的本地分支。` +
      `请改用对应的本地分支名（如需审查远端内容，先在本地建分支跟踪后再传入）。`
    )
  }
  if (!(await isLocalBranch(worktree, branch))) {
    const branches = await listLocalBranches(worktree)
    throw new Error(
      `独立审查会话的 ${role} 分支 "${branch}" 不是本地分支。当前本地分支：${branches.join("、") || "(无)"}。`
    )
  }
}

/** 解析并校验 review_scope 参数（枚举值域 + 分支本地性 + base 推导），返回规范化 ReviewScope 与当前分支。 */
async function resolveReviewScope(
  worktree: string,
  raw: NonNullable<InitParams["review_scope"]>,
): Promise<{ scope: ReviewScope; currentBranch: string }> {
  const currentBranch = await getCurrentBranch(worktree)
  if (raw.scope_type !== "pr" && raw.scope_type !== "full") {
    throw new Error(`review_scope.scope_type 不合法，合法值：pr、full。传入值："${String(raw.scope_type)}"。`)
  }
  if (raw.granularity !== "simple" && raw.granularity !== "thorough") {
    throw new Error(`review_scope.granularity 不合法，合法值：simple、thorough。传入值："${String(raw.granularity)}"。`)
  }
  if (raw.fix !== "none" && raw.fix !== "fix") {
    throw new Error(`review_scope.fix 不合法，合法值：none、fix。传入值："${String(raw.fix)}"。`)
  }
  if (raw.scope_type === "full") {
    if (raw.base_ref || raw.head_ref) {
      throw new Error("review_scope.scope_type=full（全量审查）不接受 base_ref/head_ref——全量形态不界定分支区间。")
    }
    return { scope: { scopeType: "full", granularity: raw.granularity, fix: raw.fix }, currentBranch }
  }
  // pr 形态：head 必传；base 缺省推导（优先 main、其次 master，都不存在报错列出本地分支）
  const headRef = raw.head_ref
  if (!headRef) throw new Error("review_scope.scope_type=pr 必须提供 head_ref（审查目标分支，须为本地分支）。")
  let baseRef = raw.base_ref
  if (!baseRef) {
    if (await isLocalBranch(worktree, "main")) baseRef = "main"
    else if (await isLocalBranch(worktree, "master")) baseRef = "master"
    else {
      const branches = await listLocalBranches(worktree)
      throw new Error(
        `review_scope 未传 base_ref 且无法自动推导（main 与 master 均不是本地分支）。请显式传入 base_ref。当前本地分支：${branches.join("、") || "(无)"}。`
      )
    }
  }
  await assertLocalReviewBranch(worktree, baseRef, "base_ref")
  await assertLocalReviewBranch(worktree, headRef, "head_ref")
  return { scope: { scopeType: "pr", baseRef, headRef, granularity: raw.granularity, fix: raw.fix }, currentBranch }
}

/** 构造独立审查会话的虚拟组 WorkItem（无 task children，初始即落 review 阶段首个审查 step）。 */
function createReviewWorkItem(scope: ReviewScope, sessionId: string): WorkItem {
  const item = createInitialWorkItem({
    id: `task:${REVIEW_TASK_GROUP_ID}`,
    source: "review",
    externalId: REVIEW_TASK_GROUP_ID,
    type: "task",
    title: "独立代码审查",
    description: "独立代码审查（不绑定 OpenSpec change）",
    labels: ["standalone-review"],
  })
  item.phase = "review"
  item.currentStep = scope.granularity === "thorough" ? "verify_tool" : "quality_review"
  item.metadata["name"] = "独立代码审查"
  item.metadata["task_count"] = 0
  item.metadata["source"] = "review"
  item.metadata["review_session_id"] = sessionId
  // 引擎无 state 访问：item.metadata.review_fix_policy 为引擎消费的单一事实源（fail→done 短路依据），
  // 由 init 从 state.reviewScope.fix 写入，二者恒一致（state 为配置事实源，metadata 为引擎读侧投影）。
  item.metadata[REVIEW_FIX_POLICY_KEY] = scope.fix
  return item
}

/**
 * 独立审查会话 init（review_scope 入口）：
 * - 同参数重复 init 幂等（复用既有会话）；已有 review 会话传不同参数报错防误覆盖；
 * - 会话 id 确定性推导并在返回体回传，后续所有工具以 change_id 形式传入该会话 id；
 * - 不走 tasks.md 解析 / mode 校验 / mode 字段写入；recovery 仅接受 phase=review。
 */
async function initReviewSession(params: InitParams, ctx: ToolContext): Promise<string> {
  const args = params
  if (args.change_id || args.task_group_id || args.base_branch || args.mode) {
    throw new Error(
      "review_scope 与 change_id/task_group_id 是两种互斥入口（同传报错、都不传报错，二选一）；" +
      "base_branch 与 mode 仅 change 会话入口有效，独立审查会话不使用。"
    )
  }
  if (args.recovery) {
    if (args.recovery.phase !== "review") {
      throw new Error(`独立审查会话的 recovery 仅支持 phase="review"（无分析阶段），传入值："${args.recovery.phase}"。`)
    }
    if (args.recovery.review_layer) {
      throw new Error("独立审查会话不支持 review_layer（按颗粒度整体审查），如需重置指定层请用 reset_steps。")
    }
    if (args.recovery.reopenIssues) {
      throw new Error("独立审查会话不支持 reopenIssues。")
    }
  }
  const { scope, currentBranch } = await resolveReviewScope(ctx.worktree, args.review_scope!)
  const sessionId = deriveReviewSessionId(scope, currentBranch)
  let state = await readStateByChangeId(ctx.worktree, sessionId)
  if (state) {
    if (state.kind !== "review" || !state.reviewScope) {
      throw new Error(`会话 id "${sessionId}" 已被非独立审查会话占用，请核对后重试（防止误覆盖既有进度）。`)
    }
    if (!reviewScopeEquals(state.reviewScope, scope)) {
      throw new Error(
        `独立审查会话 "${sessionId}" 已存在且审查范围不同（已固化：${JSON.stringify(state.reviewScope)}，传入：${JSON.stringify(scope)}）。` +
        `会话 id 由审查范围推导，重复 init 仅支持同参数幂等复用；需不同范围请调整参数（id 随之变化）。`
      )
    }
    if (args.recovery) {
      const item = state.workItems.find((w) => w.id === `task:${REVIEW_TASK_GROUP_ID}`)
      if (!item) throw new Error(`工作项 "task:${REVIEW_TASK_GROUP_ID}" 缺失，会话状态异常，请核对 state 文件。`)
      assertValidResetStepValues(args.recovery, state)
      applyRecoveryState(item, args.recovery, [], state)
      await writeState(ctx.worktree, state)
      return `独立审查会话 "${sessionId}" 已恢复到 review 阶段（当前 step：${item.currentStep ?? "(已收口)"}）。后续工具以 change_id="${sessionId}" 传入。`
    }
    return [
      "独立审查会话已初始化（复用既有会话）。",
      "",
      `- **会话 ID**: \`${sessionId}\``,
      `- **说明**: 后续所有 opx_* 工具以 \`change_id="${sessionId}"\` 传入。`,
    ].join("\n")
  }
  if (args.recovery) {
    throw new Error(`独立审查会话 "${sessionId}" 不存在，无法按 recovery 恢复。请先不带 recovery 初始化。`)
  }
  // baseBranch 双语义：worktree 分支 fork 源与快进合并源（pr=head_ref、full=当前分支），
  // 同时是 fix 模式收尾合回目标（merge_target）；fix=none 收尾不合并不使用。
  const baseBranch = scope.scopeType === "pr" ? scope.headRef! : currentBranch
  state = {
    changeId: sessionId,
    isolationNamespace: generateIsolationNamespace(sessionId),
    taskGroupId: REVIEW_TASK_GROUP_ID,
    baseBranch,
    workItems: [createReviewWorkItem(scope, sessionId)],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    kind: "review",
    reviewScope: scope,
  }
  await writeState(ctx.worktree, state)
  const granularityLabel = scope.granularity === "thorough" ? "三层审查（工具检查 → 回归验证 → 五维度质量审查）" : "单层合并审查"
  const fixLabel = scope.fix === "fix" ? "审并修（失败回退修复后重审）" : "只审不修（issue 报告即交付物）"
  const scopeLabel = scope.scopeType === "pr" ? `PR 区间 ${scope.baseRef}..${scope.headRef}` : "全量代码库"
  return [
    "独立审查会话已初始化。",
    "",
    `- **会话 ID**: \`${sessionId}\``,
    `- **审查范围**: ${scopeLabel}`,
    `- **颗粒度**: ${granularityLabel}`,
    `- **修复策略**: ${fixLabel}`,
    "",
    `- **说明**: 后续所有 opx_* 工具以 \`change_id="${sessionId}"\` 传入（含 opx_orch_set_worktree / opx_status / opx_agent_submit / 收尾）。`,
  ].join("\n")
}

/** 既有独立审查会话按 change_id 入口的恢复（task_group_id 可缺省，虚拟组 review）。 */
async function initReviewRecovery(params: InitParams, state: OrchestrateState, ctx: ToolContext): Promise<string> {
  const args = params
  if (args.mode || args.base_branch) {
    throw new Error("独立审查会话不使用 mode / base_branch 参数（审查范围在首次 init 经 review_scope 固化）。")
  }
  if (args.task_group_id && args.task_group_id !== REVIEW_TASK_GROUP_ID) {
    throw new Error(`独立审查会话的虚拟任务组固定为 "${REVIEW_TASK_GROUP_ID}"，传入值："${args.task_group_id}"。`)
  }
  if (args.recovery) {
    if (args.recovery.phase === "task_analysis") {
      throw new Error('独立审查会话无分析阶段，recovery.phase="task_analysis" 不适用（仅支持 review / dev_impl）。')
    }
    if (args.recovery.review_layer) {
      throw new Error("独立审查会话不支持 review_layer（按颗粒度整体审查），如需重置指定层请用 reset_steps。")
    }
    if (args.recovery.reopenIssues) {
      throw new Error("独立审查会话不支持 reopenIssues。")
    }
    assertValidResetStepValues(args.recovery, state)
  }
  const item = state.workItems.find((w) => w.id === `task:${REVIEW_TASK_GROUP_ID}`)
  if (!item) throw new Error(`工作项 "task:${REVIEW_TASK_GROUP_ID}" 缺失，会话状态异常，请核对 state 文件。`)
  if (args.recovery) {
    applyRecoveryState(item, args.recovery, [], state)
    await writeState(ctx.worktree, state)
    return `独立审查会话 "${state.changeId}" 已恢复到 ${args.recovery.phase} 阶段（当前 step：${item.currentStep ?? "(已收口)"}）。`
  }
  return [
    "独立审查会话已就绪（复用既有会话）。",
    "",
    `- **会话 ID**: \`${state.changeId}\``,
    `- **说明**: 后续所有 opx_* 工具以 \`change_id="${state.changeId}"\` 传入。`,
  ].join("\n")
}

export async function initExecute(params: InitParams, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx, "opx_orch_init")

  const args = { ...params }
  if (typeof (args as any).recovery === "string") {
    let parsed: unknown
    try { parsed = JSON.parse((args as any).recovery) } catch {
      throw new Error(`recovery 参数解析失败：传入的字符串无法解析为对象。传入值：${(args as any).recovery}`)
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`recovery 参数解析失败：传入的字符串解析结果不是对象。传入值：${(args as any).recovery}`)
    }
    (args as any).recovery = parsed
  }
  assertValidRecovery(args.recovery)

  // 入口分流：review_scope（独立审查会话）与 change_id/task_group_id 互斥——同传报错、都不传报错
  if (args.review_scope !== undefined) {
    return initReviewSession(args, ctx)
  }
  if (!args.change_id || !args.task_group_id) {
    if (args.change_id) {
      // 已存在的独立审查会话按 change_id（会话 id）恢复：虚拟组 review，task_group_id 可缺省
      const existing = await readStateByChangeId(ctx.worktree, args.change_id)
      if (existing?.kind === "review") {
        return initReviewRecovery(args, existing, ctx)
      }
    }
    throw new Error(
      "初始化需要两种入口之一：change 会话传 change_id + task_group_id；独立审查会话传 review_scope（会话 id 由审查范围推导并在返回体回传）。两种入口互斥，不可同传或都不传。"
    )
  }
  const changeId = args.change_id

  // mode 值域校验：值域外一律拒绝（无论 state 是否已存在），错误早于任何状态变更且不落盘
  if (args.mode !== undefined && args.mode !== "full" && args.mode !== "simple") {
    throw new Error(`mode 参数不合法，合法值：full、simple。传入值："${String(args.mode)}"。`)
  }

  const parsedGroups = await parseAllTaskGroupsFromMd(ctx.worktree, changeId)
  if (parsedGroups.length === 0) {
    throw new Error(`无法从 tasks.md 解析出任务组，请检查文件 openspec/changes/${changeId}/tasks.md。`)
  }
  const targetGroup = parsedGroups.find((g) => g.id === args.task_group_id)
  if (!targetGroup) {
    throw new Error(
      `task_group_id "${args.task_group_id}" 不在 tasks.md 中。\n可用 ID:\n` +
      `- ${parsedGroups.map((g) => g.id).join("\n- ")}`
    )
  }

  // 逐任务组解析 tasks.md 子任务（构造各 task WorkItem 的 task children 用）
  const tasksByGroup = new Map<string, ParsedTask[]>()
  for (const g of parsedGroups) {
    tasksByGroup.set(g.id, await parseTasksMdForGroup(ctx.worktree, changeId, g.id))
  }

  // base_branch 是 ref 而非严格 branch：只做非空 + 无空白字符等基本检查（完整分支名校验由 git check-ref-format 承担）
  if (args.base_branch) {
    if (!args.base_branch.trim() || /\s/.test(args.base_branch)) {
      throw new Error(`base_branch 不合法："${args.base_branch}"。基准分支名不能为空或包含空白字符。`)
    }
  }
  const baseBranch = args.base_branch || await getCurrentBranch(ctx.worktree)
  let state = await readStateByChangeId(ctx.worktree, changeId)
  const wasCurrentGroup = state?.taskGroupId === args.task_group_id

  // state 已存在时的 mode 变更窗口校验/更新（位于 for 循环前——循环内非活跃组新建 item 与
  // applyRecoveryState 均读 state.mode；错误早于任何状态变更抛出，不落盘）：
  // - 无变更意图（不传 mode 或与生效值一致——旧 state 缺 mode 时生效值兜底 full）→ 放行，保持既有行为；
  // - W1 切组：task_group_id ≠ state.taskGroupId 且其他任务组均终态或从未激活；
  // - W2 重制当前组：recovery.phase=task_analysis 且其他任务组均终态或从未激活
  //   （reopenIssues 仅支持 dev_impl，与 W2 天然互斥，不构成冲突路径）；
  // - 窗口外传不同 mode → 报错。
  let modeSwitchNote: string | null = null
  if (state && args.mode !== undefined && args.mode !== (state.mode ?? "full")) {
    const othersSettled = otherTaskGroupsSettled(state, args.task_group_id)
    const withinWindow =
      ((args.task_group_id !== state.taskGroupId || args.recovery?.phase === "task_analysis") && othersSettled)
    if (!withinWindow) {
      throw new Error(
        `mode 参数与已固化的流程模式不一致：已固化 mode="${state.mode ?? "full"}"${state.mode === undefined ? "（旧变更未固化，读取时兜底 full）" : ""}，传入值："${args.mode}"。\n` +
        `当前场景不允许切换流程模式：切换任务组须其他任务组均已完成或从未激活；重制当前组仅支持 recovery.phase="task_analysis"（其他任务组同样须已完成或从未激活）。\n` +
        `请去掉 mode 参数继续沿用固化模式，或满足上述窗口条件后再切换。`
      )
    }
    const prevMode = state.mode
    state.mode = args.mode
    // 旧变更未固化 mode 时读取兜底 full，切换说明按 full 表述
    modeSwitchNote = `流程模式已从 ${prevMode ?? "full"} 切换为 ${args.mode}。`
  }

  if (!state) {
    state = {
      changeId,
      isolationNamespace: generateIsolationNamespace(changeId),
      taskGroupId: args.task_group_id,
      baseBranch,
      workItems: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // 新建 state 时固化模式：取 init 参数 mode（缺省 simple）；state 已存在时的 mode 变更
      // 由上方窗口校验统一处理（W1 切组 / W2 重制当前组），旧 state 缺 mode 由消费端读时兜底 full，不写回。
      mode: args.mode ?? "simple",
    }
  } else {
    state.baseBranch = state.baseBranch || baseBranch
    state.isolationNamespace = state.isolationNamespace || generateIsolationNamespace(state.changeId)
  }

  // reset_steps 值域的模式感知校验：位于 state 读取/固化之后（有效模式 = state.mode ?? "full"，
  // 与 applyRecoveryState 消费的生效模式一致）、一切状态变更与落盘之前，跨模式值报错不落盘
  assertValidResetStepValues(args.recovery, state)

  // 按 tasks.md 构造全部任务组的 task WorkItem（单轨：workItems 为唯一事实源）
  for (const group of parsedGroups) {
    const isCurrent = group.id === args.task_group_id
    const groupTasks = tasksByGroup.get(group.id) ?? []
    const existing = state.workItems.find((w) => w.id === `task:${group.id}`)
    const refreshMeta = (item: WorkItem): void => {
      item.metadata["name"] = group.name
      item.metadata["task_count"] = group.taskCount
      item.metadata["source"] = "openspec"
      item.metadata["relevant_specs"] = extractRelevantSpecsFromTasks(groupTasks)
    }

    // 旧 state 迁移：metadata.tasks（TaskItem[]）→ task children（挂入 children 后删除 metadata.tasks）
    if (existing) migrateLegacyTasks(existing)

    if (!isCurrent) {
      // 非活跃组：已有则保留进度（仅刷新名称/计数），否则新建
      if (existing) {
        refreshMeta(existing)
      } else {
        const item = createInitialWorkItem({
          id: `task:${group.id}`,
          source: "openspec",
          externalId: group.id,
          type: "task",
          title: group.name,
          description: group.name,
          labels: ["openspec-change"],
        })
        // 新建 item 初始 step 模式感知（3.1）：simple 无 analyze step，初始 phase=in_progress、
        // currentStep=implement（执行边界默认整个 worktree），否则 phaseStepMismatch 会拒绝执行；
        // full 保持 todo/analyze 既有语义。
        if (state.mode === "simple") {
          item.phase = "in_progress"
          item.currentStep = "implement"
        } else {
          item.currentStep = "analyze"
        }
        syncTaskChildren(item, groupTasks, { defaultStatus: "todo" })
        refreshMeta(item)
        state.workItems.push(item)
      }
      continue
    }

    // 活跃组：无 recovery 重复初始化当前组 → 保留进度并刷新 task children
    // （按 parsed 数量/标题做一致性重建，复用既有 children 进度，顺带自愈重复 id 的已损坏 state）
    if (existing && !args.recovery && wasCurrentGroup) {
      refreshMeta(existing)
      syncTaskChildren(existing, groupTasks, {})
      // 与 recovery 路径一致：重建为已知状态后清除残留推进阻塞原因，避免视图展示过期信息
      delete existing.metadata["_advance_block_reason"]
      continue
    }

    const item = existing ?? createInitialWorkItem({
      id: `task:${group.id}`,
      source: "openspec",
      externalId: group.id,
      type: "task",
      title: group.name,
      description: group.name,
      labels: ["openspec-change"],
    })

    // reopenIssues：已完成组继续修 issue（children 未终态置 todo + reject_reason、清 verify_* tags）
    if (args.recovery?.reopenIssues) {
      const closed = item.metadata["completed_at"] !== undefined || item.phase === "done"
      if (!closed) {
        throw new Error(`reopenIssues 仅支持已完成（completed）的任务组，当前 item.phase="${item.phase}"。`)
      }
      if (args.recovery.phase !== "dev_impl") {
        throw new Error("reopenIssues 仅支持恢复到 dev_impl 阶段。")
      }
      if (args.recovery.review_layer) {
        throw new Error("reopenIssues 与 review_layer 互斥，不可同时使用。")
      }
      for (const child of item.children) {
        if (isTerminalPhase(child.phase)) continue
        child.phase = "todo"
        child.metadata["reject_reason"] = child.metadata["reject_reason"] ?? "通过 reopenIssues 自动驳回"
      }
      for (const key of Object.keys(item.tags)) {
        if (key.startsWith("verify_")) delete item.tags[key]
      }
      delete item.metadata["completed_at"]
      item.metadata["worktree_path"] = null
      item.metadata["branch_name"] = null
      item.metadata["base_ref"] = null
    }

    applyRecoveryState(item, args.recovery, groupTasks, state)
    refreshMeta(item)
    if (!existing) state.workItems.push(item)
  }

  state.taskGroupId = args.task_group_id
  await writeState(ctx.worktree, state)

  const parts = ["编排会话已初始化。"]
  if (args.recovery) parts.push(`已恢复到 ${args.recovery.phase} 阶段。`)
  if (modeSwitchNote) parts.push(modeSwitchNote)
  // review_layer 在 simple 模式下无对应子层（仅 quality_review 单层审查），该参数接受但不生效：
  // 返回体显式警告，避免调用方误以为已按子层恢复
  if (args.recovery?.review_layer && (state.mode ?? "full") === "simple") {
    parts.push("\n\n⚠️ simple 模式无 review 子层（仅 quality_review 单层审查），recovery.review_layer 参数未生效。")
  }
  return parts.join("")
}

/** 独立审查会话的 worktree 引用绑定（双基准拆分）：
 *  - merge_target（合回目标）独立存 metadata：fix 模式收尾合回（pr=head_ref、full=当前分支，即 baseBranch）；fix=none 收尾销毁不合并；
 *  - base_ref（审查锚点）仅 pr 形态设置 = merge-base(base_ref, head_ref)；full 形态不设（全量语义，视图渲染「全量代码库」锚点）。 */
async function bindReviewWorktreeRefs(item: WorkItem, worktreePath: string, branch: string, state: OrchestrateState): Promise<void> {
  item.metadata["worktree_path"] = worktreePath
  item.metadata["branch_name"] = branch
  item.metadata["merge_target"] = state.baseBranch
  if (state.reviewScope?.scopeType === "pr" && state.reviewScope.baseRef) {
    const baseRef = await getMergeBase(worktreePath, state.reviewScope.baseRef)
    if (baseRef) {
      item.metadata["base_ref"] = baseRef
      return
    }
  }
  delete item.metadata["base_ref"]
}

/**
 * change 会话 worktree 引用绑定（任务组范围标记）：
 * - worktree_path/branch_name 写入（常驻 worktree 与 change 分支，各任务组写相同值）；
 * - scope_start_oid：仅 item 首次绑定时记录当时 change 分支 HEAD（分支 tip）——重调/recovery 重入不重记
 *   （否则本任务组早前提交会被剔除出审查范围）；已记 oid 不在当前分支历史（如分支重建）才允许重记；
 * - base_ref 存显式 scope 端点（scope_start..HEAD），作为变更范围查询与本轮 diff 锚点
 *   （替代旧 merge-base(HEAD, baseBranch) 的 change 级口径）；oid 失效由 detectChanges 既有降级兜底。
 */
async function bindWorktreeRefs(
  item: WorkItem,
  worktreePath: string,
  branch: string,
): Promise<void> {
  item.metadata["worktree_path"] = worktreePath
  item.metadata["branch_name"] = branch
  const existing = item.metadata["scope_start_oid"]
  if (typeof existing !== "string" || !(await isAncestor(worktreePath, existing, branch))) {
    const head = (await runGit(worktreePath, ["rev-parse", branch])).trim()
    if (!head) throw new Error(`worktree 绑定成功但无法获取 ${branch} 的 HEAD：${worktreePath}`)
    item.metadata["scope_start_oid"] = head
  }
  item.metadata["base_ref"] = item.metadata["scope_start_oid"]
}

/** change 会话分支确定性派生：change/{changeId}（changeId 经会话 token 归一，非法字符归一为 -）。 */
function deriveChangeBranch(changeId: string): string {
  return `change/${normalizeSessionToken(changeId)}`
}

/**
 * create-or-reuse：分支不存在 → 从基准分支创建（不检出，git 解析基准分支 tip）；存在 → 复用。
 * 触点两处：set_worktree 与 complete（合并目标解析前）——在途旧模型会话升级时从当前基准 tip 创建，
 * 天然含已合入代码。返回是否为新创建。
 */
async function ensureChangeBranch(repoRoot: string, branch: string, baseBranch: string): Promise<boolean> {
  if (await isLocalBranch(repoRoot, branch)) return false
  const created = await runGitChecked(repoRoot, ["branch", branch, baseBranch])
  if (!created.success) throw new Error(`创建分支 "${branch}"（fork 自 ${baseBranch}）失败：${created.stderr}`)
  return true
}

/**
 * change 会话常驻 worktree 就位（create-or-reuse）：
 * - 分支由 ensureChangeBranch 保证存在（首个任务组从基准 tip 创建，后续任务组复用）；
 * - 按 git 管理记录找检出了该分支的 worktree，找到即复用（分支匹配由按 branch 检索保证）；
 *   未找到用规范路径（.worktree/{changeId}/ws 或显式 worktree_path）：
 *   ①目录不存在（或仅剩幽灵管理记录）→ `git worktree prune` 后全新创建 checkout change 分支
 *   （修复旧逻辑目录已删时 rev-list 返回空 → parseInt NaN 误入复用分支的洞）；
 *   ②目录存在但无本分支管理记录 → 交由 `git worktree add` 自身语义处理（空目录可建；非空非 worktree
 *   目录由 git 拒绝，透传错误提示人工处理）；
 *   ③目录存在且检出本分支 → 脏分类：仅 openspec/ 路径脏 → 自动 commit 兜底（与主仓库侧对称）；
 *   含代码文件脏 → 拒绝并提示人工处理；
 * - 就位后 bindWorktreeRefs 绑定引用并记录任务组 scope 端点。
 */
async function ensureChangeWorktree(
  repoRoot: string,
  state: OrchestrateState,
  item: WorkItem,
  branch: string,
  defaultPath: string,
): Promise<{ path: string; reused: boolean }> {
  await ensureChangeBranch(repoRoot, branch, state.baseBranch)

  const wtList = await runGit(repoRoot, ["worktree", "list"])
  const existingLine = wtList.split("\n").find((l) => {
    const m = l.match(/^(\S+)\s+[0-9a-f]+\s+\[(.+?)\]/)
    return m && m[2].trim() === branch
  })
  const registeredPath = existingLine ? existingLine.match(/^(\S+)/)?.[1] : undefined
  const targetPath = registeredPath ?? defaultPath

  if (!(await pathExists(targetPath))) {
    // 目录不存在：管理记录残留（幽灵 worktree）时先 prune，再全新创建 checkout change 分支
    await runGitChecked(repoRoot, ["worktree", "prune"])
    await runGit(repoRoot, ["worktree", "add", targetPath, branch])
    await bindWorktreeRefs(item, targetPath, branch)
    return { path: targetPath, reused: false }
  }

  if (!registeredPath) {
    // 目录存在但不是检出本分支的 git 管理记录：交由 git worktree add 判定（空目录放行、非空目录拒绝）
    const addRes = await runGitChecked(repoRoot, ["worktree", "add", targetPath, branch])
    if (!addRes.success) {
      throw new Error(
        `无法在 "${targetPath}" 就位 worktree：目录已存在且不是检出分支 "${branch}" 的 git worktree（git: ${addRes.stderr}）。\n` +
        `请人工确认该目录内容并处理（删除或迁移）后重试。`
      )
    }
    await bindWorktreeRefs(item, targetPath, branch)
    return { path: targetPath, reused: false }
  }

  // 目录存在且检出本分支 → 复用候选：脏分类（openspec/ 脏自动 commit 兜底；代码文件脏拒绝）
  const statusOut = await runGit(targetPath, ["status", "--porcelain"])
  const dirtyPaths = statusOut.split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const f = l.replace(/^\S+\s+/, "")
      return (f.includes(" -> ") ? f.split(" -> ").pop()! : f).replace(/^"+|"+$/g, "")
    })
    .filter(Boolean)
  const codeDirty = dirtyPaths.filter((p) => !p.startsWith("openspec/"))
  if (codeDirty.length > 0) {
    throw new Error(
      `已有 worktree "${targetPath}" 存在未提交的代码文件变更（${codeDirty.join("、")}），无法自动处理。\n` +
      `请先在该 worktree 内 commit 或 stash 后重试。`
    )
  }
  if (dirtyPaths.length > 0) {
    const addResult = await runGitChecked(targetPath, ["add", "--", ...dirtyPaths])
    if (!addResult.success) throw new Error(`worktree openspec 目录 git add 失败：${addResult.stderr}`)
    const commitResult = await runGitChecked(targetPath, ["commit", "-m", "docs(openspec): auto-commit before worktree reuse"])
    if (!commitResult.success) throw new Error(`worktree openspec 目录 git commit 失败：${commitResult.stderr}`)
  }
  await bindWorktreeRefs(item, targetPath, branch)
  return { path: targetPath, reused: true }
}

export async function setWorktreeExecute(params: SetWorktreeParams, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx, "opx_orch_set_worktree")
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const item = state.workItems.find((w) => w.id === `task:${state.taskGroupId}`)
  if (!item) throw new Error(`工作项 "task:${state.taskGroupId}" 缺失，请重新调用 opx_orch_init。`)

  const repoRoot = ctx.worktree
  const isReview = state.kind === "review"
  // branch_name 可为空（缺省按会话形态派生），仅显式传入时用 git check-ref-format 严格校验。
  // 用 --branch 形态（而非 refs/heads/<name>）：前者拒绝前导 `-` 等 git branch 创建亦拒绝的非法分支名，
  // 后者仅检查 refname 合法性，会放行前导 dash 的 plain ref。
  const rawBranch = params.branch_name ?? ""
  if (rawBranch !== "") {
    const check = await runGitChecked(repoRoot, ["check-ref-format", "--branch", rawBranch])
    if (!check.success) {
      throw new Error(`分支名 "${rawBranch}" 不合法，请修正后重试。`)
    }
  }
  // 独立审查会话（旧模型完整保留）：分支命名 review/<sessionId>、worktree 布局 .worktree/<sessionId>/review
  // （discoverDiskWorktrees 按 review/ 前缀识别为可恢复磁盘痕迹）；
  // change 会话：分支确定性派生 change/{changeId}、常驻 worktree .worktree/{changeId}/ws，全部任务组串行复用
  const branch = rawBranch || (isReview ? `review/${state.changeId}` : deriveChangeBranch(state.changeId))
  if (!isReview) {
    const check = await runGitChecked(repoRoot, ["check-ref-format", "--branch", branch])
    if (!check.success) {
      throw new Error(`派生分支名 "${branch}" 不合法（change_id="${state.changeId}"），请修正 change_id 或显式传入 branch_name。`)
    }
  }
  let wtPath: string
  if (params.worktree_path) {
    wtPath = assertPathWithin(repoRoot, params.worktree_path, "worktree_path")
  } else {
    wtPath = isReview
      ? path.join(repoRoot, ".worktree", state.changeId, "review")
      : path.join(repoRoot, ".worktree", state.changeId, "ws")
  }

  const changeStatus = await runGit(repoRoot, ["status", "--porcelain", `openspec/changes/${state.changeId}/`])
  if (changeStatus.trim().length > 0) {
    const addResult = await runGitChecked(repoRoot, ["add", `openspec/changes/${state.changeId}/`])
    if (!addResult.success) throw new Error(`change 目录 git add 失败：${addResult.stderr}`)
    const commitResult = await runGitChecked(repoRoot, ["commit", "-m", "docs(openspec): auto-commit before worktree setup"])
    if (!commitResult.success) throw new Error(`change 目录 git commit 失败：${commitResult.stderr}`)
  }

  let reused = false
  if (isReview) {
    const wtList = await runGit(repoRoot, ["worktree", "list"])
    const existingLine = wtList.split("\n").find((l) => {
      const m = l.match(/^(\S+)\s+[0-9a-f]+\s+\[(.+?)\]/)
      return m && m[2].trim() === branch
    })
    const existingPath = existingLine ? existingLine.match(/^(\S+)/)?.[1] : undefined

    if (existingPath) {
      const baseHead = await runGit(repoRoot, ["rev-parse", state.baseBranch])
      const mergeResult = await runGitChecked(existingPath, ["merge", "--ff-only", baseHead])
      if (mergeResult.success) {
        await bindReviewWorktreeRefs(item, existingPath, branch, state)
        reused = true
      } else {
        const clean = await isWorktreeClean(existingPath)
        if (!clean) {
          throw new Error(
            `已有 worktree "${existingPath}" 与 ${state.baseBranch} 分叉且有未提交变更，无法自动 fast-forward。\n` +
            `请手动处理后重试。`
          )
        }
        const localCommitCount = parseInt(
          await runGit(existingPath, ["rev-list", "--count", `${state.baseBranch}..HEAD`]),
          10
        )
        if (localCommitCount > 0 || Number.isNaN(localCommitCount)) {
          await bindReviewWorktreeRefs(item, existingPath, branch, state)
          reused = true
        } else {
          // 复用失败的清理走共享清理函数：目录侧（git remove + fs 兜底 + prune）与分支删除统一语义
          const cleanup = await removeTaskGroupWorktree(repoRoot, existingPath, { branchName: branch })
          if (!cleanup.dirResolved || cleanup.branchDeleted === false) {
            const problems: string[] = []
            if (!cleanup.dirResolved) problems.push(`无法清理已有 worktree "${existingPath}"`)
            if (cleanup.branchDeleted === false) problems.push(`无法清理已有分支 "${branch}"`)
            throw new Error(`${problems.join("；")}：${cleanup.errors.join("；") || "原因未知"}\n请手动处理后重试。`)
          }
        }
      }
    }

    if (!reused) {
      // 建分支 fork 源：pr 形态为 head_ref、full 形态为当前分支（两者均为 state.baseBranch）
      const forkBranch = state.baseBranch
      await runGit(repoRoot, ["worktree", "add", "-b", branch, wtPath, forkBranch])
      await bindReviewWorktreeRefs(item, wtPath, branch, state)
      // pr 形态审查锚点（merge-base）必须可得，缺失即建引用失败
      if (state.reviewScope?.scopeType === "pr" && !item.metadata["base_ref"]) {
        throw new Error(`worktree 创建成功但无法获取 ${state.reviewScope.baseRef} 与 ${state.baseBranch} 的 merge-base：${wtPath}`)
      }
    }
  } else {
    const ensured = await ensureChangeWorktree(repoRoot, state, item, branch, wtPath)
    wtPath = ensured.path
    reused = ensured.reused
  }

  await writeState(ctx.worktree, state)

  // 在 worktree 中写入上下文指针，供 worktree 内 session 读取 state
  const storedPath = typeof item.metadata["worktree_path"] === "string" ? item.metadata["worktree_path"] : null
  if (storedPath) {
    await writeContextToWorktree(storedPath, state.changeId, state.taskGroupId)
  }

  return [
    `- **状态**: ${reused ? "复用已有 worktree" : "已创建 worktree"}`,
    `- **路径**: \`${item.metadata["worktree_path"]}\``,
    `- **分支**: \`${branch}\``,
  ].join("\n")
}

export async function statusExecute(params: StatusParams, ctx: ToolContext): Promise<string> {
  const agent = ctx.agent
  const state = await readStateByWorktree(ctx.worktree, params.change_id)

  if (!state) {
    if (ctx.orchestrator) {
      const diskWts = await discoverDiskWorktrees(ctx.worktree)
      if (diskWts.length > 0) {
        const lines = ["# 编排进度", "", "**状态文件**: 未初始化", "", "## 磁盘 Worktree（可恢复进度）", ""]
        lines.push("| 分支 | 路径 |")
        lines.push("|------|------|")
        for (const w of diskWts) lines.push(`| ${w.branch} | \`${w.path}\` |`)
        lines.push("")
        lines.push("请用 question 工具询问用户确认恢复目标，然后调用 opx_orch_init(recovery=...)。")
        return lines.join("\n")
      }
    }
    return "编排会话尚未初始化。请先调用 opx_orch_init。"
  }

  const item = state.workItems.find((w) => w.id === `task:${state.taskGroupId}`)
  if (!item) {
    return "编排会话未就绪：找不到活跃任务组的工作项，请重新调用 opx_orch_init。"
  }

  // 单轨：一律由工作流引擎推荐（recommendForItem）渲染动态视图，按调用者角色分流
  // 按 state.mode 选择 workflow 文件（simple → task-simple.yaml；旧 state 缺 mode 兜底 full）
  const workflow = loadWorkflowFile(resolveWorkflowPath(state))
  const rec = recommendForItem(item, workflow)
  const tg = findTaskGroup(state, state.taskGroupId)
  // 主仓库 openspec 污染诊断（56ddfe9 意图）：编排者分派视图展示主仓库污染，供编排者人工核对
  const mainPollution = ctx.orchestrator ? await detectMainRepoPollution(ctx.worktree) : null
  // tool review 检查点增量检测（A4）：full 的 verify_tool（reviewer-tool）与 simple 的 quality_review
  // （合并审查者 openspec-reviewer）工作视图均按「检查点 → 当前 HEAD」区间变更分流。渲染层为同步函数，
  // 此处预计算后经 WorkflowStatusViewOptions 传入。仅推荐分派对应 agent 时计算（verify_tool → reviewer-tool、
  // quality_review → openspec-reviewer），其余角色/step 不产生额外 git 调用。
  let toolChanges: DetectChangesResult | undefined
  const changesEvidenceStep =
    rec.status === "recommend" &&
    rec.agents.includes(agent) &&
    ((agentToReviewLayer(agent) === "tool" && rec.stepId === "verify_tool") ||
      (agent === "openspec-reviewer" && rec.stepId === "quality_review"))
  if (changesEvidenceStep) {
    const wtPath = typeof item.metadata["worktree_path"] === "string" ? item.metadata["worktree_path"] : undefined
    if (wtPath) {
      const checkpoint =
        typeof item.metadata["_tool_review_checkpoint"] === "string" ? item.metadata["_tool_review_checkpoint"] : undefined
      const baseRef = typeof item.metadata["base_ref"] === "string" ? item.metadata["base_ref"] : undefined
      // 独立审查 full 形态：审查锚点为全量代码库，返回全量哨兵（视图渲染「全量代码库」而非「未检出变更」）
      const scopeFull = state.kind === "review" && state.reviewScope?.scopeType === "full"
      toolChanges = await detectChanges(wtPath, { checkpoint, baseRef, scopeFull })
    }
  }
  // 统计本 change 命中项目级跨 change 豁免清单的存量问题数（工具层降级时写入 exempted_hit 标记）
  const exemptedHits = item.children.filter((c) => c.type === "issue" && c.metadata["exempted_hit"] !== undefined).length
  // 渲染期豁免清单提示数据源：渲染前异步读取一次（renderChildIssue 为同步函数，清单条目以参数传入，不在循环内重复读）
  const exemptionItems = (await readExemptions(ctx.worktree)).items
  return renderWorkflowStatusView(item, workflow, rec, { agent, orchestrator: ctx.orchestrator, identityDeclared: ctx.identityDeclared }, { state, tg, mainPollution, toolChanges, exemptedHits, exemptionItems })
}

/**
 * 收尾后清扫默认布局的空父目录（`.worktree/<changeId>` 与 `.worktree`）：
 * 仅对这两级字面路径做非递归 rmdir（空目录才会成功），任一失败静默忽略。
 * 自定义 worktree_path 时以「被删目录的实际 dirname === `.worktree/<changeId>`」判定是否可扫第一级，
 * 第二级固定只试 `.worktree` 本身；其余任意父路径一律不做处理。
 */
async function sweepEmptyWorktreeParents(repoRoot: string, removedDir: string, changeId: string): Promise<void> {
  const repoRootAbs = path.resolve(repoRoot)
  const groupLevelDir = path.join(repoRootAbs, ".worktree", changeId)
  const worktreeLevelDir = path.join(repoRootAbs, ".worktree")
  if (path.dirname(path.resolve(removedDir)) === groupLevelDir) {
    try { await rmdir(groupLevelDir) } catch {}
  }
  try { await rmdir(worktreeLevelDir) } catch {}
}

/** 独立审查会话收尾的审查结果摘要：issue 按严重级别与维度归并计数（markdown）。 */
function renderReviewIssueSummary(item: WorkItem): string {
  const issues = item.children.filter((c) => c.type === "issue")
  const lines = ["## 审查结果摘要", ""]
  if (issues.length === 0) {
    lines.push("- 未报出任何 issue。", "")
    return lines.join("\n")
  }
  const bySeverity = new Map<string, number>()
  const byDimension = new Map<string, number>()
  for (const c of issues) {
    const sev = c.severity ?? "Info"
    const dim = String(c.metadata["dimension"] ?? "style")
    bySeverity.set(sev, (bySeverity.get(sev) ?? 0) + 1)
    byDimension.set(dim, (byDimension.get(dim) ?? 0) + 1)
  }
  lines.push(`- **issue 总数**: ${issues.length}`)
  lines.push(`- **按严重级别**: ${[...bySeverity.entries()].map(([k, v]) => `${k}=${v}`).join("、")}`)
  lines.push(`- **按维度**: ${[...byDimension.entries()].map(([k, v]) => `${k}=${v}`).join("、")}`)
  lines.push("")
  lines.push("| severity | dimension | 文件位置 | 描述 |", "|----------|-----------|----------|------|")
  for (const c of issues) {
    const file = typeof c.metadata["file"] === "string" ? c.metadata["file"] : ""
    const line = typeof c.metadata["line"] === "number" ? c.metadata["line"] : 0
    const loc = file ? `${file}${line > 0 ? `:${line}` : ""}` : "(无)"
    lines.push(`| ${c.severity ?? "Info"} | ${String(c.metadata["dimension"] ?? "style")} | \`${loc}\` | ${c.description.replace(/\|/g, "\\|")} |`)
  }
  lines.push("")
  return lines.join("\n")
}

/**
 * 最后任务组收口被基准分支漂移/文本冲突拦截时的回退：
 * 该任务组回退到收尾验证（verify_cleanup）等待重新收口——phase 回退 + clearStepTags + 按 recovery
 * 先例清除残留推进阻塞原因/检查点标记并重置内部重试计数（防回退后检查点误触发死锁），
 * 同时删除本轮回写的 scope_end_oid（重新收口时重记）。worktree 与 change 分支保留，未执行合并（无半成品）。
 * 落点要求工作流声明 id=verify_cleanup 的 step：解析不到 → 不回退（返回 false），沿用人工处理 blocked
 * 文案（防工具先上、配置未同步窗口）。
 */
function rollbackToCleanupStep(item: WorkItem, workflow: LoadedWorkflow): boolean {
  if (!workflow.stepMap.has("verify_cleanup")) return false
  delete item.metadata["_advance_block_reason"]
  delete item.metadata["_checkpoint"]
  resetInternalRetryCount(item)
  clearStepTags(item, "verify_cleanup")
  delete item.metadata["scope_end_oid"]
  item.phase = "review"
  item.currentStep = "verify_cleanup"
  return true
}

/** 最后任务组收口 blocked 返回体（事实文案，结尾统一指引重新查询 opx_status；不含任何「请分派 X」流转指令）。 */
function renderFinalizeBlocked(
  reasons: string[],
  handlings: string[],
  opts: { branchName: string; mergeTarget: string; rolledBack: boolean; checkboxWarning?: string },
): string {
  const lines = [
    `- **status**: blocked`,
    ...reasons.map((r) => `- **原因**: ${r}`),
    `- **说明**: worktree 与变更分支 \`${opts.branchName}\` 已保留；未执行合并，无半成品状态。属多 change 并行推进的预期行为。` +
      (opts.rolledBack ? "本任务组状态已回退到收尾验证（verify_cleanup）。" : ""),
    ...handlings.map((h) => `- **处理**: ${h}`),
    "",
    "重新查询 opx_status 获取分派指引。",
  ]
  if (opts.checkboxWarning) lines.push(opts.checkboxWarning)
  return lines.join("\n")
}

export async function completeTaskGroupExecute(params: { change_id: string }, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx, "opx_orch_complete_task_group")
  // 全程文件锁（与 opx_agent_submit 同粒度）：complete 是 read-modify-write 全程，防并发完成丢状态
  const lockPath = await getLockPath(ctx.worktree, params.change_id)
  await acquireLock(lockPath)
  try {
    return await completeTaskGroupLocked(params, ctx)
  } finally {
    releaseLock(lockPath)
  }
}

async function completeTaskGroupLocked(params: { change_id: string }, ctx: ToolContext): Promise<string> {
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const item = state.workItems.find((w) => w.id === `task:${state.taskGroupId}`)
  if (!item) throw new Error(`工作项 "task:${state.taskGroupId}" 缺失，请重新调用 opx_orch_init。`)

  if (item.phase !== "done" || item.metadata["completed_at"] !== undefined) {
    throw new Error(
      `阶段顺序错误：opx_orch_complete_task_group 需在 review 完成后调用。\n` +
      `- item.phase=${item.phase}\n` +
      `- completed_at=${item.metadata["completed_at"] ?? "(未设置)"}`
    )
  }

  const worktreePath = typeof item.metadata["worktree_path"] === "string" ? item.metadata["worktree_path"] : null
  const branchName = typeof item.metadata["branch_name"] === "string" ? item.metadata["branch_name"] : null

  if (worktreePath) {
    const clean = await isWorktreeClean(worktreePath)
    if (!clean) throw new Error(`worktree "${worktreePath}" 存在未 commit 内容，请先 commit 再完成任务组。`)
  }

  // 独立审查会话双维度放宽（其余门禁不动）：
  // - fix=none（只审）：issue 报告即交付物，openIssues 门禁放宽（issue 停留 todo 态为合法收口形态）；
  // - 审并修（fix，两种颗粒度）：门禁保留（阻塞 issue 未终态拒绝收尾）。
  const isReview = state.kind === "review"
  const isReviewNone = isReview && state.reviewScope?.fix === "none"
  const openIssues = item.children.filter((c) => isBlockingSeverity(c.severity) && !isTerminalPhase(c.phase))
  if (!isReviewNone && openIssues.length > 0) {
    throw new Error(`存在 ${openIssues.length} 个 Low 及以上的未解决 issue 未处理，请先修复或申请豁免。`)
  }

  // task children 须全部终态（done/cancelled）才能收尾
  const openTasks = taskChildrenOf(item).filter((c) => !isTerminalPhase(c.phase))
  if (openTasks.length > 0) {
    throw new Error(`存在 ${openTasks.length} 个未完成 task。`)
  }

  const blockers = Array.isArray(item.metadata["blockers"])
    ? (item.metadata["blockers"] as { status: string }[])
    : []
  const unresolvedBlockers = blockers.filter((blocker) => blocker.status !== "resolved")
  if (unresolvedBlockers.length > 0) {
    throw new Error(`存在 ${unresolvedBlockers.length} 个未解决 blocker，无法完成任务组。`)
  }

  // tasks.md 复选框统一在收尾勾选（原 G19 语义迁移）：仅写 worktree，随合并带回主分支；失败不阻断收尾
  let checkboxWarning = ""
  if (worktreePath) {
    try {
      await markTaskGroupCheckboxesComplete(worktreePath, params.change_id, state.taskGroupId)
    } catch (e) {
      checkboxWarning = `- **tasks.md 复选框勾选失败**: ${e instanceof Error ? e.message : String(e)}（不影响收尾）`
    }
  }
  // scope_end 端点（change 会话）：勾选本身产生新提交，端点在勾选之后记录为当时 change 分支 HEAD（分支 tip）
  if (!isReview && worktreePath && branchName) {
    const endOid = (await runGit(worktreePath, ["rev-parse", branchName])).trim()
    if (endOid) item.metadata["scope_end_oid"] = endOid
  }

  if (isReview) {
    return finalizeReviewSession(state, item, params, ctx, { worktreePath, branchName, isReviewNone, checkboxWarning })
  }

  // ─── change 会话：任务组完成按「是否最后一个收口任务组」分流 ───
  if (!isFinalTaskGroup(state, item)) {
    // 非最后任务组：门禁 → 勾选 → scope_end → completed_at；无合并、无销毁
    item.metadata["completed_at"] = new Date().toISOString()
    await writeState(ctx.worktree, state)
    const doneMessage =
      "任务组已完成。本任务组变更保留在 change 分支上，待全部任务组完成后统一收口合并（本次不合并、不销毁 worktree）。"
    return checkboxWarning ? `${doneMessage}\n${checkboxWarning}` : doneMessage
  }

  // 最后任务组 → change 级收口：合并 change 分支回基准分支（一次性），成功后销毁 worktree 并删分支
  const mergeTarget = state.baseBranch
  if (branchName) {
    // create-or-reuse（合并目标解析前）：在途旧模型会话升级时从当前基准 tip 创建，天然含已合入代码
    await ensureChangeBranch(ctx.worktree, branchName, mergeTarget)

    // 前置漂移检查（独立封装）：基准 tip 须为 change 分支祖先；不满足 → 回退收尾验证并 blocked
    if (!(await isAncestor(ctx.worktree, mergeTarget, branchName))) {
      const workflow = loadWorkflowFile(resolveWorkflowPath(state))
      const rolledBack = rollbackToCleanupStep(item, workflow)
      if (rolledBack) await writeState(ctx.worktree, state)
      return renderFinalizeBlocked(
        [
          `基准分支 \`${mergeTarget}\` 已推进（与变更分支 \`${branchName}\` 存在漂移）：基准分支最新提交未包含在变更分支历史中，直接合并会遗漏基准分支新内容。`,
        ],
        [
          `在 worktree 内执行 \`git merge ${mergeTarget}\` 合入基准分支最新代码并解决冲突，完成回归验证后重新提交收尾验证（opx_agent_submit，step_id="verify_cleanup"），通过后再调用 opx_orch_complete_task_group 重新收口。`,
        ],
        { branchName, mergeTarget, rolledBack, checkboxWarning },
      )
    }

    const mergeResult = await mergeBranchToTarget(ctx.worktree, branchName, mergeTarget)
    if (mergeResult.blockedMessage) {
      // 主仓库侧前置拦截（检出冲突/脏文件重合/部分暂存）：未执行任何合并动作，状态不变，人工处理后重调
      return [`- **status**: blocked`, mergeResult.blockedMessage].join("\n")
    }
    if (!mergeResult.success) {
      // 文本冲突 → 与漂移同路径回退（原冲突指引文案替换为回退口径）
      const workflow = loadWorkflowFile(resolveWorkflowPath(state))
      const rolledBack = rollbackToCleanupStep(item, workflow)
      if (rolledBack) await writeState(ctx.worktree, state)
      return renderFinalizeBlocked(
        [
          `变更分支 \`${branchName}\` 合并到 \`${mergeTarget}\` 时发生冲突，未产生任何变更（分支引用未动，无半成品合并）。`,
        ],
        [
          `在 worktree 内执行 \`git merge ${mergeTarget}\` 合入基准分支最新代码解决冲突并提交，完成回归验证后重新提交收尾验证（opx_agent_submit，step_id="verify_cleanup"），通过后再调用 opx_orch_complete_task_group 重新收口。`,
        ],
        { branchName, mergeTarget, rolledBack, checkboxWarning },
      )
    }
  }

  // 合并成功（或无分支引用）：收口清理（销毁 worktree + 删分支）。
  // 残留不阻断收口：completed_at 照写，残留信息写入 metadata.cleanup_residual 并在返回体给出人工处理命令。
  let cleanupNote = ""
  let cleanupResidualWarning = ""
  if (worktreePath) {
    const cleanup = await removeTaskGroupWorktree(ctx.worktree, worktreePath, { branchName })
    if (cleanup.dirResolved) {
      await sweepEmptyWorktreeParents(ctx.worktree, worktreePath, params.change_id)
      const successNotes: string[] = []
      if (cleanup.dirResolvedByFallback) {
        successNotes.push("- **cleanup**: git worktree remove 未直接移除目录，已按文件系统兜底删除并 prune 管理记录。")
      }
      if (cleanup.errors.length > 0) {
        successNotes.push(`- **cleanup 部分告警**: ${cleanup.errors.join("；")}`)
      }
      cleanupNote = successNotes.join("\n")
    } else {
      item.metadata["cleanup_residual"] = { worktree_path: worktreePath, errors: cleanup.errors }
      cleanupResidualWarning = [
        "",
        "## ⚠️ worktree 清理残留（不影响收口）",
        `- **残留路径**: \`${worktreePath}\``,
        "- **原因**:",
        ...cleanup.errors.map((e) => `  - ${e}`),
        `- **处理**: 请人工执行 \`rm -rf '${worktreePath}' && git worktree prune\` 清理残留目录与 git 管理记录。`,
        branchName ? `- **分支**: 分支 "${branchName}" 未删除。` : "",
      ].filter(Boolean).join("\n")
    }
  }
  item.metadata["completed_at"] = new Date().toISOString()
  await writeState(ctx.worktree, state)
  const notes = [cleanupNote, checkboxWarning, cleanupResidualWarning].filter(Boolean)
  const doneMessage = branchName
    ? `任务组已完成并合并到 "${mergeTarget}"。`
    : "任务组已完成（无变更分支引用，跳过合并）。"
  return notes.length > 0 ? `${doneMessage}\n${notes.join("\n")}` : doneMessage
}

/** 独立审查会话（kind=review）收尾：合并行为维持 baseBranch 口径（fix 模式合回 merge_target、
 *  fix=none 不合并不合并直接销毁），change 分支模型不介入。 */
async function finalizeReviewSession(
  state: OrchestrateState,
  item: WorkItem,
  params: { change_id: string },
  ctx: ToolContext,
  refs: { worktreePath: string | null; branchName: string | null; isReviewNone: boolean; checkboxWarning: string },
): Promise<string> {
  const { worktreePath, branchName, isReviewNone, checkboxWarning } = refs
  const mergeTarget = state.baseBranch
  if (branchName && !isReviewNone) {
    const mergeResult = await mergeBranchToTarget(ctx.worktree, branchName, mergeTarget)
    if (mergeResult.blockedMessage) {
      return [`- **status**: blocked`, mergeResult.blockedMessage].join("\n")
    }
    if (!mergeResult.success) {
      return [
        `- **status**: blocked`,
        `- **merge_conflict**: true`,
        `- **说明**: 合并到 "${mergeTarget}" 时发生冲突，未产生任何变更（分支引用未动，无半成品合并）。`,
        `- **处理**: 请自行执行 \`git checkout ${mergeTarget} && git merge ${branchName}\` 解决冲突并提交，完成后重新调用 opx_orch_complete_task_group 完成收尾（重调时工具会自动识别已合并并继续）。worktree 与分支已保留。`,
      ].join("\n")
    }
  }
  // 收尾清理：只要记录了 worktree_path 就执行；branch_name 缺省时仅做 worktree 侧清理。
  // 残留不阻断收尾：completed_at 照写，残留信息写入 metadata.cleanup_residual 并在返回体给出人工处理命令。
  let cleanupNote = ""
  let cleanupResidualWarning = ""
  if (worktreePath) {
    const cleanup = await removeTaskGroupWorktree(ctx.worktree, worktreePath, { branchName })
    if (cleanup.dirResolved) {
      await sweepEmptyWorktreeParents(ctx.worktree, worktreePath, params.change_id)
      const successNotes: string[] = []
      if (cleanup.dirResolvedByFallback) {
        successNotes.push("- **cleanup**: git worktree remove 未直接移除目录，已按文件系统兜底删除并 prune 管理记录。")
      }
      if (cleanup.errors.length > 0) {
        successNotes.push(`- **cleanup 部分告警**: ${cleanup.errors.join("；")}`)
      }
      cleanupNote = successNotes.join("\n")
    } else {
      item.metadata["cleanup_residual"] = { worktree_path: worktreePath, errors: cleanup.errors }
      cleanupResidualWarning = [
        "",
        "## ⚠️ worktree 清理残留（不影响收尾）",
        `- **残留路径**: \`${worktreePath}\``,
        "- **原因**:",
        ...cleanup.errors.map((e) => `  - ${e}`),
        `- **处理**: 请人工执行 \`rm -rf '${worktreePath}' && git worktree prune\` 清理残留目录与 git 管理记录。`,
        branchName ? `- **分支**: 分支 "${branchName}" 未删除。` : "",
      ].filter(Boolean).join("\n")
    }
  }
  item.metadata["completed_at"] = new Date().toISOString()
  await writeState(ctx.worktree, state)
  const notes = [cleanupNote, checkboxWarning, cleanupResidualWarning].filter(Boolean)
  // 独立审查会话收尾返回审查结果摘要（issue 计数按严重级别/维度归并，只审模式的交付物形态）
  const summary = renderReviewIssueSummary(item)
  const doneMessage = isReviewNone
    ? `独立审查会话已完成（只审模式，未合并，worktree 与分支已销毁）。`
    : `独立审查会话已完成并合并到 "${mergeTarget}"。`
  return notes.length > 0 ? `${doneMessage}\n${notes.join("\n")}\n${summary}` : `${doneMessage}\n${summary}`
}

export async function setUnattendedExecute(params: UnattendedParams, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx, "opx_orch_set_unattended")
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  // enabled 缺省按 schema 声明 default=true 兜底（透传 input 不应用 zod default）
  state.unattended = params.enabled ?? true
  await writeState(ctx.worktree, state)
  const status = state.unattended ? "开启" : "关闭"
  return `无人值守模式已 **${status}**。启用后系统将自动处理决策点，不再 question 用户。`
}
