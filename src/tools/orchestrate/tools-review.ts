import { tool } from "@opencode-ai/plugin"
import path from "path"
import type { TaskGroupState, IssueItem, Dimension, ReviewDimension, OrchestrateState, BlockerItem, ValidationStep } from "./types.js"
import { REVIEW_DIMENSIONS } from "./types.js"
import { DIMENSION_AGENT_MAP, MAX_RETRIES, BLOCKING_SEVERITIES, ORCHESTRATOR_AGENT, SEVERITY_LEVELS } from "./constants.js"
import {
  executionBoundarySchema, boundaryExpansionSchema, reviewIssue, blockerItem,
  requestExemptItem, rejectedIssueItem, toolIssueItem, taskVerifyItem, taskVerifyResult, validationStepSchema,
} from "./schemas.js"
import {
  findTaskGroup, assertOrchestrator, assertAgent, assertPassWithIssues,
  hasBlockingIssues, isBlockingIssue, handleRetryCheckpoint, allTasksVerified,
  isReviewCompleted, computeRequiredDims, dimsWithPendingAction, isStatusUnresolved,
} from "./derive.js"
import { applyReviewGate, deduplicateAndAddIssues, mergeExecutionBoundary, finalizeQualityPhase } from "./review.js"
import { readStateByWorktree, writeState } from "./state.js"
import { runGit, runGitChecked, getCurrentBranch, getMergeBase, getDiffFileList, isWorktreeClean, markTaskGroupCheckboxesComplete } from "./git.js"
import { parseTasksMdForGroup, extractRelevantSpecsFromTasks } from "./tasks-md.js"

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

export const arch_submit = tool({
  description:
    "架构师提交预检结果。仅 outcome=ready，所有 blocker 需先通过 opx_arch_blocker 处理。",
  args: {
    outcome: tool.schema.enum(["ready"]),
    execution_boundary: executionBoundarySchema.optional(),
  },
  async execute(args, context) {
    assertAgent(context, "opx_arch_submit", ["openspec-architect"])
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    const tg = findTaskGroup(state, state.taskGroupId)
    if (tg.status !== "task_analysis") {
      throw new Error(`阶段顺序错误：task_analysis 当前不在活跃阶段，当前阶段为 "${tg.status}"。`)
    }
    if (Object.hasOwn(args, "passed")) {
      throw new Error("opx_arch_submit 不接受 passed 参数；必须提供 outcome=ready。")
    }
    if (!args.execution_boundary) throw new Error("outcome=ready 时必须提供 execution_boundary。")
    if (tg.blockers.some((blocker) => blocker.status === "awaiting_user")) {
      throw new Error("存在 awaiting_user blocker，请先用 opx_arch_blocker 逐个处理后再提交 outcome=ready。")
    }
    tg.executionBoundary = args.execution_boundary
    const parsedTasks = await parseTasksMdForGroup(tg.worktreePath || context.worktree, state.changeId, state.taskGroupId)
    tg.tasks = parsedTasks.map((task, index) => ({ id: String(index + 1), specTrace: task.specTrace, title: task.title, status: "open", taskNumber: task.taskNumber, rejectReason: null }))
    tg.relevantSpecs = extractRelevantSpecsFromTasks(parsedTasks)
    tg.phases.architect_review.completed = true
    tg.phases.review.tool.completed = false
    tg.phases.review.task.completed = false
    for (const dimension of REVIEW_DIMENSIONS) tg.phases.review.quality.progress[dimension] = "pending"
    tg.status = "dev_impl"
    const changeDir = `openspec/changes/${state.changeId}`
    const statusResult = await runGitChecked(tg.worktreePath || context.worktree, ["status", "--porcelain", changeDir])
    if (!statusResult.success) {
      throw new Error(`git status openspec 文档失败：${statusResult.stderr}`)
    }
    if (statusResult.stdout) {
      const addResult = await runGitChecked(tg.worktreePath || context.worktree, ["add", changeDir])
      if (!addResult.success) {
        throw new Error(`git add openspec docs 失败：${addResult.stderr}`)
      }
      const commitResult = await runGitChecked(tg.worktreePath || context.worktree, [
        "commit", "-m", `docs(openspec): refine specs for task-group ${state.taskGroupId}`,
      ])
      if (!commitResult.success) {
        throw new Error(`git commit openspec docs 失败：${commitResult.stderr}`)
      }
    } else {
      // openspec 文档无变更，跳过 commit
    }
    await writeState(context.worktree, state)
    return JSON.stringify(
      {
        status: "ok",
        phase: "dev_impl",
        execution_boundary: args.execution_boundary,
        message: "复核通过，职责已完成，请立即结束当前会话。",
      },
      null,
      2
    )
  },
})

