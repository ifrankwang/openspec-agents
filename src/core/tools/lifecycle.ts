import path from "path"
import type { TaskGroupState, TaskItem, IssueItem, TaskStatus, Phase, BuildPhaseTarget, Phases, OrchestrateState } from "../types.js"
import { ORCHESTRATOR_AGENT, PHASE_ORDER, MAX_RETRIES, BLOCKING_SEVERITIES, DIMENSION_AGENT_MAP, AGENT_TO_SUBMIT_TOOL } from "../constants.js"
import { REVIEW_DIMENSIONS } from "../types.js"
import { runGit, runGitChecked, getCurrentBranch, getMergeBase, getDiffFileList, isWorktreeClean, mergeBranchToTarget, discoverDiskWorktrees } from "../git.js"
import { readStateByWorktree, readStateByChangeId, writeState, writeContextToWorktree } from "../state.js"
import { parseAllTaskGroupsFromMd, parseTasksMdForGroup, extractRelevantSpecsFromTasks } from "../tasks-md.js"
import { createEmptyPhases, assertOrchestrator, findTaskGroup, isReviewCompleted, deriveCurrentAgents } from "../derive.js"
import {
  renderOrchestratorView,
  renderArchitectView,
  renderDeveloperView,
  renderToolReviewView,
  renderTaskReviewView,
  renderQualityReviewView,
} from "../views.js"
import type { InitParams, SetWorktreeParams, UnattendedParams, ToolContext } from "./types.js"

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
    throw new Error(`task_group_id "${args.task_group_id}" 不在 tasks.md 中。可用 ID: [${parsedGroups.map((g) => g.id).join(", ")}]。`)
  }

  const parsedTasks = await parseTasksMdForGroup(ctx.worktree, args.change_id, args.task_group_id)
  const relevantSpecs = extractRelevantSpecsFromTasks(parsedTasks)
  const newTasks: TaskItem[] = parsedTasks.map((p, i) => ({
    id: String(i + 1),
    specTrace: p.specTrace,
    title: p.title,
    status: "open" as const,
    taskNumber: p.taskNumber,
    rejectReason: null,
  }))

  function buildPhases(
    targetPhase: BuildPhaseTarget | null,
    reviewLayer?: "tool" | "task" | "quality"
  ): { phases: Phases; status: BuildPhaseTarget } {
    if (!targetPhase) return { phases: createEmptyPhases(), status: "task_analysis" }
    const phases = createEmptyPhases()
    let found = false
    for (const p of PHASE_ORDER) {
      if (p === targetPhase) { found = true; continue }
      if (!found) {
        if (p === "dev_impl") {
        } else if (p === "review") {
        } else {
          phases.architect_review = { completed: true }
        }
      }
    }
    if (targetPhase === "review" && reviewLayer) {
      if (reviewLayer === "task" || reviewLayer === "quality") {
        phases.review.tool.completed = true
      }
      if (reviewLayer === "quality") {
        phases.review.task.completed = true
      }
    }
    return { phases, status: targetPhase }
  }

  const taskInjectionStatus: TaskStatus = args.recovery?.phase === "review" ? "verified" : "open"

  let state = await readStateByChangeId(ctx.worktree, args.change_id)
  const baseBranch = args.base_branch || await getCurrentBranch(ctx.worktree)
  const currentTaskGroupId = state?.taskGroupId
  const originalCtgStatus = state?.taskGroups.find(g => g.id === args.task_group_id)?.status ?? null
  if (state) {
    state.baseBranch = state.baseBranch || baseBranch
    const existingMap = new Map(state.taskGroups.map((g) => [g.id, g]))
    state.taskGroups = parsedGroups.map((p) => {
      const existing = existingMap.get(p.id)

      if (p.id !== args.task_group_id) {
        if (existing) {
          return { ...existing, name: p.name, taskCount: p.taskCount }
        }
        return {
          id: p.id, name: p.name, taskCount: p.taskCount,
          status: "task_analysis" as Phase,
          worktreePath: null, branchName: null, baseRef: null,
          executionBoundary: null,
          relevantSpecs: [], lastFilesChanged: [],
          phases: createEmptyPhases(),
          tasks: [],
          issues: [], blockers: [],
        }
      }

      if (existing && !args.recovery && currentTaskGroupId === p.id) {
        return { ...existing, name: p.name, taskCount: p.taskCount }
      }

      const recoveryPhase = existing?.blockers.some((blocker) => blocker.status !== "resolved")
        ? "task_analysis"
        : args.recovery?.phase
      const defaultPhase: Phase = (recoveryPhase ?? "task_analysis") as Phase
      const phases = args.recovery
        ? buildPhases(recoveryPhase as BuildPhaseTarget, args.recovery?.review_layer).phases
        : buildPhases("task_analysis").phases

      let tgTasks: TaskItem[]
      let tgIssues: IssueItem[]
      if (existing && args.recovery) {
        tgTasks = newTasks.map((t) => {
          const existingTask = existing.tasks.find((et) => et.id === t.id)
          return existingTask || { ...t, status: taskInjectionStatus }
        })
        tgIssues = [...existing.issues]
        phases.review = JSON.parse(JSON.stringify(existing.phases.review))
      } else {
        tgTasks = newTasks.map((t) => ({
          ...t,
          status: taskInjectionStatus,
        }))
        tgIssues = existing?.issues ?? []
        if (existing && args.recovery) {
          phases.review = JSON.parse(JSON.stringify(existing.phases.review))
        }
      }

      if (args.recovery?.phase === "review" && args.recovery?.review_layer) {
        const rl = args.recovery.review_layer
        if (rl === "task" || rl === "quality") {
          phases.review.tool.completed = true
        }
        if (rl === "quality") {
          phases.review.task.completed = true
        }
      }

      const base: TaskGroupState = {
        id: p.id, name: p.name, taskCount: p.taskCount,
        status: defaultPhase,
        worktreePath: null, branchName: null, baseRef: null,
        executionBoundary: existing?.executionBoundary ?? null,
        relevantSpecs,
        lastFilesChanged: existing?.lastFilesChanged ?? [],
        phases,
        tasks: tgTasks,
        issues: tgIssues,
        blockers: existing?.blockers ?? [],
      }

      return base
    })
    state.taskGroupId = args.task_group_id
  } else {
    state = {
      changeId: args.change_id,
      taskGroupId: args.task_group_id,
      baseBranch,
      taskGroups: parsedGroups.map((p) => {
        const isCurrent = p.id === args.task_group_id
        const defaultPhase = args.recovery ? args.recovery.phase : "task_analysis"
        const { phases, status } = isCurrent
          ? buildPhases(args.recovery ? (args.recovery.phase as BuildPhaseTarget) : "task_analysis", args.recovery?.review_layer)
          : { phases: createEmptyPhases(), status: "task_analysis" as Phase }
        return {
          id: p.id, name: p.name, taskCount: p.taskCount,
          status,
          worktreePath: null, branchName: null, baseRef: null,
          executionBoundary: null,
          relevantSpecs: isCurrent ? relevantSpecs : [],
          lastFilesChanged: [],
          phases,
          tasks: isCurrent
            ? newTasks.map((t) => ({ ...t, status: taskInjectionStatus }))
            : [],
          issues: [], blockers: [],
        }
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  const ctg = findTaskGroup(state, args.task_group_id)
  if (args.recovery) {
    ctg.worktreePath = null
    ctg.branchName = null
    ctg.baseRef = null
    ctg.lastFilesChanged = []
  }

  if (args.recovery?.reopenIssues) {
    if (originalCtgStatus !== "completed") {
      throw new Error(`reopenIssues 仅支持已完成（completed）的任务组，当前状态为 "${originalCtgStatus}"。`)
    }
    if (args.recovery.phase !== "dev_impl") {
      throw new Error("reopenIssues 仅支持恢复到 dev_impl 阶段。")
    }
    if (args.recovery.review_layer) {
      throw new Error("reopenIssues 与 review_layer 互斥，不可同时使用。")
    }

    for (const issue of ctg.issues) {
      if (issue.status !== "verified") {
        issue.status = "rejected"
        issue.rejectReason = issue.rejectReason || "(通过 reopenIssues 自动驳回)"
      }
    }

    ctg.phases.review.tool.completed = false
    ctg.phases.review.task.completed = false
    for (const d of REVIEW_DIMENSIONS) {
      ctg.phases.review.quality.progress[d] = "pending"
    }
    ctg.phases.review.retryCount = 0
    ctg.phases.review.lastResolvedRetryCount = 0

    ctg.worktreePath = null
    ctg.branchName = null
    ctg.baseRef = null
    ctg.lastFilesChanged = []

    ctg.status = "dev_impl"
  }

  await writeState(ctx.worktree, state)

  const recoveryMsg = args.recovery
    ? `已恢复到 ${args.recovery.phase} 阶段。`
    : ""
  return JSON.stringify(
    {
      status: "initialized",
      change_id: state.changeId,
      task_group_count: state.taskGroups.length,
      current_task_group: targetGroup,
      active_phase: ctg.status,
      task_count: newTasks.length,
      message: `编排会话已初始化。${recoveryMsg}`,
    },
    null,
    2
  )
}

export async function setWorktreeExecute(params: SetWorktreeParams, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx.agent, "opx_orch_set_worktree")
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const tg = findTaskGroup(state, state.taskGroupId)

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
      tg.worktreePath = existingPath
      tg.branchName = branch
      const baseRef = await getMergeBase(existingPath, state.baseBranch)
      if (baseRef) {
        tg.baseRef = baseRef
        if (!tg.lastFilesChanged || tg.lastFilesChanged.length === 0) {
          tg.lastFilesChanged = await getDiffFileList(existingPath, baseRef)
        }
      }
      reused = true
    } else {
      const clean = await isWorktreeClean(existingPath)
      if (!clean) {
        throw new Error(
          `已有 worktree "${existingPath}" 与 ${state.baseBranch} 分叉且有未提交变更，` +
          `无法自动 fast-forward。请手动处理后重试。`
        )
      }
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

  if (!reused) {
    const forkBranch = state.baseBranch
    await runGit(repoRoot, ["worktree", "add", "-b", branch, wtPath, forkBranch])

    const baseRef = await getMergeBase(wtPath, forkBranch)
    if (!baseRef) throw new Error(`worktree 创建成功但无法获取与 ${forkBranch} 的 merge-base：${wtPath}`)

    tg.worktreePath = wtPath
    tg.branchName = branch
    tg.baseRef = baseRef
    if (!tg.lastFilesChanged || tg.lastFilesChanged.length === 0) {
      tg.lastFilesChanged = await getDiffFileList(wtPath, baseRef)
    }
  }

  await writeState(ctx.worktree, state)

  // 在 worktree 中写入上下文指针，供 worktree 内 session 读取 state
  if (tg.worktreePath) {
    await writeContextToWorktree(tg.worktreePath, state.changeId, state.taskGroupId)
  }

  return [
    `- **状态**: ${reused ? "复用已有 worktree" : "已创建 worktree"}`,
    `- **路径**: \`${tg.worktreePath}\``,
    `- **分支**: \`${branch}\``,
    `- **基准提交**: \`${tg.baseRef?.slice(0, 7)}\``,
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
    return JSON.stringify({ initialized: false, message: "编排会话尚未初始化。" }, null, 2)
  }

  const tg = findTaskGroup(state, state.taskGroupId)

  if (agent !== ORCHESTRATOR_AGENT) {
    const expected = deriveCurrentAgents(tg)
    if (!expected.includes(agent)) {
      return [
        "# ⛔ 阶段门禁",
        "",
        `当前阶段为 **${tg.status}**，未轮到你（**${agent}**）执行。`,
        `当前预期角色为：\`${expected.join(", ") || "(无)"}\``,
        "",
        "请立即结束当前会话，不要执行任何操作。",
      ].join("\n")
    }
  }

  let view: string
  if (agent === ORCHESTRATOR_AGENT) {
    const diskWts = await discoverDiskWorktrees(ctx.worktree)
    view = renderOrchestratorView(state, tg, diskWts)
  } else if (agent === "openspec-architect") {
    view = renderArchitectView(state, tg)
  } else if (agent === "openspec-developer") {
    view = renderDeveloperView(state, tg)
  } else if (agent === "openspec-reviewer-tool") {
    view = renderToolReviewView(state, tg)
  } else if (agent === "openspec-reviewer-task") {
    view = renderTaskReviewView(state, tg)
  } else if (Object.values(DIMENSION_AGENT_MAP).includes(agent)) {
    view = renderQualityReviewView(state, tg, agent)
  } else {
    view = renderOrchestratorView(state, tg)
  }

  if (agent !== ORCHESTRATOR_AGENT) {
    const submitTool = AGENT_TO_SUBMIT_TOOL[agent] || "对应 submit 工具"
    const submitConvention = agent === "openspec-architect"
      ? "按结果提交 `outcome=ready`；blocker 用 `opx_arch_blocker` 处理。"
      : agent === "openspec-developer"
        ? "按结果提交 `outcome=completed` 或 `outcome=blocked`。"
        : "即使无 issue / 无待处理项，也必须提交 `passed=true`。"
    const instructionBlock = [
      "# ✅ 当前轮到你执行",
      "",
      `完成本职工作后**必须**调用 \`${submitTool}()\` 提交。`,
      submitConvention,
      "",
      "---",
      "",
    ].join("\n")
    view = instructionBlock + view
  }

  return view
}

export async function completeTaskGroupExecute(params: { change_id: string }, ctx: ToolContext): Promise<string> {
  assertOrchestrator(ctx.agent, "opx_orch_complete_task_group")
  const state = await readStateByWorktree(ctx.worktree, params.change_id)
  if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
  const tg = findTaskGroup(state, state.taskGroupId)
  if (!isReviewCompleted(tg) || tg.status === "completed") {
    throw new Error(
      `阶段顺序错误：opx_orch_complete_task_group 需在 review 完成后调用，当前 isReviewCompleted=${isReviewCompleted(tg)}，tg.status=${tg.status}。`
    )
  }
  if (tg.worktreePath) {
    const clean = await isWorktreeClean(tg.worktreePath)
    if (!clean) throw new Error(`worktree "${tg.worktreePath}" 存在未 commit 内容，请先 commit 再完成任务组。`)
  }
  const openIssues = tg.issues.filter(
    (i) => (i.status === "open" || i.status === "rejected") && (BLOCKING_SEVERITIES as readonly string[]).includes(i.severity)
  )
  if (openIssues.length > 0) {
    throw new Error(`存在 ${openIssues.length} 个 Low 及以上的 open/rejected issue 未处理，请先修复或申请豁免。`)
  }
  const openTasks = tg.tasks.filter(
    (t) => t.status === "open" || t.status === "submitted" || t.status === "rejected"
  )
  if (openTasks.length > 0) {
    throw new Error(`存在 ${openTasks.length} 个未完成 task。`)
  }
  const unresolvedBlockers = tg.blockers.filter((blocker) => blocker.status !== "resolved")
  if (unresolvedBlockers.length > 0) {
    throw new Error(`存在 ${unresolvedBlockers.length} 个未解决 blocker，无法完成任务组。`)
  }
  const mergeTarget = state.baseBranch
  if (tg.branchName) {
    const mergeResult = await mergeBranchToTarget(ctx.worktree, tg.branchName, mergeTarget)
    if (!mergeResult.success) {
      return JSON.stringify(
        {
          status: "blocked",
          merge_conflict: true,
          message:
            `合并到 "${mergeTarget}" 时发生冲突，已中止合并。` +
            `请手动在目标分支解决冲突后完成合并 (git merge ${tg.branchName})，` +
            `完成后重新调 opx_orch_complete_task_group 完成收尾。worktree 与分支已保留。`,
        },
        null,
        2
      )
    }
  }
  if (tg.worktreePath && tg.branchName) {
    try {
      await runGit(ctx.worktree, ["worktree", "remove", tg.worktreePath, "--force"])
      await runGit(ctx.worktree, ["branch", "-D", tg.branchName])
    } catch {
    }
  }
  tg.status = "completed"
  await writeState(ctx.worktree, state)
  return JSON.stringify(
    {
      status: "ok",
      completed_task_group: tg.id,
      merge_target: mergeTarget,
      message: `任务组已完成并合并到 "${mergeTarget}"。`,
    },
    null,
    2
  )
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
