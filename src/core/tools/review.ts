import path from "path"
import type { TaskGroupState, IssueItem, Dimension, ReviewDimension, OrchestrateState, BlockerItem, ValidationStep } from "../types.js"
import { REVIEW_DIMENSIONS } from "../types.js"
import { DIMENSION_AGENT_MAP, MAX_RETRIES, BLOCKING_SEVERITIES, ORCHESTRATOR_AGENT, SEVERITY_LEVELS } from "../constants.js"
import {
  findTaskGroup, assertOrchestrator, assertAgent, assertPassWithIssues,
  hasBlockingIssues, isBlockingIssue, handleRetryCheckpoint, allTasksVerified,
  isReviewCompleted, computeRequiredDims, dimsWithPendingAction, isStatusUnresolved,
} from "../derive.js"
import { applyReviewGate, deduplicateAndAddIssues, mergeExecutionBoundary, finalizeQualityPhase } from "../review.js"
import { readStateByWorktree, writeState } from "../state.js"
import { runGit, runGitChecked, getCurrentBranch, getMergeBase, getDiffFileList, isWorktreeClean, markTaskGroupCheckboxesComplete } from "../git.js"
import { parseTasksMdForGroup, extractRelevantSpecsFromTasks } from "../tasks-md.js"
import type {
  ToolContext, ArchSubmitParams, ArchBlockerParams, DevSubmitParams,
  ToolReviewParams, TaskReviewParams, QualityReviewParams, ResolveReviewParams,
} from "./types.js"

function idsToStrings(ids: string[] | undefined): string[] {
  return (ids || []).map(String)
}

function addBlockers(tg: TaskGroupState, blockers: Array<Omit<BlockerItem, "id" | "status" | "userResponse" | "architectConclusion">>, status: BlockerItem["status"]): void {
  let nextId = tg.blockers.reduce((max, blocker) => Math.max(max, Number(blocker.id.replace(/^b/, "")) || 0), 0) + 1
  for (const blocker of blockers) {
    tg.blockers.push({ ...blocker, id: `b${nextId++}`, status, userResponse: null, architectConclusion: null })
  }
}

function resetForBlocker(tg: TaskGroupState): void {
  tg.phases.architect_review.completed = false
  tg.phases.review.tool.completed = false
  tg.phases.review.task.completed = false
  for (const dimension of REVIEW_DIMENSIONS) tg.phases.review.quality.progress[dimension] = "pending"
  for (const task of tg.tasks) {
    task.status = "open"
    task.rejectReason = null
  }
}

export async function archSubmitExecute(params: ArchSubmitParams, ctx: ToolContext): Promise<string> {
  assertAgent(ctx.agent, "opx_arch_submit", ["openspec-architect"])
  const state = await readStateByWorktree(ctx.worktree)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const tg = findTaskGroup(state, state.taskGroupId)
  if (tg.status !== "task_analysis") {
    throw new Error(`阶段顺序错误：task_analysis 当前不在活跃阶段，当前阶段为 "${tg.status}"。`)
  }
  if ((params as any).passed !== undefined) {
    throw new Error("opx_arch_submit 不接受 passed 参数；必须提供 outcome=ready。")
  }
  if (!params.execution_boundary) throw new Error("outcome=ready 时必须提供 execution_boundary。")
  if (tg.blockers.some((blocker) => blocker.status === "awaiting_user")) {
    throw new Error("存在 awaiting_user blocker，请先用 opx_arch_blocker 逐个处理后再提交 outcome=ready。")
  }
  tg.executionBoundary = params.execution_boundary
  const parsedTasks = await parseTasksMdForGroup(tg.worktreePath || ctx.worktree, state.changeId, state.taskGroupId)
  tg.tasks = parsedTasks.map((task, index) => ({ id: String(index + 1), specTrace: task.specTrace, title: task.title, status: "open", taskNumber: task.taskNumber, rejectReason: null }))
  tg.relevantSpecs = extractRelevantSpecsFromTasks(parsedTasks)
  tg.phases.architect_review.completed = true
  tg.phases.review.tool.completed = false
  tg.phases.review.task.completed = false
  for (const dimension of REVIEW_DIMENSIONS) tg.phases.review.quality.progress[dimension] = "pending"
  tg.status = "dev_impl"
  const changeDir = `openspec/changes/${state.changeId}`
  const statusResult = await runGitChecked(tg.worktreePath || ctx.worktree, ["status", "--porcelain", changeDir])
  if (!statusResult.success) {
    throw new Error(`git status openspec 文档失败：${statusResult.stderr}`)
  }
  if (statusResult.stdout) {
    const addResult = await runGitChecked(tg.worktreePath || ctx.worktree, ["add", changeDir])
    if (!addResult.success) {
      throw new Error(`git add openspec docs 失败：${addResult.stderr}`)
    }
    const commitResult = await runGitChecked(tg.worktreePath || ctx.worktree, [
      "commit", "-m", `docs(openspec): refine specs for task-group ${state.taskGroupId}`,
    ])
    if (!commitResult.success) {
      throw new Error(`git commit openspec docs 失败：${commitResult.stderr}`)
    }
  }
  await writeState(ctx.worktree, state)
  return JSON.stringify(
    {
      status: "ok",
      phase: "dev_impl",
      execution_boundary: params.execution_boundary,
      message: "复核通过，职责已完成，请立即结束当前会话。",
    },
    null,
    2
  )
}

