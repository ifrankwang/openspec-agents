import path from "path"
import type { TaskItem, TaskStatus } from "../types.js"
import { ORCHESTRATOR_AGENT } from "../constants.js"
import { runGit, runGitChecked, getCurrentBranch, getMergeBase, isWorktreeClean, mergeBranchToTarget, discoverDiskWorktrees } from "../git.js"
import { readStateByWorktree, readStateByChangeId, writeState, writeContextToWorktree } from "../state.js"
import { generateIsolationNamespace } from "../namespace.js"
import { parseAllTaskGroupsFromMd, parseTasksMdForGroup, extractRelevantSpecsFromTasks } from "../tasks-md.js"
import type { ParsedTask } from "../tasks-md.js"
import { assertOrchestrator, findTaskGroup } from "../derive.js"
import { loadWorkflowFile, TASK_WORKFLOW_PATH } from "../workflow/loader.js"
import { createInitialWorkItem, isBlockingSeverity, isTerminalPhase, recommendForItem } from "../workflow/engine.js"
import { renderWorkflowStatusView } from "../workflow/status.js"
import { taskChildrenOf } from "../task-children.js"
import type { WorkItem, WorkItemPhase } from "../workflow/types.js"
import type { InitParams, SetWorktreeParams, UnattendedParams, ToolContext } from "./types.js"

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
 * 按 tasks.md 同步 task children：
 * - 既有 task child 保留（forceOpen 除外）；
 * - 新增（不在既有中）按 defaultStatus 建 phase（todo/done）；
 * - 移除 tasks.md 已删除的 task child（issue children 不受影响）。
 */
function syncTaskChildren(item: WorkItem, parsed: ParsedTask[], opts: { forceOpen?: boolean; defaultStatus?: WorkItemPhase }): void {
  const prev = new Map(taskChildrenOf(item).map((c) => [c.id, c]))
  const built = parsed.map((p, i) => {
    const id = String(i + 1)
    const old = prev.get(id)
    if (old && !opts.forceOpen) return old
    const child = taskChildFromParsed(p, i)
    if (!opts.forceOpen && opts.defaultStatus) child.phase = opts.defaultStatus
    return child
  })
  const keepIds = new Set(built.map((c) => c.id))
  item.children = [...item.children.filter((c) => c.type !== "task" || keepIds.has(c.id)), ...built]
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
 * 按 recovery 合成活跃组 WorkItem 的 phase/currentStep/tags/task children。
 * - task_analysis：todo/analyze、tags 清空、task children 全 todo（全新开始）
 * - dev_impl：in_progress/implement、analyze 已 passed、task children 保留既有进度（无则 todo）
 * - review：review/verify_*（按 review_layer 决定从哪个子层继续）、analyze+implement 已 passed、
 *   task children 保留既有进度（无则 done——review 恢复时子任务应视为已验证，否则 G21 remaining 会让 implement 无法提交）
 */
function applyRecoveryState(
  item: WorkItem,
  recovery: InitParams["recovery"],
  parsedTasks: ParsedTask[],
): void {
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
  item.currentStep = "verify_tool"
  item.tags = {
    "analyze:openspec-architect": "passed",
    "implement:openspec-developer": "passed",
  }
  if (recovery?.review_layer === "task" || recovery?.review_layer === "quality") {
    item.tags["verify_tool:openspec-reviewer-tool"] = "passed"
    item.currentStep = "verify_task"
  }
  if (recovery?.review_layer === "quality") {
    item.tags["verify_task:openspec-reviewer-task"] = "passed"
    item.currentStep = "verify_quality"
  }
  syncTaskChildren(item, parsedTasks, { defaultStatus: "done" })
}

export async function initExecute(params: InitParams, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx.agent, "opx_orch_init")

  const args = { ...params }
  if (typeof (args as any).recovery === "string") {
    try { (args as any).recovery = JSON.parse((args as any).recovery) as any } catch {
      throw new Error(`recovery 参数解析失败：传入的字符串无法解析为对象。传入值：${(args as any).recovery}`)
    }
  }

  if (args.recovery?.review_layer && args.recovery.phase !== "review") {
    throw new Error("review_layer 参数仅当 recovery.phase 为 review 时有效，当前 phase 为 \"" + args.recovery.phase + "\"。")
  }

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

    // 活跃组：无 recovery 重复初始化当前组 → 保留进度
    if (existing && !args.recovery && wasCurrentGroup) {
      refreshMeta(existing)
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
  assertOrchestrator(ctx.agent, "opx_orch_set_worktree")
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const item = state.workItems.find((w) => w.id === `task:${state.taskGroupId}`)
  if (!item) throw new Error(`工作项 "task:${state.taskGroupId}" 缺失，请重新调用 opx_orch_init。`)

  const repoRoot = ctx.worktree
  const branch = params.branch_name || `task-group/${state.changeId}/${state.taskGroupId}`
  const wtPath = params.worktree_path || path.join(repoRoot, ".worktree", state.changeId, `task-group-${state.taskGroupId}`)

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

export async function statusExecute(params: { change_id: string }, ctx: ToolContext): Promise<string> {
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  const agent = ctx.agent

  if (!state) {
    if (agent === ORCHESTRATOR_AGENT) {
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
  return renderWorkflowStatusView(item, workflow, rec, agent, { state, tg })
}

export async function completeTaskGroupExecute(params: { change_id: string }, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx.agent, "opx_orch_complete_task_group")
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
  assertOrchestrator(ctx.agent, "opx_orch_set_unattended")
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  state.unattended = params.enabled
  await writeState(ctx.worktree, state)
  const status = params.enabled ? "开启" : "关闭"
  return `无人值守模式已 **${status}**。启用后系统将自动处理决策点，不再 question 用户。`
}
