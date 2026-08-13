import path from "path"
import type { TaskItem, TaskStatus } from "../types.ts"
import { BUILD_PHASE_TARGETS, REVIEW_LAYERS, REVIEW_VERIFY_STEPS } from "../types.ts"
import { agentToReviewLayer } from "../constants.ts"
import { runGit, runGitChecked, getCurrentBranch, getMergeBase, isWorktreeClean, mergeBranchToTarget, discoverDiskWorktrees, detectMainRepoPollution, detectChanges, type DetectChangesResult } from "../git.ts"
import { readStateByWorktree, readStateByChangeId, writeState, writeContextToWorktree } from "../state.ts"
import { generateIsolationNamespace } from "../namespace.ts"
import { readExemptions } from "../exemptions.ts"
import { parseAllTaskGroupsFromMd, parseTasksMdForGroup, extractRelevantSpecsFromTasks } from "../tasks-md.ts"
import type { ParsedTask } from "../tasks-md.ts"
import { assertOrchestrator, findTaskGroup } from "../derive.ts"
import { assertPathWithin } from "../paths.ts"
import { loadWorkflowFile, TASK_WORKFLOW_PATH, type LoadedWorkflow } from "../workflow/loader.ts"
import { createInitialWorkItem, isBlockingSeverity, isTerminalPhase, recommendForItem, resetInternalRetryCount, adjudicateStep, clearStepTags } from "../workflow/engine.ts"
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
 */
function applyRecoveryState(
  item: WorkItem,
  recovery: InitParams["recovery"],
  parsedTasks: ParsedTask[],
): void {
  // 恢复重建为已知状态后清除残留推进阻塞原因，避免 orchestrator 视图展示过期信息
  delete item.metadata["_advance_block_reason"]
  // 清除内部重试计数：recovery 恢复后残留 _retryCount 会在下次回退时立即再次触发检查点（死锁）。
  resetInternalRetryCount(item)
  // 清除检查点标记残留：恢复重建为已知状态后 _checkpoint 已无意义（checkpoint 态属于中断中的 step）。
  delete item.metadata["_checkpoint"]
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
  // currentStep 前移：显式指向第一个未全 passed 的 review step（已全 passed 的子层跳过）
  const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
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
 * - reset_steps 必须为合法 verify step（verify_tool/verify_task/verify_quality），非空数组，
 *   仅当 phase=review 时允许存在，且与 review_layer 互斥（二者都操纵哪些 review step 通过）。
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
      throw new Error("reset_steps 不能为空数组，请至少指定一个 verify step。")
    }
    for (const stepId of recovery.reset_steps) {
      if (!(REVIEW_VERIFY_STEPS as readonly string[]).includes(stepId)) {
        throw new Error(
          `reset_steps 中的 step "${stepId}" 不合法，合法值：${REVIEW_VERIFY_STEPS.join("、")}。传入值："${stepId}"。`
        )
      }
    }
  }
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

  const parsedGroups = await parseAllTaskGroupsFromMd(ctx.worktree, args.change_id)
  if (parsedGroups.length === 0) {
    throw new Error(`无法从 tasks.md 解析出任务组，请检查文件 openspec/changes/${args.change_id}/tasks.md。`)
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
    tasksByGroup.set(g.id, await parseTasksMdForGroup(ctx.worktree, args.change_id, g.id))
  }

  // base_branch 是 ref 而非严格 branch：只做非空 + 无空白字符等基本检查（完整分支名校验由 git check-ref-format 承担）
  if (args.base_branch) {
    if (!args.base_branch.trim() || /\s/.test(args.base_branch)) {
      throw new Error(`base_branch 不合法："${args.base_branch}"。基准分支名不能为空或包含空白字符。`)
    }
  }
  const baseBranch = args.base_branch || await getCurrentBranch(ctx.worktree)
  let state = await readStateByChangeId(ctx.worktree, args.change_id)
  const wasCurrentGroup = state?.taskGroupId === args.task_group_id

  if (!state) {
    state = {
      changeId: args.change_id,
      isolationNamespace: generateIsolationNamespace(args.change_id),
      taskGroupId: args.task_group_id,
      baseBranch,
      workItems: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  } else {
    state.baseBranch = state.baseBranch || baseBranch
    state.isolationNamespace = state.isolationNamespace || generateIsolationNamespace(state.changeId)
  }

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
        item.currentStep = "analyze"
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

    applyRecoveryState(item, args.recovery, groupTasks)
    refreshMeta(item)
    if (!existing) state.workItems.push(item)
  }

  state.taskGroupId = args.task_group_id
  await writeState(ctx.worktree, state)

  return args.recovery
    ? `编排会话已初始化。已恢复到 ${args.recovery.phase} 阶段。`
    : "编排会话已初始化。"
}