export async function archBlockerExecute(params: ArchBlockerParams, ctx: ToolContext): Promise<string> {
  assertAgent(ctx.agent, "opx_arch_blocker", ["openspec-architect"])
  const state = await readStateByWorktree(ctx.worktree)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const tg = findTaskGroup(state, state.taskGroupId)
  if (tg.status !== "task_analysis") {
    throw new Error(`opx_arch_blocker 仅在 task_analysis 阶段可用，当前阶段为 "${tg.status}"。`)
  }

  const isUpdate = !!params.blocker_id
  const userResponse = params.user_response || null

  if (isUpdate) {
    if (!userResponse) throw new Error("更新模式必须提供 user_response。")
    const blocker = tg.blockers.find(b => b.id === params.blocker_id)
    if (!blocker) throw new Error(`blocker #${params.blocker_id} 不在任务组 ${tg.id} 中。`)
    if (blocker.status !== "awaiting_user") throw new Error(`blocker #${params.blocker_id} 状态不是 awaiting_user，无法更新。`)
    blocker.userResponse = userResponse
    blocker.status = "resolved"
    await writeState(ctx.worktree, state)

    const remaining = tg.blockers.filter(b => b.status !== "resolved").length
    const lines = [`- blocker #${params.blocker_id} 已处理`]
    if (remaining > 0) {
      lines.push(`- 剩余 ${remaining} 个 awaiting_user blocker 待处理`)
    } else {
      lines.push("- 全部 blocker 已处理，可提交 opx_arch_submit(outcome=ready)")
    }
    return lines.join("\n")
  } else {
    const blockersRaw = (params.blockers || []) as any[]
    if (blockersRaw.length === 0) throw new Error("创建模式必须提供至少一个 blocker。")

    const count = blockersRaw.length
    addBlockers(tg, blockersRaw.map((b: any) => ({
      sourceRole: b.source_role, taskId: b.task_id || null, category: b.category,
      description: b.description, evidence: b.evidence, attemptedActions: b.attempted_actions,
      options: b.options || [],
    })), "awaiting_user")

    if (userResponse) {
      const newBlockers = tg.blockers.slice(-count)
      for (const b of newBlockers) {
        b.userResponse = userResponse
        b.status = "resolved"
      }
    }

    await writeState(ctx.worktree, state)

    const remaining = tg.blockers.filter(b => b.status !== "resolved").length
    const lines = [`- 已记录 ${count} 个 blocker`]
    if (count > 0 && userResponse) lines[0] = `- 已记录 ${count} 个 blocker（含用户答复，已处理）`
    if (remaining > 0) {
      lines.push(`- 剩余 ${remaining} 个 awaiting_user blocker 待处理`)
      const awaitingBlockers = tg.blockers.filter(b => b.status !== "resolved")
      for (const b of awaitingBlockers) {
        lines.push(`  - blocker ${b.id}: ${b.description}`)
      }
    } else {
      lines.push("- 全部 blocker 已处理，可提交 opx_arch_submit(outcome=ready)")
    }
    return lines.join("\n")
  }
}