export const arch_blocker = tool({
  description: "架构师记录/更新 blocker，不结束本环节。创建 mode 入库 awaiting_user；更新 mode 写入 user_response 并置 resolved。",
  args: {
    blocker_id: tool.schema.string().optional().describe("提供=更新模式；不提供=创建模式"),
    blockers: tool.schema.array(blockerItem).optional().describe("创建模式：新增 blocker 列表"),
    user_response: tool.schema.string().optional().describe("用户答复。创建模式有则立即 resolved；更新模式必传"),
  },
  async execute(args, context) {
    assertAgent(context, "opx_arch_blocker", ["openspec-architect"])
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    const tg = findTaskGroup(state, state.taskGroupId)
    if (tg.status !== "task_analysis") {
      throw new Error(`opx_arch_blocker 仅在 task_analysis 阶段可用，当前阶段为 "${tg.status}"。`)
    }

    const isUpdate = !!args.blocker_id
    const userResponse = args.user_response || null

    if (isUpdate) {
      if (!userResponse) throw new Error("更新模式必须提供 user_response。")
      const blocker = tg.blockers.find(b => b.id === args.blocker_id)
      if (!blocker) throw new Error(`blocker #${args.blocker_id} 不在任务组 ${tg.id} 中。`)
      if (blocker.status !== "awaiting_user") throw new Error(`blocker #${args.blocker_id} 状态不是 awaiting_user，无法更新。`)
      blocker.userResponse = userResponse
      blocker.status = "resolved"
      await writeState(context.worktree, state)

      const remaining = tg.blockers.filter(b => b.status !== "resolved").length
      const lines = [`- blocker #${args.blocker_id} 已处理`]
      if (remaining > 0) {
        lines.push(`- 剩余 ${remaining} 个 awaiting_user blocker 待处理`)
      } else {
        lines.push("- 全部 blocker 已处理，可提交 opx_arch_submit(outcome=ready)")
      }
      return lines.join("\n")
    } else {
      const blockersRaw = (args.blockers || []) as any[]
      if (blockersRaw.length === 0) throw new Error("创建模式必须提供至少一个 blocker。")

      const count = blockersRaw.length
      addBlockers(tg, blockersRaw.map(b => ({
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

      await writeState(context.worktree, state)

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
  },
})

export const dev_submit = tool({
  description:
    "developer 提交实现结果。outcome=completed 提交实现；outcome=blocked 上报 blocker。",
  args: {
    outcome: tool.schema.enum(["completed", "blocked"]).optional(),
    completed_task_ids: tool.schema.array(tool.schema.string()).optional().describe("已完成的 task ID 列表"),
    self_check_results: tool.schema.string().optional().describe("提交前自检结果汇总"),
    blocker: blockerItem.optional(),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("确认修复的 issue ID 列表"),
    request_exempts: tool.schema.array(requestExemptItem).optional().describe("不可修的 issue 申请豁免"),
  },
  async execute(args, context) {
    assertAgent(context, "opx_dev_submit", ["openspec-developer"])
    if (args.completed_task_ids) args.completed_task_ids = args.completed_task_ids.map(String)
    if (args.fixed_issue_ids) args.fixed_issue_ids = idsToStrings(args.fixed_issue_ids)
    if (args.request_exempts) args.request_exempts = args.request_exempts.map(r => ({ ...r, issue_id: String(r.issue_id) }))
    const state = await readStateByWorktree(context.worktree)
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
    const outcome = args.outcome || "completed"
    if (outcome === "blocked") {
      if (!args.blocker) throw new Error("outcome=blocked 时必须提供 blocker。")
      const blocker = args.blocker as any
      addBlockers(tg, [{
        sourceRole: blocker.source_role, taskId: blocker.task_id || null, category: blocker.category,
        description: blocker.description, evidence: blocker.evidence, attemptedActions: blocker.attempted_actions,
        options: blocker.options || [],
      }], "awaiting_user")
      resetForBlocker(tg)
      tg.status = "task_analysis"
      await writeState(context.worktree, state)
      return JSON.stringify({ status: "blocked", outcome, message: "已记录 blocker，职责已完成，请立即结束当前会话。" })
    }
    tg.lastFilesChanged = await getDiffFileList(tg.worktreePath, tg.baseRef)

    let requiredDims: ReviewDimension[] = []

    if (args.completed_task_ids && args.completed_task_ids.length > 0) {
      const validIds = new Set(tg.tasks.map((t) => t.id))
      for (const id of args.completed_task_ids) {
        if (!validIds.has(id)) {
          const sortedIds = Array.from(validIds).sort((a, b) => Number(a) - Number(b))
          throw new Error(
            `completed_task_ids 中包含无效 task id: "${id}"。有效的 task ID 为: ${sortedIds.join(", ")}`
          )
        }
      }
      for (const id of args.completed_task_ids) {
        const task = tg.tasks.find((t) => t.id === id)
        if (task && (task.status === "open" || task.status === "rejected")) {
          task.status = "submitted"
          task.rejectReason = null
        }
      }
    }

    const completedSet = new Set(args.completed_task_ids || [])
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
    const fixedIds = args.fixed_issue_ids || []
    for (const id of fixedIds) {
      const issue = tg.issues.find((i) => i.id === id)
      if (issue && (issue.status === "open" || issue.status === "rejected")) {
        issue.status = "submitted"
        touchedAnyIssue = true
      }
    }

    const requestedIds: string[] = []
    for (const r of args.request_exempts || []) {
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

    if (args.self_check_results) {
      tg.devSelfCheckResults = args.self_check_results
    }

    await writeState(context.worktree, state)
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
  },
})

export const tool_review_submit = tool({
  description:
    "工具审核层提交。跨维提交 tool issues（issues 自带 dimension 字段），含 UT 结果。调用者必须为 openspec-reviewer-tool。",
  args: {
    passed: tool.schema.boolean().describe("工具层是否通过"),
    issues: tool.schema.array(toolIssueItem).optional().describe("跨维 issue，每个 item 需带 dimension"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("豁免裁定的 issue ID 列表"),
    rejected_issue_ids: tool.schema.array(rejectedIssueItem).optional().describe("驳回的 issue 列表（含原因）"),
    test_results: tool.schema.string().optional().describe("UT 运行结果摘要"),
    boundary_expansion: boundaryExpansionSchema.optional().describe("执行边界扩展（仅 passed=false 时有效）"),
  },
  async execute(args, context) {
    assertAgent(context, "opx_tool_review_submit", ["openspec-reviewer-tool"])
    const tlFixedIds = idsToStrings(args.fixed_issue_ids)
    const tlExemptIds = idsToStrings(args.exempt_issue_ids)
    const tlRejected = (args.rejected_issue_ids || []).map(r => ({ ...r, issue_id: String(r.issue_id) }))
    const state = await readStateByWorktree(context.worktree)
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
    assertPassWithIssues(args.passed, args.issues || [], "opx_tool_review_submit")

    const issues = (args.issues || []) as any[]
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

    if (tg.executionBoundary && args.boundary_expansion) {
      if (args.passed) {
        throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 passed=false 有效。")
      }
      mergeExecutionBoundary(tg, args.boundary_expansion)
    }

    tg.phases.review.tool.completed = true
    if (args.test_results) tg.phases.review.tool.testResults = args.test_results
    await writeState(context.worktree, state)

    const hasBlocking = hasBlockingIssues(tg.issues, "tool")
    if (args.passed && !hasBlocking) {
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
      await writeState(context.worktree, state)
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
    await writeState(context.worktree, state)
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
  },
})

export const task_review_submit = tool({
  description:
    "任务审核层提交。验证 task 产出、服务启动、接口可用性、测试代码审查。调用者必须为 openspec-reviewer-task。",
  args: {
    passed: tool.schema.boolean().describe("任务层是否通过"),
    verified_task_ids: tool.schema.array(tool.schema.string()).optional().describe("已验证完成的 task ID 列表"),
    failed_task_ids: tool.schema.array(taskVerifyResult).optional().describe("未完成的 task 列表（含原因）"),
    issues: tool.schema.array(reviewIssue).optional().describe("测试代码审查 issue"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("豁免裁定的 issue ID 列表"),
    rejected_issue_ids: tool.schema.array(rejectedIssueItem).optional().describe("驳回的 issue 列表（含原因）"),
    boundary_expansion: boundaryExpansionSchema.optional().describe("执行边界扩展（仅 passed=false 时有效）"),
    validation_steps: tool.schema.array(validationStepSchema).optional().describe("验证步骤执行摘要。必须覆盖 opx_status 操作指引中的全部步骤，已完成的标记 completed=true 并附 evidence，跳过的标记 completed=false 并附 skip_reason"),
  },
  async execute(args, context) {
    assertAgent(context, "opx_task_review_submit", ["openspec-reviewer-task"])
    if (args.verified_task_ids) args.verified_task_ids = args.verified_task_ids.map(String)
    if (args.failed_task_ids) args.failed_task_ids = args.failed_task_ids.map(f => ({ ...f, task_id: String(f.task_id) }))
    const tkFixedIds = idsToStrings(args.fixed_issue_ids)
    const tkExemptIds = idsToStrings(args.exempt_issue_ids)
    const tkRejected = (args.rejected_issue_ids || []).map(r => ({ ...r, issue_id: String(r.issue_id) }))
    const state = await readStateByWorktree(context.worktree)
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
    const verified = args.verified_task_ids || []
    const failed = args.failed_task_ids || []
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

    const rawIssues = (args.issues || []) as any[]
    let nextIssueId = tg.issues.reduce((m, i) => Math.max(m, parseInt(i.id, 10) || 0), 0) + 1
    const taskNewIssues: IssueItem[] = []
    for (const iss of rawIssues) {
      const dedupResult = deduplicateAndAddIssues(
        [iss], tg.issues,
        "style" as Dimension, "task",
        nextIssueId
      )
      if (dedupResult.dedupedCount > 0) continue
      if (dedupResult.newIssues.length > 0) {
        tg.issues.push(dedupResult.newIssues[0])
        taskNewIssues.push(dedupResult.newIssues[0])
        nextIssueId = dedupResult.nextIssueId
      }
    }

    assertPassWithIssues(args.passed, args.issues || [], "opx_task_review_submit")

    applyReviewGate(tg.issues, tkFixedIds, tkExemptIds, tkRejected, undefined, "task")

    if (tg.executionBoundary) {
      if (taskNewIssues.length > 0) {
        const dirs = tg.executionBoundary.allowed_directories
        for (const iss of taskNewIssues) {
          const dir = path.dirname(iss.file)
          const entry = dir === "" || dir === "." ? iss.file : dir
          if (entry !== "." && entry !== "" && !dirs.includes(entry)) dirs.push(entry)
        }
      }
      if (args.boundary_expansion) {
        if (args.passed) {
          throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 passed=false 有效。")
        }
        mergeExecutionBoundary(tg, args.boundary_expansion)
      }
    }

    if (args.validation_steps) {
      for (const step of args.validation_steps) {
        if (!step.completed && !step.skip_reason) {
          throw new Error(`验证步骤 "${step.step}" 标记为未完成但未提供跳过原因（skip_reason）。`)
        }
      }
      tg.phases.review.task.validationSteps = args.validation_steps.map(s => ({
        step: s.step,
        completed: s.completed,
        evidence: s.evidence || "",
        skip_reason: s.skip_reason || null,
      }))
    }

    if (args.passed) {
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
    if (!args.passed && failed.length === 0 && !hasBlockingIssues(tg.issues, "task")) {
      throw new Error(
        `任务层审核声称 passed=false，但既无 failed_task_ids 也无阻塞 issue。` +
        `passed=false 时必须至少指定一个 failed_task_id 或提交 Low+ issue 作为不通过理由。`
      )
    }

    tg.phases.review.task.completed = true
    await writeState(context.worktree, state)

    if (args.passed) {
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
      await writeState(context.worktree, state)
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
    await writeState(context.worktree, state)
    return JSON.stringify({
      status: "recorded",
      layer: "task",
      passed: false,
      retry_count: retryCount,
      message: "职责已完成，请立即结束当前会话。",
    })
  },
})

export const quality_review_submit = tool({
  description:
    "AI 语义审查层提交。维度由调用者身份自动识别。调用者必须为 openspec-reviewer-{style|architecture|performance|security|maintainability}。",
  args: {
    passed: tool.schema.boolean().describe("本维度是否通过"),
    issues: tool.schema.array(reviewIssue).optional().describe("新报审查 issue"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("豁免裁定的 issue ID 列表"),
    rejected_issue_ids: tool.schema.array(rejectedIssueItem).optional().describe("驳回的 issue 列表（含原因）"),
    boundary_expansion: boundaryExpansionSchema.optional().describe("执行边界扩展（仅 passed=false 时有效）"),
  },
  async execute(args, context) {
    const agentToDim = Object.fromEntries(
      Object.entries(DIMENSION_AGENT_MAP).map(([dim, agent]) => [agent, dim])
    )
    const dimension = agentToDim[context.agent] as Dimension | undefined
    if (!dimension) {
      throw new Error(
        `工具 "opx_quality_review_submit" 不支持调用者 "${context.agent}"。` +
        `仅支持：${Object.values(DIMENSION_AGENT_MAP).join(", ")}。`
      )
    }
    if (typeof args.passed !== "boolean" && args.passed !== "true" && args.passed !== "false") {
      throw new Error(
        `参数 passed 必须为布尔值（true/false），收到类型 "${typeof args.passed}"，值 "${args.passed}"。`
      )
    }
    const state = await readStateByWorktree(context.worktree)
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

    const qlFixedIds = idsToStrings(args.fixed_issue_ids)
    const qlExemptIds = idsToStrings(args.exempt_issue_ids)
    const qlRejected = (args.rejected_issue_ids || []).map(r => ({ ...r, issue_id: String(r.issue_id) }))

    const passed = args.passed === true || (args.passed as any) === "true"
    const issues = (args.issues || []) as any[]
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

    if (tg.executionBoundary && args.boundary_expansion) {
      if (args.passed) {
        throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 passed=false 有效。")
      }
      mergeExecutionBoundary(tg, args.boundary_expansion)
    }

    tg.phases.review.quality.progress[dimension] = passed ? "passed" : "failed"
    await writeState(context.worktree, state)
    const resultStr = await finalizeQualityPhase(state, tg, dimension, passed, context)
    if (dedupedCount > 0) {
      const result = JSON.parse(resultStr)
      result.deduped = dedupedCount
      result.message = result.message.replace(/([。！])\s*$/, `；${dedupedCount} 个重复 issue 已自动跳过。`)
      return JSON.stringify(result)
    }
    return resultStr
  },
})

export const resolve_review = tool({
  description:
    "编排者在 review 阶段重试超上限（needs_user_decision）后，根据用户决策推进。decision=continue：重置审查进度后继续修复；decision=giveup：将剩余待审 issue 置为 exempted 后完成。",
  args: {
    decision: tool.schema
      .enum(["continue", "giveup"])
      .describe("continue=继续修复；giveup=放弃"),
  },
  async execute(args, context) {
    assertOrchestrator(context, "opx_orch_resolve_review")
    const state = await readStateByWorktree(context.worktree)
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

    if (args.decision === "continue") {
      tg.phases.review.lastResolvedRetryCount = tg.phases.review.retryCount
      tg.phases.review.tool.completed = false
      tg.phases.review.task.completed = false
      for (const d of REVIEW_DIMENSIONS) {
        if (tg.phases.review.quality.progress[d] !== "passed") {
          tg.phases.review.quality.progress[d] = "pending"
        }
      }
      tg.status = "dev_impl"
      await writeState(context.worktree, state)
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
    await writeState(context.worktree, state)
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
  },
})