async function bindWorktreeRefs(
  item: WorkItem,
  worktreePath: string,
  branch: string,
  baseBranch: string,
  opts: { requireBaseRef?: boolean } = {},
): Promise<void> {
  item.metadata["worktree_path"] = worktreePath
  item.metadata["branch_name"] = branch
  const baseRef = await getMergeBase(worktreePath, baseBranch)
  if (!baseRef) {
    if (opts.requireBaseRef) {
      throw new Error(`worktree 创建成功但无法获取与 ${baseBranch} 的 merge-base：${worktreePath}`)
    }
    return
  }
  item.metadata["base_ref"] = baseRef
}

export async function setWorktreeExecute(params: SetWorktreeParams, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx, "opx_orch_set_worktree")
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const item = state.workItems.find((w) => w.id === `task:${state.taskGroupId}`)
  if (!item) throw new Error(`工作项 "task:${state.taskGroupId}" 缺失，请重新调用 opx_orch_init。`)

  const repoRoot = ctx.worktree
  // branch_name 可为空（缺省自动生成分支名），仅显式传入时用 git check-ref-format 严格校验。
  // 用 --branch 形态（而非 refs/heads/<name>）：前者拒绝前导 `-` 等 git branch 创建亦拒绝的非法分支名，
  // 后者仅检查 refname 合法性，会放行前导 dash 的 plain ref。
  const rawBranch = params.branch_name ?? ""
  if (rawBranch !== "") {
    const check = await runGitChecked(repoRoot, ["check-ref-format", "--branch", rawBranch])
    if (!check.success) {
      throw new Error(`分支名 "${rawBranch}" 不合法，请修正后重试。`)
    }
  }
  const branch = rawBranch || `task-group/${state.changeId}/${state.taskGroupId}`
  let wtPath: string
  if (params.worktree_path) {
    wtPath = assertPathWithin(repoRoot, params.worktree_path, "worktree_path")
  } else {
    wtPath = path.join(repoRoot, ".worktree", state.changeId, `task-group-${state.taskGroupId}`)
  }

  const changeStatus = await runGit(repoRoot, ["status", "--porcelain", `openspec/changes/${state.changeId}/`])
  if (changeStatus.trim().length > 0) {
    const addResult = await runGitChecked(repoRoot, ["add", `openspec/changes/${state.changeId}/`])
    if (!addResult.success) throw new Error(`change 目录 git add 失败：${addResult.stderr}`)
    const commitResult = await runGitChecked(repoRoot, ["commit", "-m", "docs(openspec): auto-commit before worktree setup"])
    if (!commitResult.success) throw new Error(`change 目录 git commit 失败：${commitResult.stderr}`)
  }

  const wtList = await runGit(repoRoot, ["worktree", "list"])
  const existingLine = wtList.split("\n").find((l) => {
    const m = l.match(/^(\S+)\s+[0-9a-f]+\s+\[(.+?)\]/)
    return m && m[2].trim() === branch
  })
  const existingPath = existingLine ? existingLine.match(/^(\S+)/)?.[1] : undefined

  let reused = false
  if (existingPath) {
    const baseHead = await runGit(repoRoot, ["rev-parse", state.baseBranch])
    const mergeResult = await runGitChecked(existingPath, ["merge", "--ff-only", baseHead])
    if (mergeResult.success) {
      await bindWorktreeRefs(item, existingPath, branch, state.baseBranch)
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
        await bindWorktreeRefs(item, existingPath, branch, state.baseBranch)
        reused = true
      } else {
        const rmResult = await runGitChecked(repoRoot, ["worktree", "remove", existingPath, "--force"])
        if (!rmResult.success) {
          throw new Error(`无法清理已有 worktree "${existingPath}"：${rmResult.stderr}`)
        }
        const branchRmResult = await runGitChecked(repoRoot, ["branch", "-D", branch])
        if (!branchRmResult.success) {
          throw new Error(`无法清理已有分支 "${branch}"：${branchRmResult.stderr}`)
        }
      }
    }
  }

  if (!reused) {
    const forkBranch = state.baseBranch
    await runGit(repoRoot, ["worktree", "add", "-b", branch, wtPath, forkBranch])
    await bindWorktreeRefs(item, wtPath, branch, forkBranch, { requireBaseRef: true })
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
  const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
  const rec = recommendForItem(item, workflow)
  const tg = findTaskGroup(state, state.taskGroupId)
  // 主仓库 openspec 污染诊断（56ddfe9 意图）：编排者分派视图展示主仓库污染，供编排者人工核对
  const mainPollution = ctx.orchestrator ? await detectMainRepoPollution(ctx.worktree) : null
  // tool review 检查点增量检测（A4）：verify_tool 的 reviewer-tool 工作视图按「检查点 → 当前 HEAD」区间
  // 变更分流（直提 / 仅处理待复核项 / 全量）。渲染层为同步函数，此处预计算后经 WorkflowStatusViewOptions 传入。
  // 仅在推荐分派该 agent 时计算，其余角色/step 不产生额外 git 调用。
  let toolChanges: DetectChangesResult | undefined
  if (
    agentToReviewLayer(agent) === "tool" &&
    rec.status === "recommend" &&
    rec.stepId === "verify_tool" &&
    rec.agents.includes(agent)
  ) {
    const wtPath = typeof item.metadata["worktree_path"] === "string" ? item.metadata["worktree_path"] : undefined
    if (wtPath) {
      const checkpoint =
        typeof item.metadata["_tool_review_checkpoint"] === "string" ? item.metadata["_tool_review_checkpoint"] : undefined
      const baseRef = typeof item.metadata["base_ref"] === "string" ? item.metadata["base_ref"] : undefined
      toolChanges = await detectChanges(wtPath, { checkpoint, baseRef })
    }
  }
  // 统计本 change 命中项目级跨 change 豁免清单的存量问题数（工具层降级时写入 exempted_hit 标记）
  const exemptedHits = item.children.filter((c) => c.type === "issue" && c.metadata["exempted_hit"] !== undefined).length
  // 渲染期豁免清单提示数据源：渲染前异步读取一次（renderChildIssue 为同步函数，清单条目以参数传入，不在循环内重复读）
  const exemptionItems = (await readExemptions(ctx.worktree)).items
  return renderWorkflowStatusView(item, workflow, rec, { agent, orchestrator: ctx.orchestrator, identityDeclared: ctx.identityDeclared }, { state, tg, mainPollution, toolChanges, exemptedHits, exemptionItems })
}

