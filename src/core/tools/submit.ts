import type { OrchestrateState } from "../types.js"
import type { ToolContext, AgentSubmitParams } from "./types.js"
import type { WorkItem, Severity, StepConfig } from "../workflow/types.js"
import { loadWorkflowFile, TASK_WORKFLOW_PATH, type LoadedWorkflow } from "../workflow/loader.js"
import {
  submitForStep, adjudicateExempt, adjudicateRecheck, assertSubmitRouting,
} from "../workflow/submit.js"
import {
  createInitialWorkItem, checkpointTriggered,
  applyCheckpointContinue, applyCheckpointGiveup,
  getStepVerdict, clearStepTags, isBlockingSeverity, isInfoSeverity, isTerminalPhase,
} from "../workflow/engine.js"
import { resetReviewTagsOnFix, dedupeNewChildren, resolveChildIssueFields } from "../workflow/reset.js"
import { agentToReviewDimension, readIssueSource } from "../constants.js"
import { REVIEW_DIMENSIONS } from "../types.js"
import type { Dimension } from "../types.js"
import { taskChildrenOf, taskChildById, normalizeTaskChildIds, taskListOf, issueChildrenOf } from "../task-children.js"
import { markTaskGroupCheckboxesComplete, reconcileMainPollution } from "../git.js"
import { assertIssueFilesWithin } from "../paths.js"
import {
  readStateByWorktree, writeState, getLockPath, acquireLock, releaseLock,
} from "../state.js"

/** 读取 task workflow 配置（assets/workflows/task.yaml），进程内缓存。 */
const loadTaskWorkflow = () => loadWorkflowFile(TASK_WORKFLOW_PATH)