export async function devSubmitExecute(params: DevSubmitParams, ctx: ToolContext): Promise<string> {
  assertAgent(ctx.agent, "opx_dev_submit", ["openspec-developer"])
  if (params.completed_task_ids) params.completed_task_ids = params.completed_task_ids.map(String)
  if (params.fixed_issue_ids) params.fixed_issue_ids = idsToStrings(params.fixed_issue_ids)
  if (params.request_exempts) params.request_exempts = params.request_exempts.map(r => ({ ...r, issue_id: String(r.issue_id) }))
  const state = await readStateByWorktree(ctx.worktree)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const tg = findTaskGroup(state, state.taskGroupId)
  if (tg.status !== "dev_impl" && tg.status !== "review") {
    throw new Error(`dev_submit 仅在 dev_impl 或 review 阶段可用，当前阶段为 "${tg.status}"。`)
  }
  if (!tg.worktreePath || !tg.baseRef) {
    throw new Error("worktree 或 baseRef 未设置。请结束当前会话，编排者将通过 opx_status 自动识别缺失资源并补充。")
  }
  const clean = await isWorktreeClean(tg.worktreePath)
  if (!clean) {
    throw new Error(`worktree "${tg.worktreePath}" 存在未 commit 内容，请先 commit 再 submit。`)
  }
  const outcome = params.outcome || "completed"
  if (outcome === "blocked") {
    if (!params.blocker) throw new Error("outcome=blocked 时必须提供 blocker。")
    const blocker = params.blocker as any
    addBlockers(tg, [{
      sourceRole: blocker.source_role, taskId: blocker.task_id || null, category: blocker.category,
      description: blocker.description, evidence: blocker.evidence, attemptedActions: blocker.attempted_actions,
      options: blocker.options || [],
    }], "awaiting_user")
    resetForBlocker(tg)
    tg.status = "task_analysis"
    await writeState(ctx.worktree, state)
    return JSON.stringify({ status: "blocked", outcome, message: "已记录 blocker，职责已完成，请立即结束当前会话。" })
  }
  tg.lastFilesChanged = await getDiffFileList(tg.worktreePath, tg.baseRef)

  let requiredDims: ReviewDimension[] = []

  if (params.completed_task_ids && params.completed_task_ids.length > 0) {
    const validIds = new Set(tg.tasks.map((t) => t.id))
    for (const id of params.completed_task_ids) {
      if (!validIds.has(id)) {
        const sortedIds = Array.from(validIds).sort((a, b) => Number(a) - Number(b))
        throw new Error(
          `completed_task_ids 中包含无效 task id: "${id}"。有效的 task ID 为: ${sortedIds.join(", ")}`
        )
      }
    }
    for (const id of params.completed_task_ids) {
      const task = tg.tasks.find((t) => t.id === id)
      if (task && (task.status === "open" || task.status === "rejected")) {
        task.status = "submitted"
        task.rejectReason = null
      }
    }
  }

  const completedSet = new Set(params.completed_task_ids || [])
  const remainingTasks = tg.tasks.filter(
    (t) => (t.status === "open" || t.status === "rejected") && !completedSet.has(t.id)
  )
  if (remainingTasks.length > 0) {
    throw new Error(
      `以下 task 处于 open/rejected 状态且未在 completed_task_ids 中：` +
      remainingTasks.map((t) => `#${t.id}(${t.status}) ${t.title}`).join("\n") +
      `。请将未完成的 task 列在 completed_task_ids 中，或改用 outcome="blocked" 提交 blocker。`
    )
  }

  let touchedAnyIssue = false
  const fixedIds = params.fixed_issue_ids || []
  for (const id of fixedIds) {
    const issue = tg.issues.find((i) => i.id === id)
    if (issue && (issue.status === "open" || issue.status === "rejected")) {
      issue.status = "submitted"
      touchedAnyIssue = true
    }
  }

  const requestedIds: string[] = []
  for (const r of params.request_exempts || []) {
    const issue = tg.issues.find((i) => i.id === r.issue_id)
    if (!issue) throw new Error(`issue #${r.issue_id} 不在任务组 ${state.taskGroupId} 的 issue 清单中。`)
    if (issue.status === "exempted") {
      throw new Error(`issue #${r.issue_id} 已被豁免，无需重复申请。`)
    }
    if (issue.status === "rejected") {
      throw new Error(`issue #${r.issue_id} 的豁免申请已被驳回，必须修复，不可二次申请豁免。`)
    }
    if (issue.status === "verified") {
      throw new Error(`issue #${r.issue_id} 已通过验证，无需申请豁免。`)
    }
    issue.status = "exemption_requested"
    issue.exemptReason = r.reason
    requestedIds.push(r.issue_id)
    touchedAnyIssue = true
  }

  const remainingBlocking = tg.issues.filter(
    (i) => (i.status === "open" || i.status === "rejected") && (BLOCKING_SEVERITIES as readonly string[]).includes(i.severity)
  )
  if (remainingBlocking.length > 0) {
    throw new Error(
      `存在 ${remainingBlocking.length} 个 Low 及以上的 open/rejected issue 未处理，无法提交（请逐条修复或申请豁免）：` +
        remainingBlocking.map((i) => `#${i.id}(${i.severity}/${i.dimension})`).join("; ")
    )
  }

  if (touchedAnyIssue) {
    tg.phases.review.tool.completed = false
    tg.phases.review.task.completed = false
    for (const d of REVIEW_DIMENSIONS) {
      if (dimsWithPendingAction(tg).has(d)) {
        tg.phases.review.quality.progress[d] = "pending"
      }
    }
    tg.status = "review"
    requiredDims = computeRequiredDims(tg)
  } else {
    tg.status = "review"
    requiredDims = computeRequiredDims(tg)
  }

  if (allTasksVerified(tg.tasks)) {
    const hasPendingTaskIssues = tg.issues.some(i => i.sourcePhase === "task" && isStatusUnresolved(i.status))
    if (!hasPendingTaskIssues) {
      tg.phases.review.task.completed = true
    }
  }

  if (params.self_check_results) {
    tg.devSelfCheckResults = params.self_check_results
  }

  await writeState(ctx.worktree, state)
  return JSON.stringify(
    {
      status: "ok", outcome,
      active_phase: tg.status,
      required_dimensions: requiredDims,
      message: "提交完成。职责已完成，请立即结束当前会话。",
    },
    null,
    2
  )
}