export async function completeTaskGroupExecute(params: { change_id: string }, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx, "opx_orch_complete_task_group")
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

  const openIssues = item.children.filter((c) => isBlockingSeverity(c.severity) && !isTerminalPhase(c.phase))
  if (openIssues.length > 0) {
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

  const mergeTarget = state.baseBranch
  if (branchName) {
    const mergeResult = await mergeBranchToTarget(ctx.worktree, branchName, mergeTarget)
    if (!mergeResult.success) {
      return [
        `- **status**: blocked`,
        `- **merge_conflict**: true`,
        `- **说明**: 合并到 "${mergeTarget}" 时发生冲突，已中止合并。`,
        `- **处理**: 请手动在目标分支解决冲突后完成合并 (git merge ${branchName})，完成后重新调 opx_orch_complete_task_group 完成收尾。worktree 与分支已保留。`,
      ].join("\n")
    }
  }
  if (worktreePath && branchName) {
    try {
      await runGit(ctx.worktree, ["worktree", "remove", worktreePath, "--force"])
      await runGit(ctx.worktree, ["branch", "-D", branchName])
    } catch {
    }
  }
  item.metadata["completed_at"] = new Date().toISOString()
  await writeState(ctx.worktree, state)
  return `任务组已完成并合并到 "${mergeTarget}"。`
}

export async function setUnattendedExecute(params: UnattendedParams, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx, "opx_orch_set_unattended")
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  // enabled 缺省按 schema 声明 default=true 兜底（跨形态一致：opencode 直载透传 input 不应用 zod default）
  state.unattended = params.enabled ?? true
  await writeState(ctx.worktree, state)
  const status = state.unattended ? "开启" : "关闭"
  return `无人值守模式已 **${status}**。启用后系统将自动处理决策点，不再 question 用户。`
}