/** issue id 归一化：去 # 前缀（review 工具按 tg.issue 序号引用时可能带 #）。 */
function normalizeIssueId(id: string): string {
  return String(id).trim().replace(/^#/, "")
}

/**
 * 判定本次 review 提交是否「仅携带裁定类参数」（recheck_adjudications / exempt_adjudications，无其他实质参数）。
 * 供重复提交守卫的补交豁免：reviewer 上次 passed 提交漏带复核/豁免裁定导致本层 review 态 issue
 * 阻塞门禁时（见 engine.blockedSupplementAgents 推导），允许仅补带 recheck_adjudications /
 * exempt_adjudications 重提解除阻塞；空提交或携带其他实质参数（含 fixed_issue_ids /
 * exempt_issue_ids / new_children）的重复提交仍被守卫拒绝。
 */
function isSupplementOnly(params: AgentSubmitParams): boolean {
  const hasAdjudication =
    (params.recheck_adjudications?.length ?? 0) > 0 ||
    (params.exempt_adjudications?.length ?? 0) > 0
  if (!hasAdjudication) return false
  return (
    (params.fixed_issue_ids?.length ?? 0) === 0 &&
    (params.exempt_issue_ids?.length ?? 0) === 0 &&
    (params.new_children?.length ?? 0) === 0 &&
    (params.verified_tasks?.length ?? 0) === 0 &&
    (params.failed_tasks?.length ?? 0) === 0 &&
    !params.boundary_expansion &&
    (params.validation_steps?.length ?? 0) === 0 &&
    params.test_results === undefined
  )
}

/**
 * 统一裁定一致性守卫：任一裁定参数含「驳回（rejected）」时，提交级 verdict 必须为 failed。
 * - exempt_adjudications 含 action==="rejected"（issue 回 todo 继续修复）→ verdict 必须为 failed
 * - recheck_adjudications 含 verdict==="rejected"（issue 回 todo + refix_count 递增 + 写 reject_reason）→ verdict 必须为 failed
 * 驳回意味着该 issue 需修复，审查不能判定通过：rejected+passed 会让 review 态 issue 以非终态滞留，
 * 门禁要求本层 blocking issue 终态（stepCanPass=false 且无补交推导），形成静默死锁。
 * dismissed/passed 是合法组合（裁定完成且维度通过），不受此守卫限制。
 * 零副作用：守卫在一切裁定写入（adjudicateExempt/adjudicateRecheck）与 submitForStep 应用 verdict 之前调用，
 * 拒绝时保证零状态变更（含混合裁定清单）。
 */
function assertRejectedAdjudicationNotPassed(params: AgentSubmitParams): void {
  if (params.verdict !== "passed") return
  const rejectedExempt = params.exempt_adjudications?.find((adj) => adj.action === "rejected")
  if (rejectedExempt) {
    throw new Error(
      `豁免裁定失败：issue "${rejectedExempt.issue_id}" 被驳回（rejected），该 issue 需修复，verdict 必须为 failed，不能以 passed 提交。`
    )
  }
  const rejectedRecheck = params.recheck_adjudications?.find((adj) => adj.verdict === "rejected")
  if (rejectedRecheck) {
    throw new Error(
      `复核失败：issue "${rejectedRecheck.issue_id}" 被驳回（rejected），该 issue 需修复，verdict 必须为 failed，不能以 passed 提交。`
    )
  }
}

/** 以 tg.issue 原始 id 解析 child（externalId 优先，兜底 issue: 前缀），供豁免裁定定位。
 *  issue child 优先匹配（与 childById 语义对称）：task child 短数字 id 可能与 issue externalId 撞车，
 *  fixed/exempt 归因解析须命中 issue child，未命中再兜底 task child。 */
function resolveChildByIssueId(item: WorkItem, issueId: string): WorkItem | null {
  const match = (c: WorkItem): boolean =>
    c.externalId === issueId || c.id === issueId || c.id === `issue:${issueId}`
  return issueChildrenOf(item).find(match) ?? taskChildrenOf(item).find(match) ?? null
}

/**
 * 定位当前 taskGroup 对应的活跃 task WorkItem。
 * 单轨下 workItems 为唯一事实源（init 构造 / 旧格式读兼容自动升级），缺失即未初始化。
 */
function resolveTaskWorkItem(state: OrchestrateState): WorkItem {
  const taskId = `task:${state.taskGroupId}`
  const item = state.workItems.find((w) => w.id === taskId)
  if (!item) {
    throw new Error(`工作项 "${taskId}" 缺失，请重新调用 opx_orch_init 初始化。`)
  }
  return item
}

/** 正常提交路径的固定返回体：提交状态与推进详情对子代理无意义，仅告知提交成功并结束会话。 */
const SUBMIT_OK_MESSAGE = "提交成功，请直接结束当前会话"

// ─── M1a 参数面处理：task children / metadata.blockers / 分层重置 ───

interface ItemBlocker {
  id: string
  sourceRole: string
  taskId: string | null
  category: string
  description: string
  evidence: string
  attemptedActions: string
  options: string[]
  status: "awaiting_user" | "resolved"
  userResponse: string | null
  architectConclusion: string | null
}

/** 读取 metadata.blockers（analyze/implement 上报的 blocker 清单）。 */
function itemBlockers(item: WorkItem): ItemBlocker[] {
  return Array.isArray(item.metadata["blockers"]) ? (item.metadata["blockers"] as ItemBlocker[]) : []
}

/** 新增 blocker 到 metadata.blockers，id 按 b{n} 递增，status=awaiting_user。 */
function addItemBlockers(item: WorkItem, raw: NonNullable<AgentSubmitParams["blockers"]>): void {
  const list = itemBlockers(item)
  let nextId = list.reduce((max, b) => Math.max(max, Number(b.id.replace(/^b/, "")) || 0), 0) + 1
  for (const b of raw) {
    list.push({
      id: `b${nextId++}`,
      sourceRole: b.source_role,
      taskId: b.task_id ?? null,
      category: b.category,
      description: b.description,
      evidence: b.evidence,
      attemptedActions: b.attempted_actions,
      options: b.options ?? [],
      status: "awaiting_user",
      userResponse: null,
      architectConclusion: null,
    })
  }
  item.metadata["blockers"] = list
}

/** 汇总 fixed/exempt issue 的归因分层（报源层 + quality 维度），供 resetReviewTagsOnFix 使用。
 *  fixed（实际修改代码）触发 quality 维 tag 清除（含显式声明维度的跨维归因标签）；exempt（豁免=接受现状、
 *  不修改代码）不触发 quality 维 tag 清除——已 passed 的维度无需因豁免重审。 */
function collectFixedExemptLayers(
  item: WorkItem,
  fixedIds: string[],
  exemptIds: string[],
): { fixedSourcePhases: string[]; exemptSourcePhases: string[]; touchedQualityDims: string[] } {
  const fixedSourcePhases = new Set<string>()
  const exemptSourcePhases = new Set<string>()
  const touchedQualityDims = new Set<string>()
  /** 归因维 tag 纳入（仅 fixed）：报源层为 quality（本维 issue，含缺省维度）或显式声明了维度（tool/task 跨维归因标签）
   *  都计入——跨维 issue 修复后目标维 verify_quality tag 须清，否则回退重审期该维恒 failed 永不分派（死锁）。
   *  exempt 不调用本函数：豁免不改代码，清除维度 tag 会触发无实际待办的重复调度。 */
  const touchQualityDim = (child: WorkItem): void => {
    const f = resolveChildIssueFields(child)
    const declaredDim = (REVIEW_DIMENSIONS as readonly string[]).includes(child.metadata["dimension"] as string)
      ? (child.metadata["dimension"] as Dimension)
      : undefined
    if (f.sourcePhase === "quality" || declaredDim) touchedQualityDims.add(declaredDim ?? f.dimension)
    // 报源维度兜底：quality 报源未显式声明 dimension（缺省回落 style）时，补报源 reviewer 自身维度 tag——
    // 否则仅清 style 而报源维残留，回退重审期该维恒 failed 多一轮不必要重审。
    if (!declaredDim && f.sourcePhase === "quality") {
      const source = readIssueSource(child) ?? ""
      const sourceDim = agentToReviewDimension(source)
      if (sourceDim) touchedQualityDims.add(sourceDim)
    }
  }
  for (const id of fixedIds) {
    const child = resolveChildByIssueId(item, id)
    if (!child) continue
    // 报源层 tag 必清（谁提谁裁定：tool 报的跨维 issue 修复后 verify_tool 必重跑）
    fixedSourcePhases.add(resolveChildIssueFields(child).sourcePhase)
    touchQualityDim(child)
  }
  for (const id of exemptIds) {
    const child = resolveChildByIssueId(item, id)
    if (!child) continue
    // 报源层 tag 语义保留（tool/task 报源 exempt 仍清本层 tag——「谁提谁裁定」派发报源 reviewer 裁定豁免申请的通道），
    // 但不触发 touchQualityDim：exempt 不改代码，quality 维度 tag 保留 passed。
    exemptSourcePhases.add(resolveChildIssueFields(child).sourcePhase)
  }
  return {
    fixedSourcePhases: [...fixedSourcePhases],
    exemptSourcePhases: [...exemptSourcePhases],
    touchedQualityDims: [...touchedQualityDims],
  }
}

/** 由 new_children 参数构造 issue child，透传全部分子段到 metadata（source/dimension/file/line/suggestion/rule/root_cause_guess）。
 *  报源层由 metadata.source 反推（见 agentToReviewLayer），不再写入 source_phase。
 *  dimension 提交语义：quality reviewer（agentToReviewDimension 命中）由报源维度推断写入；
 *  tool/task reviewer 透传显式声明的归因维度（校验循环已保证必填且合法）。 */
function buildIssueChild(nc: NonNullable<AgentSubmitParams["new_children"]>[number], sourceAgent: string): WorkItem {
  const child = createInitialWorkItem({
    id: nc.id,
    source: sourceAgent,
    externalId: nc.id,
    type: "issue",
    title: nc.title,
    description: nc.description,
    severity: nc.severity as Severity | undefined,
  })
  child.metadata["source"] = sourceAgent
  const sourceDim = agentToReviewDimension(sourceAgent)
  child.metadata["dimension"] = sourceDim ?? nc.dimension
  if (nc.file) child.metadata["file"] = nc.file
  if (nc.line !== undefined) child.metadata["line"] = nc.line
  if (nc.suggestion) child.metadata["suggestion"] = nc.suggestion
  if (nc.rule) child.metadata["rule"] = nc.rule
  if (nc.root_cause_guess) child.metadata["root_cause_guess"] = nc.root_cause_guess
  return child
}

/** 清空 review 三个验证 step 的裁决 tags（审查未过/任务驳回回退时复核标记重置，下次进入 review 各层重新分派）。 */
function clearReviewVerificationTags(item: WorkItem): void {
  clearStepTags(item, "verify_tool")
  clearStepTags(item, "verify_task")
  clearStepTags(item, "verify_quality")
}

/** blocker 提交后的 reset 助手：task children 全 todo + 清 review 层验证标记（对齐旧 resetForBlocker）。 */
function resetTasksForBlocker(item: WorkItem): void {
  for (const child of taskChildrenOf(item)) {
    child.phase = "todo"
    delete child.metadata["reject_reason"]
  }
  clearReviewVerificationTags(item)
}

/** analyze step 参数处理：execution_boundary（passed 必传）、blockers/blocker_updates、无未解决 blocker 门禁。 */
function handleAnalyzeParams(item: WorkItem, params: AgentSubmitParams): void {
  if (params.verdict === "passed" && !params.execution_boundary) {
    throw new Error("analyze step 提交 passed 时必须提供 execution_boundary。")
  }
  if (params.execution_boundary) {
    item.metadata["execution_boundary"] = params.execution_boundary
  }
  if (params.blockers?.length) addItemBlockers(item, params.blockers)
  if (params.blocker_updates?.length) {
    for (const u of params.blocker_updates) {
      const blocker = itemBlockers(item).find((b) => b.id === u.blocker_id)
      if (!blocker) throw new Error(`blocker "${u.blocker_id}" 不存在于 metadata.blockers 中。`)
      if (blocker.status !== "awaiting_user") throw new Error(`blocker "${u.blocker_id}" 状态不是 awaiting_user，无法更新。`)
      blocker.userResponse = u.user_response
      blocker.status = "resolved"
    }
  }
  if (params.verdict === "passed" && itemBlockers(item).some((b) => b.status !== "resolved")) {
    throw new Error("存在未解决的 blocker，无法以 passed 提交 analyze step。请先通过 blocker_updates 处理全部 blocker。")
  }
}

/** implement step 参数处理：blocker（on_fail）、completed_task_ids + 覆盖门禁、self_check_results。 */
function handleImplementParams(item: WorkItem, params: AgentSubmitParams): void {
  if (params.blocker) {
    if (params.verdict !== "failed") {
      throw new Error("blocker 参数仅支持 verdict=failed 提交（on_fail 回退 analyze）。")
    }
    addItemBlockers(item, [params.blocker])
    resetTasksForBlocker(item)
    return
  }

  const tasks = taskListOf(item)
  const completed = normalizeTaskChildIds(params.completed_task_ids ?? [], item)
  const validIds = new Set(tasks.map((t) => t.id))
  for (const id of completed) {
    if (!validIds.has(id)) {
      throw new Error(
        `completed_task_ids 中包含无效 task id: "${id}"。\n有效 task ID: ${Array.from(validIds).sort((a, b) => Number(a) - Number(b)).join(", ")}`
      )
    }
  }
  // 仅 todo 态 task child 置 review（submitted 语义）+ 清 reject_reason；
  // done 态（已 verified）跳过不降级——质量层回退后已验证任务不得重新验证。
  for (const id of completed) {
    const child = taskChildById(item, id)
    if (child && child.phase === "todo") {
      child.phase = "review"
      delete child.metadata["reject_reason"]
    }
  }
  // 按条目状态重投影（而非 id 集合）判定遗漏：置 review 循环之后仍存在任何 open/rejected 条目即显式失败。
  // 重复 id 的第二套条目（id 已在 completed_task_ids 中但状态未变更）与真遗漏条目都会在此暴露，
  // 避免旧逻辑按 id 集合判定漏检而让下游 forwardGatePassed 静默死锁。
  const remaining = taskListOf(item).filter(
    (t) => t.status === "open" || t.status === "rejected"
  )
  if (remaining.length > 0) {
    throw new Error(
      `以下 task 处于 open/rejected 状态且未在 completed_task_ids 中：\n` +
      remaining.map((t) => `- #${t.id}(${t.status}) ${t.title}`).join("\n") +
      `\n请将未完成的 task 列在 completed_task_ids 中，或改用 blocker 上报阻塞。`
    )
  }

  if (params.self_check_results) {
    item.metadata["self_check_results"] = params.self_check_results
  }
}

/** 把 boundary_expansion 的目录/包合并进执行边界（metadata 为事实源，缺失则忽略）。 */
function mergeBoundaryInto(item: WorkItem, expansion: NonNullable<AgentSubmitParams["boundary_expansion"]>): void {
  const boundary = item.metadata["execution_boundary"] as {
    allowed_directories: string[]
    allowed_packages: string[]
    notes: string
  } | undefined
  if (!boundary) return
  for (const dir of expansion.allowed_directories ?? []) {
    if (!boundary.allowed_directories.includes(dir)) boundary.allowed_directories.push(dir)
  }
  for (const pkg of expansion.allowed_packages ?? []) {
    if (!boundary.allowed_packages.includes(pkg)) boundary.allowed_packages.push(pkg)
  }
}

/**
 * verdict=failed 必须有具体不通过理由（对齐 main assertPassedConsistency）。
 * 理由判定（认遗留 issue 或实际接受的 new_children）：
 * - verify_task：本次 failed_tasks 非空，或 new_children 含 Low+，或存在未终态的 Low+ task 报源层阻塞 child
 * - verify_tool：本次 new_children 含 Low+，或存在未终态的 Low+ tool 报源层阻塞 child
 * - verify_quality：本次 new_children 含 Low+ 且维度属于当前提交 agent，或存在未终态的 Low+ quality 报源层
 *   阻塞 child 且 dimension 属于当前提交 agent 维度（新报与遗留理由均按维度过滤，F3；报源层由 source 反推）
 * 理由判定在 dedupeNewChildren 之后调用（F4）：传入的 newChildren 为已去重的 accepted，重复新报不构成理由。
 * 不满足即抛错，handleReviewParams 在 submitForStep 之前调用，零状态变更。
 */
function assertFailedHasReason(
  item: WorkItem,
  params: AgentSubmitParams,
  newChildren: WorkItem[],
  stepId: string,
  agent: string,
): void {
  const hasNewBlocking = newChildren.some((c) => isBlockingSeverity(c.severity))
  const existingBlocking = item.children.filter((c) => !isTerminalPhase(c.phase) && isBlockingSeverity(c.severity))
  let layerName: string
  let hasReason: boolean
  if (stepId === "verify_task") {
    layerName = "任务层"
    hasReason =
      (params.failed_tasks?.length ?? 0) > 0 ||
      hasNewBlocking ||
      existingBlocking.some((c) => resolveChildIssueFields(c).sourcePhase === "task")
  } else if (stepId === "verify_tool") {
    layerName = "工具层"
    hasReason = hasNewBlocking || existingBlocking.some((c) => resolveChildIssueFields(c).sourcePhase === "tool")
  } else {
    const dimension = agentToReviewDimension(agent)
    layerName = dimension ? `AI 审查层(${dimension})` : "AI 审查层"
    // 新报与遗留阻塞理由均按当前 agent 维度过滤（对齐 main：verify_quality failed 理由须归属本维）。
    const dimMatches = (c: WorkItem): boolean => resolveChildIssueFields(c).dimension === dimension
    hasReason =
      newChildren.some((c) => isBlockingSeverity(c.severity) && dimMatches(c)) ||
      existingBlocking.some(
        (c) => resolveChildIssueFields(c).sourcePhase === "quality" && dimMatches(c),
      )
  }
  if (!hasReason) {
    throw new Error(
      `${layerName} 审核声称 passed=false，但不存在未解决的阻塞 issue。passed=false 时必须提供至少一个 Low+ issue 或 failed_task_id 作为不通过理由。`
    )
  }
}

/** review step（verify_tool/verify_task/verify_quality）参数处理。 */
function handleReviewParams(item: WorkItem, params: AgentSubmitParams, newChildren: WorkItem[], stepId: string): void {
  // passed=true 与 Low+ 新报一致性：passed 只能带 Info 新报
  if (params.verdict === "passed" && newChildren.some((c) => isBlockingSeverity(c.severity))) {
    throw new Error(
      "review step 声称 passed=true，但 new_children 中包含 Low 及以上级别 issue。passed=true 只能带 Info 新报；有 Low+ issue 时必须设 verdict=failed。"
    )
  }
  // boundary_expansion 仅 passed=false 允许
  if (params.boundary_expansion) {
    if (params.verdict === "passed") {
      throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 verdict=failed 有效。")
    }
    mergeBoundaryInto(item, params.boundary_expansion)
  }

  if (params.test_results) item.metadata["test_results"] = params.test_results

  if (params.validation_steps) {
    for (const s of params.validation_steps) {
      if (!s.completed && !s.skip_reason) {
        throw new Error(`验证步骤 "${s.step}" 标记为未完成但未提供跳过原因（skip_reason）。`)
      }
    }
    item.metadata["validation_steps"] = params.validation_steps
  }

  if (params.verified_tasks?.length || params.failed_tasks?.length) {
    const tasks = taskListOf(item)
    const validIds = new Set(tasks.map((t) => t.id))
    const verified = normalizeTaskChildIds(params.verified_tasks ?? [], item)
    const failed = (params.failed_tasks ?? []).map((f) => ({
      task_id: normalizeTaskChildIds([f.task_id], item)[0],
      reason: f.reason,
    }))
    for (const id of [...verified, ...failed.map((f) => f.task_id)]) {
      if (!validIds.has(id)) {
        throw new Error(`非法 task id: "${id}"。\n合法 id：${Array.from(validIds).join(", ")}。`)
      }
    }
    if (params.verdict === "passed" && failed.length > 0) {
      throw new Error("passed=true 时不允许提供 failed_tasks；有任务未通过必须设 verdict=failed。")
    }
    // review 态 task child（submitted 语义）必须被 verified/failed 覆盖
    const submitted = tasks.filter((t) => t.status === "submitted")
    const covered = new Set([...verified, ...failed.map((f) => f.task_id)])
    const uncovered = submitted.filter((t) => !covered.has(t.id))
    if (uncovered.length > 0) {
      throw new Error(
        `以下 submitted task 未被 verified_tasks 或 failed_tasks 覆盖：\n` +
        uncovered.map((t) => `- #${t.id} ${t.title}`).join("\n")
      )
    }
    for (const id of verified) {
      const child = taskChildById(item, id)
      if (child && child.phase === "review") {
        child.phase = "done"
        delete child.metadata["reject_reason"]
      }
    }
    for (const f of failed) {
      const child = taskChildById(item, f.task_id)
      if (child && child.phase === "review") {
        child.phase = "todo"
        child.metadata["reject_reason"] = f.reason
      }
    }
  }
}

/**
 * 通用 step 提交（opx_agent_submit 的 execute）。
 *
 * 单轨操作 state.workItems：定位活跃 task WorkItem → 按 step 处理业务参数 → 调 submitForStep 驱动
 * workflow 状态机 → 把 item 的 phase/children/tags 变更直接持久化回 state.workItems（唯一事实源）。
 *
 * 全局写锁：整个 execute 的读-改-写全程持有 acquireLock/releaseLock，覆盖所有角色提交，
 * 防止多 agent 并行 read-modify-write 丢 tag。越权/校验失败抛错时零落盘。
 *
 * checkpoint_decision 为检查点决策入口：仅当 item 处于检查点态（_checkpoint 标记
 * 或 retryCount 达上限且存在未终态 children）时可用，直接应用决策并落盘，不走提交路径。
 */
export async function agentSubmitExecute(params: AgentSubmitParams, ctx: ToolContext): Promise<string> {
  const lockPath = await getLockPath(ctx.worktree, params.change_id)
  await acquireLock(lockPath)
  try {
    const state = await readStateByWorktree(ctx.worktree, params.change_id)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    const workflow = loadTaskWorkflow()
    const item = resolveTaskWorkItem(state)

    if (params.checkpoint_decision) {
      return applyCheckpointDecision(params, item, workflow, ctx, state)
    }

    // worktree 就绪硬门禁：worktree_path 缺失时拒绝提交（checkpoint_decision 不走提交路径，已在上方绕过）。
    // 所有 step（analyze/implement/verify_tool/verify_task/verify_quality）统一受此门禁约束。
    const wtPath = typeof item.metadata["worktree_path"] === "string" ? item.metadata["worktree_path"] : undefined
    if (!wtPath) {
      throw new Error(
        "worktree 未就绪，当前拒绝提交。\n请编排者先调用 opx_orch_set_worktree 确保 worktree 就绪后再提交。"
      )
    }

    // 参数归一化：issue id 去 # 前缀（fixed/exempt/adjudication/recheck 均接受带 # 的 tg.issue 序号引用）
    if (params.fixed_issue_ids) params.fixed_issue_ids = params.fixed_issue_ids.map(normalizeIssueId)
    if (params.exempt_issue_ids) params.exempt_issue_ids = params.exempt_issue_ids.map(normalizeIssueId)
    if (params.exempt_adjudications) {
      for (const adj of params.exempt_adjudications) adj.issue_id = normalizeIssueId(adj.issue_id)
    }
    if (params.recheck_adjudications) {
      for (const adj of params.recheck_adjudications) adj.issue_id = normalizeIssueId(adj.issue_id)
    }

    // 无效 fixed/exempt id 入口显式拒绝（不静默吞掉修复/豁免声明）：未命中的 id 抛错并列出可用 id 清单。
    // 以 resolveChildByIssueId 做权威判定，与 submitForStep 的 childById 及 collectFixedExemptLayers 消费端解析语义一致。
    const knownChildIds = new Set<string>()
    for (const c of item.children) {
      knownChildIds.add(c.id)
      if (c.externalId) knownChildIds.add(c.externalId)
    }
    const availableIssueIds = (): string => [...knownChildIds].sort().join(", ")
    for (const id of params.fixed_issue_ids ?? []) {
      if (!resolveChildByIssueId(item, id)) {
        throw new Error(`fixed_issue_ids 中包含无效 issue id: "${id}"。\n可用 issue ID: ${availableIssueIds()}`)
      }
    }
    for (const id of params.exempt_issue_ids ?? []) {
      const child = resolveChildByIssueId(item, id)
      if (!child) {
        throw new Error(`exempt_issue_ids 中包含无效 issue id: "${id}"。\n可用 issue ID: ${availableIssueIds()}`)
      }
      // Info 级 issue 不阻塞任何流程，豁免无意义且白耗一轮申报/裁定：developer 提交豁免申请的唯一入口在此拦截。
      // 存量的已带 exempt_request 标记的 Info issue 不受影响（adjudicateExempt 裁定路径不经过此处）。
      if (isInfoSeverity(child.severity)) {
        throw new Error(`豁免申请失败：issue "${child.id}" 为 Info 级 issue，不阻塞提交，无需申请豁免。`)
      }
    }
    for (const id of params.recheck_adjudications?.map((a) => a.issue_id) ?? []) {
      if (!resolveChildByIssueId(item, id)) {
        throw new Error(`recheck_adjudications 中包含无效 issue id: "${id}"。\n可用 issue ID: ${availableIssueIds()}`)
      }
    }

    // 重复提交守卫（仅 review step）：同 step 同 agent 已以 passed 通过后不允许重复提交；failed 允许重提
    // （回退重审期 failed tag 未被归因清空时须可重提，如 verify_task 仅 failed_tasks 驳回）。
    // 补交豁免：仅携带裁定类参数（recheck_adjudications / exempt_adjudications，无其他实质参数）的补交放行——
    // 上次提交漏带复核/豁免裁定导致本层 review 态 issue 阻塞门禁时（engine.blockedSupplementAgents 已推导
    // 应补交的报源 reviewer），reviewer 可补带裁定重提解除阻塞；空提交/携带其他实质参数（含 fixed_issue_ids /
    // exempt_issue_ids）的重复提交仍被拒绝。
    // 守卫在一切裁定（豁免/复核）之前执行，保证守卫拒绝时零副作用。step 归属按 stepMap 直接判定
    // （不依赖 assertSubmitRouting，保持越权 step 提交的裁定拦截语义不变）。
    const guardStepPhase = workflow.stepMap.get(params.step_id)?.phase.name
    if (
      guardStepPhase === "review" &&
      getStepVerdict(item, params.step_id, ctx.agent) === "passed" &&
      !isSupplementOnly(params)
    ) {
      throw new Error(`重复提交守卫：agent "${ctx.agent}" 已在 step "${params.step_id}" 以 passed 通过，不允许重复提交。`)
    }

    // 裁定一致性守卫（统一判定 exempt/recheck 驳回组合）：任一裁定参数含 rejected 且提交级 verdict=passed
    // 即抛错（驳回 issue 需修复，审查不能判定通过）。守卫在一切裁定（adjudicateExempt/adjudicateRecheck）写入
    // 与 submitForStep 应用 verdict 之前执行，拒绝时零副作用（含混合裁定清单）。
    assertRejectedAdjudicationNotPassed(params)

    // 先裁定豁免申请（越权/不可路由/跨维抛错）：submitForStep 尚未执行，保证越权裁定零副作用。
    for (const adj of params.exempt_adjudications ?? []) {
      const child = resolveChildByIssueId(item, adj.issue_id)
      if (!child) {
        throw new Error(`豁免裁定失败：issue "${adj.issue_id}" 不存在于 item "${item.id}" 的 children 中。`)
      }
      adjudicateExempt(item, workflow, { issueId: child.id, agentKey: ctx.agent, action: adj.action })
    }

    // 复核已修复待复核（review 态）issue：passed→done，rejected→todo + refix_count + reject_reason。
    // 谁提谁裁定，越权/非 review 态/缺驳回原因抛错零副作用，先于 submitForStep 执行使门禁按新 phase 判定。
    for (const adj of params.recheck_adjudications ?? []) {
      const child = resolveChildByIssueId(item, adj.issue_id)
      if (!child) {
        throw new Error(`复核失败：issue "${adj.issue_id}" 不存在于 item "${item.id}" 的 children 中。`)
      }
      adjudicateRecheck(item, workflow, {
        issueId: child.id,
        agentKey: ctx.agent,
        verdict: adj.verdict,
        rejectReason: adj.reject_reason,
      })
    }

    // 路由/归属校验前置（与 submitForStep 共用），越权/错 step 在参数处理前拦截。
    assertSubmitRouting(workflow, item, params.step_id, ctx.agent)
    const stepPhase = workflow.stepMap.get(params.step_id)!.phase.name

    if ((params.new_children?.length ?? 0) > 0 && stepPhase !== "review") {
      throw new Error(`仅 review 阶段的 step 允许提报新 issue（new_children），当前 step "${params.step_id}" 属于 "${stepPhase}" 阶段，拒绝提报。`)
    }

    // worktree 编辑边界强化（56ddfe9 意图）：review 提报的 issue 文件路径必须位于 worktree 内，路径逃逸拒绝。
    if (stepPhase === "review" && (params.new_children?.length ?? 0) > 0) {
      assertIssueFilesWithin(params.new_children as Array<{ file?: string }>, wtPath ?? ctx.worktree)
    }

    // new_children 空字段入口显式拒绝：空 id/title/description 会污染后续引用与去重 key，禁止入库。
    // dimension 提交语义按报源身份分类（校验在一切状态写入之前，抛错零副作用）：
    // - quality reviewer（agentToReviewDimension 命中）：维度由报源推断；显式填写须与报源维度一致，
    //   不一致抛错（等价推断不抛错）；未填写由 buildIssueChild 推断写入。
    // - tool/task reviewer：dimension 必填（归因维度），缺失或非法值抛错。
    const sourceDim = agentToReviewDimension(ctx.agent)
    for (const nc of params.new_children ?? []) {
      if (!nc.id || !nc.id.trim()) {
        throw new Error("new_children 中的 issue id 不能为空，请为每个新 issue 指定唯一 id。")
      }
      if (!nc.title || !nc.title.trim()) {
        throw new Error(`new_children 中 issue "${nc.id}" 的 title 不能为空。`)
      }
      if (!nc.description || !nc.description.trim()) {
        throw new Error(`new_children 中 issue "${nc.id}" 的 description 不能为空。`)
      }
      if (sourceDim) {
        if (nc.dimension !== undefined) {
          if (!(REVIEW_DIMENSIONS as readonly string[]).includes(nc.dimension)) {
            throw new Error(
              `new_children 中 issue "${nc.id}" 的 dimension 非法："${nc.dimension}"。合法维度：${REVIEW_DIMENSIONS.join(", ")}。`
            )
          }
          if (nc.dimension !== sourceDim) {
            throw new Error(
              `new_children 中 issue "${nc.id}" 显式声明的 dimension "${nc.dimension}" 与报源维度 "${sourceDim}" 不一致。quality reviewer 报 issue 的维度由报源推断，显式填写时必须与报源维度一致。`
            )
          }
        }
      } else {
        if (nc.dimension === undefined) {
          throw new Error(
            `new_children 中 issue "${nc.id}" 未声明归因维度 dimension。tool/task reviewer 报 issue 必须显式声明 dimension（归因维度），合法值：${REVIEW_DIMENSIONS.join(", ")}。`
          )
        }
        if (!(REVIEW_DIMENSIONS as readonly string[]).includes(nc.dimension)) {
          throw new Error(
            `new_children 中 issue "${nc.id}" 的 dimension 非法："${nc.dimension}"。合法维度：${REVIEW_DIMENSIONS.join(", ")}。`
          )
        }
      }
    }

    const newChildren = (params.new_children ?? []).map((nc) => buildIssueChild(nc, ctx.agent))

    if (stepPhase === "review") {
      handleReviewParams(item, params, newChildren, params.step_id)
    } else if (stepPhase === "todo") {
      handleAnalyzeParams(item, params)
    } else if (stepPhase === "in_progress") {
      handleImplementParams(item, params)
    }

    const { accepted } = dedupeNewChildren(item, newChildren)

    // verdict=failed 必须有具体不通过理由：理由判定在去重之后，仅依据实际接受的 new_children——
    // 重复新报（或与既有 child 同 key 被去重）不构成不通过理由，避免守卫放行但实际零新增 issue。
    if (stepPhase === "review" && params.verdict === "failed") {
      assertFailedHasReason(item, params, accepted, params.step_id, ctx.agent)
    }

    // dev 修复/豁免后按归因分层重置 review 验证标记（仅 implement step）
    if (stepPhase === "in_progress" && (params.fixed_issue_ids?.length || params.exempt_issue_ids?.length)) {
      resetReviewTagsOnFix(
        item,
        collectFixedExemptLayers(item, params.fixed_issue_ids ?? [], params.exempt_issue_ids ?? []),
      )
    }

    submitForStep(item, workflow, {
      stepId: params.step_id,
      agentKey: ctx.agent,
      verdict: params.verdict,
      fixedIds: params.fixed_issue_ids,
      exemptIds: params.exempt_issue_ids,
      newChildren: accepted,
    })

    // arch_submit 主仓库污染文档自动合并兜底（56ddfe9 意图）：analyze step（架构师）以 passed 提交后，
    // 若主仓库本 change 目录下存在未提交 openspec 文档污染，并入 worktree 分支并清理主仓库工作树。
    if (
      stepPhase === "todo" &&
      params.step_id === "analyze" &&
      params.verdict === "passed" &&
      wtPath &&
      typeof item.metadata["branch_name"] === "string"
    ) {
      const baseRef = typeof item.metadata["base_ref"] === "string" ? item.metadata["base_ref"] : null
      await reconcileMainPollution(ctx.worktree, wtPath, {
        changeId: state.changeId,
        baseRef,
      })
    }

    // G19：verify_task passed 且全部 task child 达终态（done）→ 同步 tasks.md 复选框 [ ] → [x]
    if (
      params.step_id === "verify_task" &&
      params.verdict === "passed" &&
      taskChildrenOf(item).every((c) => isTerminalPhase(c.phase))
    ) {
      const worktreePath =
        typeof item.metadata["worktree_path"] === "string" ? item.metadata["worktree_path"] : ctx.worktree
      await markTaskGroupCheckboxesComplete(worktreePath, params.change_id, state.taskGroupId)
    }

    await writeState(ctx.worktree, state)
    return SUBMIT_OK_MESSAGE
  } finally {
    releaseLock(lockPath)
  }
}

/**
 * 检查点决策应用：校验 item 处于检查点态（_checkpoint 标记或 retryCount 达上限且
 * 存在未终态 children）后，按决策应用引擎状态变更，并落盘 state。
 * 决策应用后不经过 submitForStep 提交路径。
 */
async function applyCheckpointDecision(
  params: AgentSubmitParams,
  item: WorkItem,
  workflow: LoadedWorkflow,
  ctx: ToolContext,
  state: OrchestrateState,
): Promise<string> {
  const decision = params.checkpoint_decision as "continue" | "giveup"
  const stepId = item.currentStep
  if (!stepId) throw new Error(`检查点决策失败：item "${item.id}" 无 currentStep，无法定位当前检查点 step。`)
  const entry = workflow.stepMap.get(stepId)
  if (!entry) throw new Error(`检查点决策失败：当前 step "${stepId}" 未在 workflow 中声明。`)
  const step = entry.step
  const atCheckpoint = item.metadata["_checkpoint"] === true || checkpointTriggered(item, workflow, step)
  if (!atCheckpoint) throw new Error(`检查点决策失败：当前不在检查点状态，无法执行 ${decision}。`)
  if (decision === "continue") {
    applyCheckpointContinue(item, step)
  } else {
    applyCheckpointGiveup(item, step)
  }
  await writeState(ctx.worktree, state)
  return renderCheckpointDecisionResult(decision, item, step)
}

/** 渲染检查点决策结果 markdown：决策已应用 + 后续动作。 */
function renderCheckpointDecisionResult(decision: "continue" | "giveup", item: WorkItem, step: StepConfig): string {
  if (decision === "continue") {
    return [
      "## ✅ 检查点决策已应用：continue",
      "",
      `- **step**: \`${step.id}\` 的 agent 裁决已重置为 pending，可重新提交该 step。`,
      `- **当前 phase**: ${item.phase}`,
      "",
    ].join("\n")
  }
  const cancelled = item.children.filter((c) => c.phase === "cancelled").map((c) => c.id)
  return [
    "## ✅ 检查点决策已应用：giveup",
    "",
    `- **step**: \`${step.id}\` 已标记 completed（所有 agent 视为 passed）。`,
    `- **未解决 children**（${cancelled.length} 个）已置 cancelled：${cancelled.join("、") || "(无)"}`,
    `- **当前 phase**: ${item.phase}`,
    "",
  ].join("\n")
}