export async function toolReviewSubmitExecute(params: ToolReviewParams, ctx: ToolContext): Promise<string> {
  assertAgent(ctx.agent, "opx_tool_review_submit", ["openspec-reviewer-tool"])
  const tlFixedIds = idsToStrings(params.fixed_issue_ids)
  const tlExemptIds = idsToStrings(params.exempt_issue_ids)
  const tlRejected = (params.rejected_issue_ids || []).map(r => ({ ...r, issue_id: String(r.issue_id) }))
  const state = await readStateByWorktree(ctx.worktree)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const tg = findTaskGroup(state, state.taskGroupId)
  if (tg.status !== "review") {
    throw new Error(`tool_review_submit 需在 review 阶段调用，当前阶段为 "${tg.status}"。`)
  }
  if (tg.phases.review.tool.completed) {
    throw new Error("tool 层审核报告已提交，不允许重复提交。")
  }
  if ((tg.phases.review.task.completed && !allTasksVerified(tg.tasks)) || isReviewCompleted(tg)) {
    throw new Error("后续层审核报告已提交，tool 层不可再提交。")
  }
  assertPassWithIssues(params.passed, params.issues || [], "opx_tool_review_submit")

  const issues = (params.issues || []) as any[]
  for (const iss of issues) {
    if (!iss.dimension || !REVIEW_DIMENSIONS.includes(iss.dimension)) {
      throw new Error(`tool issue 必须包含有效的 dimension 字段（5 维之一），收到：${iss.dimension}。`)
    }
  }

  applyReviewGate(tg.issues, tlFixedIds, tlExemptIds, tlRejected, undefined, "tool")

  let nextIssueId = tg.issues.reduce((m, i) => Math.max(m, parseInt(i.id, 10) || 0), 0) + 1
  const newIssues: IssueItem[] = []
  let dedupedCount = 0
  for (const iss of issues) {
    const dim = iss.dimension as Dimension
    const dedupResult = deduplicateAndAddIssues([iss], tg.issues, dim, "tool", nextIssueId)
    if (dedupResult.dedupedCount > 0) { dedupedCount++; continue }
    if (dedupResult.newIssues.length > 0) {
      newIssues.push(dedupResult.newIssues[0])
      nextIssueId = dedupResult.nextIssueId
    }
  }
  tg.issues.push(...newIssues)

  if (tg.executionBoundary && newIssues.length > 0) {
    const dirs = tg.executionBoundary.allowed_directories
    for (const iss of newIssues) {
      const dir = path.dirname(iss.file)
      const entry = dir === "" || dir === "." ? iss.file : dir
      if (entry !== "." && entry !== "" && !dirs.includes(entry)) dirs.push(entry)
    }
  }

  if (tg.executionBoundary && params.boundary_expansion) {
    if (params.passed) {
      throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 passed=false 有效。")
    }
    mergeExecutionBoundary(tg, params.boundary_expansion)
  }

  tg.phases.review.tool.completed = true
  if (params.test_results) tg.phases.review.tool.testResults = params.test_results
  await writeState(ctx.worktree, state)

  const hasBlocking = hasBlockingIssues(tg.issues, "tool")
  if (params.passed && !hasBlocking) {
    return JSON.stringify({
      status: "ok",
      phase: "review(tool=completed)",
      message: `审核通过。职责已完成，请立即结束当前会话。${
        dedupedCount > 0 ? `${dedupedCount} 个重复 issue 已自动跳过` : ""
      }`,
    })
  }

  const retryResult = handleRetryCheckpoint(tg, state.unattended)
  if (retryResult === null) {
    await writeState(ctx.worktree, state)
    return JSON.stringify({
      status: "recorded",
      layer: "tool",
      passed: false,
      retry_count: tg.phases.review.retryCount,
      message: "职责已完成，请立即结束当前会话。",
    })
  }
  const retryCount = retryResult.retryCount
  tg.phases.review.tool.completed = false
  tg.status = "dev_impl"
  await writeState(ctx.worktree, state)
  const blockingIssues = tg.issues.filter(
    (i) => (!i.sourcePhase || i.sourcePhase === "tool") && isBlockingIssue(i)
  )
  const issueSummary = blockingIssues.slice(0, 3)
    .map((i) => `#${i.id}(dimension:${i.dimension} status:${i.status || "open"})`)
    .join("、")
  return JSON.stringify({
    status: "recorded",
    layer: "tool",
    passed: false,
    retry_count: retryCount,
    message: `职责已完成，请立即结束当前会话。因遗留跨层阻塞 issue ${issueSummary} 等 ${blockingIssues.length} 个，需回退开发。`,
  })
}

export async function taskReviewSubmitExecute(params: TaskReviewParams, ctx: ToolContext): Promise<string> {
  assertAgent(ctx.agent, "opx_task_review_submit", ["openspec-reviewer-task"])
  if (params.verified_task_ids) params.verified_task_ids = params.verified_task_ids.map(String)
  if (params.failed_task_ids) params.failed_task_ids = params.failed_task_ids.map(f => ({ ...f, task_id: String(f.task_id) }))
  const tkFixedIds = idsToStrings(params.fixed_issue_ids)
  const tkExemptIds = idsToStrings(params.exempt_issue_ids)
  const tkRejected = (params.rejected_issue_ids || []).map(r => ({ ...r, issue_id: String(r.issue_id) }))
  const state = await readStateByWorktree(ctx.worktree)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const tg = findTaskGroup(state, state.taskGroupId)
  if (tg.status !== "review") {
    throw new Error(`task_review_submit 需在 review 阶段调用，当前阶段为 "${tg.status}"。`)
  }
  if (!tg.phases.review.tool.completed) {
    throw new Error("tool 层审核未完成，task 层不可提交。")
  }
  if (tg.phases.review.task.completed && !allTasksVerified(tg.tasks)) {
    throw new Error("task 层审核报告已提交，不允许重复提交。")
  }
  if (tg.worktreePath) {
    const clean = await isWorktreeClean(tg.worktreePath)
    if (!clean) {
      throw new Error(`worktree "${tg.worktreePath}" 存在未 commit 内容，请先 commit 再 submit。`)
    }
  }
  const verified = params.verified_task_ids || []
  const failed = params.failed_task_ids || []
  const tasks = tg.tasks
  const validIds = new Set(tasks.map((t) => t.id))
  const unknownVerified = verified.filter((id) => !validIds.has(id))
  const unknownFailed = failed.filter((f) => !validIds.has(f.task_id))
  if (unknownVerified.length > 0 || unknownFailed.length > 0) {
    throw new Error(
      `非法 task id：${[...unknownVerified.map((id) => `"${id}"`), ...unknownFailed.map((f) => `"${f.task_id}"`)].join(", ")}。` +
      `合法 id：${Array.from(validIds).join(", ")}。`
    )
  }

  const submittedTasks = tasks.filter((t) => t.status === "submitted")
  const coveredIds = new Set([...verified, ...failed.map((f) => f.task_id)])
  const uncovered = submittedTasks.filter((t) => !coveredIds.has(t.id))
  if (uncovered.length > 0) {
    throw new Error(
      `以下 submitted task 未被 verified_task_ids 或 failed_task_ids 覆盖：` +
      uncovered.map((t) => `#${t.id} ${t.title}`).join("; ")
    )
  }

  for (const id of verified) {
    const task = tasks.find((t) => t.id === id)
    if (task && task.status === "submitted") { task.status = "verified"; task.rejectReason = null }
  }
  for (const f of failed) {
    const task = tasks.find((t) => t.id === f.task_id)
    if (task && task.status === "submitted") {
      task.status = "rejected"
      task.rejectReason = f.reason
    }
  }

  const rawIssues = (params.issues || []) as any[]
  let nextIssueId = tg.issues.reduce((m, i) => Math.max(m, parseInt(i.id, 10) || 0), 0) + 1
  for (const iss of rawIssues) {
    const dedupResult = deduplicateAndAddIssues(
      [iss], tg.issues,
      "style" as Dimension, "task",
      nextIssueId
    )
    if (dedupResult.dedupedCount > 0) continue
    if (dedupResult.newIssues.length > 0) {
      tg.issues.push(dedupResult.newIssues[0])
      nextIssueId = dedupResult.nextIssueId
    }
  }

  assertPassWithIssues(params.passed, params.issues || [], "opx_task_review_submit")

  applyReviewGate(tg.issues, tkFixedIds, tkExemptIds, tkRejected, undefined, "task")

  if (tg.executionBoundary && rawIssues.length > 0) {
    const dirs = tg.executionBoundary.allowed_directories
    for (const iss of rawIssues) {
      const dir = path.dirname(iss.file)
      const entry = dir === "" || dir === "." ? iss.file : dir
      if (entry !== "." && entry !== "" && !dirs.includes(entry)) dirs.push(entry)
    }
  }

  if (tg.executionBoundary && params.boundary_expansion) {
    if (params.passed) {
      throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 passed=false 有效。")
    }
    mergeExecutionBoundary(tg, params.boundary_expansion)
  }

  if (params.validation_steps) {
    for (const step of params.validation_steps) {
      if (!step.completed && !step.skip_reason) {
        throw new Error(`验证步骤 "${step.step}" 标记为未完成但未提供跳过原因（skip_reason）。`)
      }
    }
    tg.phases.review.task.validationSteps = params.validation_steps.map(s => ({
      step: s.step,
      completed: s.completed,
      evidence: s.evidence || "",
      skip_reason: s.skip_reason || null,
    }))
  }

  if (params.passed) {
    if (failed.length > 0) {
      throw new Error(`任务层审核声称 passed=true，但存在 ${failed.length} 个未通过的 task。`)
    }
    if (hasBlockingIssues(tg.issues, "task")) {
      const blockingIssues = tg.issues.filter(
        (i) => (!i.sourcePhase || i.sourcePhase === "task") && isBlockingIssue(i)
      )
      const issueSummary = blockingIssues.slice(0, 3)
        .map((i) => `#${i.id}(dimension:${i.dimension} status:${i.status || "open"})`)
        .join("、")
      throw new Error(`任务层审核声称 passed=true，但存在阻塞 issue：${issueSummary} 等 ${blockingIssues.length} 个。`)
    }
  }
  if (!params.passed && failed.length === 0 && !hasBlockingIssues(tg.issues, "task")) {
    throw new Error(
      `任务层审核声称 passed=false，但既无 failed_task_ids 也无阻塞 issue。` +
      `passed=false 时必须至少指定一个 failed_task_id 或提交 Low+ issue 作为不通过理由。`
    )
  }

  tg.phases.review.task.completed = true
  await writeState(ctx.worktree, state)

  if (params.passed) {
    if (tg.worktreePath) {
      await markTaskGroupCheckboxesComplete(tg.worktreePath, state.changeId, state.taskGroupId)
    }
    return JSON.stringify({
      status: "ok",
      phase: "review(task=completed)",
      message: "审核通过。职责已完成，请立即结束当前会话。",
    })
  }

  const retryResult = handleRetryCheckpoint(tg, state.unattended)
  if (retryResult === null) {
    await writeState(ctx.worktree, state)
    return JSON.stringify({
      status: "recorded",
      layer: "task",
      passed: false,
      retry_count: tg.phases.review.retryCount,
      message: "职责已完成，请立即结束当前会话。",
    })
  }
  const retryCount = retryResult.retryCount
  tg.phases.review.task.completed = false
  tg.status = "dev_impl"
  await writeState(ctx.worktree, state)
  return JSON.stringify({
    status: "recorded",
    layer: "task",
    passed: false,
    retry_count: retryCount,
    message: "职责已完成，请立即结束当前会话。",
  })
}

export async function qualityReviewSubmitExecute(params: QualityReviewParams, ctx: ToolContext): Promise<string> {
  const agentToDim = Object.fromEntries(
    Object.entries(DIMENSION_AGENT_MAP).map(([dim, agent]) => [agent, dim])
  )
  const dimension = agentToDim[ctx.agent] as Dimension | undefined
  if (!dimension) {
    throw new Error(
      `工具 "opx_quality_review_submit" 不支持调用者 "${ctx.agent}"。` +
      `仅支持：${Object.values(DIMENSION_AGENT_MAP).join(", ")}。`
    )
  }
  if (typeof params.passed !== "boolean" && params.passed !== "true" && params.passed !== "false") {
    throw new Error(
      `参数 passed 必须为布尔值（true/false），收到类型 "${typeof params.passed}"，值 "${params.passed}"。`
    )
  }
  const state = await readStateByWorktree(ctx.worktree)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const tg = findTaskGroup(state, state.taskGroupId)
  if (tg.status !== "review") {
    throw new Error(`quality_review_submit 需在 review 阶段调用，当前阶段为 "${tg.status}"。`)
  }
  if (!tg.phases.review.task.completed) {
    throw new Error("task 层审核未完成，quality 层不可提交。")
  }
  if (tg.phases.review.quality.progress[dimension] !== "pending") {
    throw new Error(`维度 "${dimension}" 的审查报告已提交，不允许重复提交。`)
  }

  const qlFixedIds = idsToStrings(params.fixed_issue_ids)
  const qlExemptIds = idsToStrings(params.exempt_issue_ids)
  const qlRejected = (params.rejected_issue_ids || []).map(r => ({ ...r, issue_id: String(r.issue_id) }))

  const passed = params.passed === true || (params.passed as any) === "true"
  const issues = (params.issues || []) as any[]
  assertPassWithIssues(passed, issues, "opx_quality_review_submit")

  for (const iss of issues) {
    if (!iss.suggestion || typeof iss.suggestion !== "string" || iss.suggestion.trim() === "") {
      throw new Error(`dimension="${dimension}" 的 issue 必须提供非空 suggestion。`)
    }
  }

  applyReviewGate(tg.issues, qlFixedIds, qlExemptIds, qlRejected, dimension, "quality")

  let nextIssueId = tg.issues.reduce((m, i) => Math.max(m, parseInt(i.id, 10) || 0), 0) + 1
  const newIssues: IssueItem[] = []
  let dedupedCount = 0
  for (const iss of issues) {
    const dedupResult = deduplicateAndAddIssues(
      [iss], tg.issues, dimension, "quality",
      nextIssueId
    )
    if (dedupResult.dedupedCount > 0) { dedupedCount++; continue }
    if (dedupResult.newIssues.length > 0) {
      newIssues.push(dedupResult.newIssues[0])
      nextIssueId = dedupResult.nextIssueId
    }
  }
  tg.issues.push(...newIssues)

  if (tg.executionBoundary && newIssues.length > 0) {
    const dirs = tg.executionBoundary.allowed_directories
    for (const iss of newIssues) {
      const dir = path.dirname(iss.file)
      const entry = dir === "" || dir === "." ? iss.file : dir
      if (entry !== "." && entry !== "" && !dirs.includes(entry)) dirs.push(entry)
    }
  }

  if (tg.executionBoundary && params.boundary_expansion) {
    if (params.passed) {
      throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 passed=false 有效。")
    }
    mergeExecutionBoundary(tg, params.boundary_expansion)
  }

  tg.phases.review.quality.progress[dimension] = passed ? "passed" : "failed"
  await writeState(ctx.worktree, state)
  const resultStr = await finalizeQualityPhase(state, tg, dimension, passed, ctx.worktree)
  if (dedupedCount > 0) {
    const result = JSON.parse(resultStr)
    result.deduped = dedupedCount
    result.message = result.message.replace(/([。！])\s*$/, `；${dedupedCount} 个重复 issue 已自动跳过。`)
    return JSON.stringify(result)
  }
  return resultStr
}

export async function resolveReviewExecute(params: ResolveReviewParams, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx.agent, "opx_orch_resolve_review")
  const state = await readStateByWorktree(ctx.worktree)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const tg = findTaskGroup(state, state.taskGroupId)
  if (tg.status !== "review") {
    throw new Error(`opx_orch_resolve_review 仅在 review 阶段可用，当前阶段为 "${tg.status}"。`)
  }
  const maxLayerRetry = tg.phases.review.retryCount
  if (maxLayerRetry === 0 || maxLayerRetry % MAX_RETRIES !== 0) {
    throw new Error(
      `opx_orch_resolve_review 仅在审查重试达到检查点（retryCount 为 ${MAX_RETRIES} 的整数倍，needs_user_decision 状态）时调用；` +
        `当前 retryCount=${tg.phases.review.retryCount}。`
    )
  }

  if (params.decision === "continue") {
    tg.phases.review.lastResolvedRetryCount = tg.phases.review.retryCount
    tg.phases.review.tool.completed = false
    tg.phases.review.task.completed = false
    for (const d of REVIEW_DIMENSIONS) {
      if (tg.phases.review.quality.progress[d] !== "passed") {
        tg.phases.review.quality.progress[d] = "pending"
      }
    }
    tg.status = "dev_impl"
    await writeState(ctx.worktree, state)
    return JSON.stringify(
      {
        status: "ok",
        decision: "continue",
        phase: "review(in_progress)",
        message: "已重置各层审查进度，回到 tool 层基线。编排者请调用 opx_status 确认下一步。",
      },
      null,
      2
    )
  }

  let exemptedCount = 0
  for (const issue of tg.issues) {
    if (issue.status === "exemption_requested") {
      issue.status = "exempted"
      exemptedCount++
    } else if (
      (issue.status === "open" || issue.status === "rejected" || issue.status === "submitted") &&
      isBlockingIssue(issue)
    ) {
      issue.status = "exempted"
      exemptedCount++
    }
  }
  tg.phases.review.tool.completed = true
  tg.phases.review.task.completed = true
  for (const d of REVIEW_DIMENSIONS) {
    if (tg.phases.review.quality.progress[d] !== "passed") {
      tg.phases.review.quality.progress[d] = "passed"
    }
  }
  await writeState(ctx.worktree, state)
  return JSON.stringify(
    {
      status: "ok",
      decision: "giveup",
      exempted_count: exemptedCount,
      phase: "review=completed",
      message: `已将剩余 ${exemptedCount} 个 Low+ open/rejected 及待裁定 issue 置为 exempted。请调用 opx_orch_complete_task_group 收尾。`,
    },
    null,
    2
  )
}
