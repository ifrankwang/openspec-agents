import type { WorkItem, WorkItemPhase, StepConfig, StepAdjudication } from "./types.js"
import { stepAgentIds } from "./types.js"
import type { LoadedWorkflow } from "./loader.js"
import { applyAgentVerdict, adjudicateStep, stepCanPass, applyTransition, getStepVerdict, isTerminalPhase } from "./engine.js"
import { issueChildrenOf, taskChildrenOf } from "../task-children.js"
import { readIssueSource } from "../constants.js"

/** 豁免申请标记键（非内部下划线前缀，属于业务语义字段） */
export const EXEMPT_REQUEST_KEY = "exempt_request"

export interface SubmitInput {
  stepId: string
  agentKey: string
  verdict: "passed" | "failed"
  fixedIds?: string[]
  exemptIds?: string[]
  newChildren?: WorkItem[]
}

export interface SubmitResult {
  stepId: string
  agentKey: string
  verdict: "passed" | "failed"
  stepAdjudication: StepAdjudication
  advanced: boolean
  transitionTarget?: string
  childrenUpdated: string[]
  /** 推进失败（applyTransition 拦截）的原因；推进成功时不返回。 */
  reason?: string
}

export interface AdjudicationResult {
  issueId: string
  action: "dismissed" | "rejected"
  childPhase: WorkItemPhase
}

/** 报源 agent 属于哪个 review step 的 agents 就由谁裁定（固定逻辑，非可配置），未命中返回 null */
function resolveReviewStepForSource(workflow: LoadedWorkflow, source: string): StepConfig | null {
  for (const phase of workflow.phases) {
    if (phase.name !== "review") continue
    for (const step of phase.steps) {
      if (stepAgentIds(step).includes(source)) return step
    }
  }
  return null
}

/**
 * 校验 issue 裁定者权限（谁提谁裁定）：裁定者恒为报 issue 的 agent（child.metadata.source），
 * 供豁免裁定（adjudicateExempt）与复核（adjudicateRecheck）复用：
 * - 报源缺失或不属于任何 review step 的 agents（非合法 review agent）→ 抛错（畸形数据拒绝，零副作用）；
 * - 裁定者 ≠ 报源 → 抛错（tool/task/quality 一律按报源收敛，无 step 白名单）；
 * 校验在一切状态写入之前执行，越权抛错不产生状态变更。返回报源对应 review step 供调用方使用。
 */
function resolveAdjudicatorStepForIssue(
  workflow: LoadedWorkflow,
  child: WorkItem,
  agentKey: string,
  role: "裁定" | "复核",
): StepConfig {
  const prefix = role === "裁定" ? "豁免裁定失败" : "复核失败"
  const source = readIssueSource(child)
  const step = source ? resolveReviewStepForSource(workflow, source) : null
  if (!step) {
    throw new Error(
      `${prefix}：issue "${child.id}" 的报源 "${source ?? "缺失"}" 不是合法 review agent（不属于任何 review step 的 agents），无法确定裁定者。`
    )
  }
  if (agentKey !== source) {
    throw new Error(
      `${prefix}：issue "${child.id}" 由报源 "${source}" 裁定（谁提谁裁定），${role}者必须为 "${source}"，拒绝 "${agentKey}" ${role}。`
    )
  }
  return step
}

/**
 * 提交路由与归属校验（submitForStep 与 agentSubmitExecute 共用）：
 * step 声明存在、agent 属于 step.agents、提交 step 与当前 step 一致、step 归属 phase 与 item.phase 一致，
 * 任一不满足即抛错且零状态变更。
 */
export function assertSubmitRouting(workflow: LoadedWorkflow, item: WorkItem, stepId: string, agentKey: string): StepConfig {
  const entry = workflow.stepMap.get(stepId)
  if (!entry) {
    throw new Error(`submit 路由失败：step "${stepId}" 未在 workflow "${workflow.id}" 中声明。`)
  }
  const step = entry.step
  if (!stepAgentIds(step).includes(agentKey)) {
    throw new Error(`submit 越权：agent "${agentKey}" 不属于 step "${stepId}" 的 agents，拒绝提交且不产生任何状态变更。`)
  }
  if (item.currentStep !== null && item.currentStep !== stepId) {
    throw new Error(`submit 校验失败：item "${item.id}" 当前 step 为 "${item.currentStep}"，与提交的 step "${stepId}" 不一致，拒绝提交且不产生任何状态变更。`)
  }
  // phase↔step 归属校验：currentStep 为 null（todo 初始态 / 终态）显式跳过，错位态拒绝提交零状态变更。
  if (item.currentStep !== null && entry.phase.name !== item.phase) {
    throw new Error(`submit 校验失败：item "${item.id}" 的 phase "${item.phase}" 与 step "${stepId}" 归属阶段 "${entry.phase.name}" 不一致（phase ↔ step 错位），拒绝提交且不产生任何状态变更。`)
  }
  return step
}

/**
 * 链式推进：submitForStep 的 applyTransition(pass) 成功后，若新 step 已全 passed 且
 * stepCanPass 满足，继续沿 on_pass 穿越（等价 main 的 task 自动跳过语义），
 * 一次提交可带过多个已通过的 step。循环在每一步重算 adjudicateStep 与 stepCanPass，
 * 停在需要 agent 动作的 step（pending/failed 裁决）或终态（done/halt）。
 * 返回最终落点 target（"done"/"halt"/step id），无推进则返回 initialTarget。
 * 有限性：每轮推进都改变 currentStep（终态置 null）且 on_pass 构成无环 DAG，
 * 另加 stepMap 规模上限防护，不可能无限循环。
 */
function chainPassAdvance(item: WorkItem, workflow: LoadedWorkflow, initialTarget: string | undefined): string | undefined {
  let target = initialTarget
  const maxIterations = workflow.stepMap.size * 2 + 1
  for (let i = 0; i < maxIterations; i++) {
    if (item.suspended || isTerminalPhase(item.phase) || item.currentStep === null) break
    const entry = workflow.stepMap.get(item.currentStep)
    if (!entry) break
    const step = entry.step
    if (step.always_run) break
    if (adjudicateStep(item, step) !== "passed") break
    if (!stepCanPass(item, step)) break
    const r = applyTransition(item, workflow, "pass")
    if (!r.advanced) break
    if (r.target !== undefined) target = r.target
  }
  return target
}

/**
 * 通用提交入口：写 tag → children 更新 → 裁决与推进。
 * 路由/归属校验在一切状态变更之前完成，越权提交不产生任何副作用。
 */
export function submitForStep(item: WorkItem, workflow: LoadedWorkflow, input: SubmitInput): SubmitResult {
  const step = assertSubmitRouting(workflow, item, input.stepId, input.agentKey)

  const childById = new Map<string, WorkItem>()
  // issue children 优先入 map：fixed/exempt 解析须优先命中 issue child。
  // task child 短数字 id（"1"）可能与 issue 的 externalId 撞车，且数组序不保证 issue 在前（reopen/recovery 重排）。
  for (const c of issueChildrenOf(item)) {
    childById.set(c.id, c)
    // 兼容外部以原始 issue id 引用 child（child.id 可能带 issue: 前缀，externalId 为原始 id）
    if (c.externalId) childById.set(c.externalId, c)
  }
  // task children 后入且撞车跳过：仅登记未被 issue child 占用的键，保证 issue 优先语义不被打乱
  for (const c of taskChildrenOf(item)) {
    if (!childById.has(c.id)) childById.set(c.id, c)
    if (c.externalId && !childById.has(c.externalId)) childById.set(c.externalId, c)
  }

  // 终态 issue 豁免守卫：done/cancelled 已终态的 issue 不允许重新申请豁免（防止已 cancelled 的 issue
  // 被重复申请豁免、rejected 复活已豁免 issue）。校验在一切状态写入（applyAgentVerdict）之前，抛错零副作用。
  for (const id of input.exemptIds ?? []) {
    const child = childById.get(id)
    if (child && isTerminalPhase(child.phase)) {
      throw new Error(
        `豁免申请失败：issue "${child.id}" 当前 phase 为 "${child.phase}"（终态），不允许对已终态的 issue 重新申请豁免。`
      )
    }
  }

  applyAgentVerdict(item, input.stepId, input.agentKey, input.verdict)

  const updated = new Set<string>()

  for (const id of input.fixedIds ?? []) {
    const child = childById.get(id)
    if (child) {
      // issue child 修复后进入 review（待对应 reviewer 复核），终态由复核裁定；
      // task child 维持 done 语义（子任务完成态由 verify_task 验证路径处理，不进入复核）。
      child.phase = child.type === "task" ? "done" : "review"
      // 记录 canonical child.id（task child 短数字 id 可能与 issue externalId 撞车，
      // 原始引用 id 渲染时歧义，统一用 child.id 回指）
      updated.add(child.id)
    }
  }

  for (const id of input.exemptIds ?? []) {
    const child = childById.get(id)
    if (child) {
      child.metadata[EXEMPT_REQUEST_KEY] = { requestedBy: input.agentKey }
      updated.add(child.id)
    }
  }

  for (const nc of input.newChildren ?? []) {
    if (!childById.has(nc.id)) {
      item.children.push(nc)
      childById.set(nc.id, nc)
      updated.add(nc.id)
    }
  }

  const adjudication = adjudicateStep(item, step)
  // 多 agent step（verify_quality 5 维并行）聚合判定：须全部 agent 非 pending 才允许触发迁移。
  // passed 天然意味着全提交；failed 须等最后一维提交后才回退，避免单维失败过早回退阻断其余维度提交。
  const allAdjudicated = step.agents.every((a) => getStepVerdict(item, step.id, a.id) !== "pending")
  let advanced = false
  let transitionTarget: string | undefined
  let advanceBlockReason: string | undefined
  if (adjudication === "passed" && stepCanPass(item, step)) {
    const r = applyTransition(item, workflow, "pass")
    advanced = r.advanced
    if (r.advanced) {
      // 成功推进后清理历史阻塞原因，避免状态视图展示过期信息
      delete item.metadata["_advance_block_reason"]
      // 链式推进：迁移后若新 step 已全 passed 且 stepCanPass 满足，继续沿 on_pass 穿越
      // （等价 main 的 task 自动跳过语义），一次提交可带过多个已通过的 step，
      // 停在需要 agent 动作的 step 或终态（done/halt）。
      transitionTarget = chainPassAdvance(item, workflow, r.target)
    } else {
      // 推进被跨 phase 门禁/done 终态检查拦截：把原因写入 item 状态供 opx_status 展示，并随结果返回
      advanceBlockReason = r.reason
      item.metadata["_advance_block_reason"] = r.reason
    }
  } else if (adjudication === "failed" && allAdjudicated) {
    const r = applyTransition(item, workflow, "fail")
    advanced = r.advanced
    if (r.advanced) {
      delete item.metadata["_advance_block_reason"]
      if (r.target !== undefined) transitionTarget = r.target
    } else {
      advanceBlockReason = r.reason
      item.metadata["_advance_block_reason"] = r.reason
    }
  }

  return {
    stepId: input.stepId,
    agentKey: input.agentKey,
    verdict: input.verdict,
    stepAdjudication: adjudication,
    advanced,
    transitionTarget,
    childrenUpdated: [...updated],
    reason: advanceBlockReason,
  }
}

/**
 * 裁定豁免申请：dismissed → cancelled；rejected → todo；两种结果均清除 exempt_request 标记。
 * 仅带 exempt_request 标记（已申请豁免）的 issue 可被裁定；裁定者必须属于对应 review step 的 agents。
 */
export function adjudicateExempt(
  item: WorkItem,
  workflow: LoadedWorkflow,
  input: { issueId: string; agentKey: string; action: "dismissed" | "rejected" },
): AdjudicationResult {
  const child =
    issueChildrenOf(item).find((c) => c.id === input.issueId) ??
    taskChildrenOf(item).find((c) => c.id === input.issueId)
  if (!child) {
    throw new Error(`豁免裁定失败：issue "${input.issueId}" 不存在于 item "${item.id}" 的 children 中。`)
  }
  if (child.metadata[EXEMPT_REQUEST_KEY] === undefined) {
    throw new Error(
      `豁免裁定失败：issue "${input.issueId}" 未申请豁免（无 exempt_request 标记），仅可裁定带豁免申请标记的 issue。`
    )
  }
  // 谁提谁裁定：解析报源 review step 并校验裁定者权限（与复核同源，复用公共裁定权校验）。
  resolveAdjudicatorStepForIssue(workflow, child, input.agentKey, "裁定")

  if (input.action === "dismissed") {
    child.phase = "cancelled"
  } else {
    child.phase = "todo"
  }
  delete child.metadata[EXEMPT_REQUEST_KEY]
  return { issueId: input.issueId, action: input.action, childPhase: child.phase }
}

export interface RecheckAdjudicationResult {
  issueId: string
  verdict: "passed" | "rejected"
  childPhase: WorkItemPhase
}

/**
 * 复核已修复（review 态）issue：verdict=passed → done；verdict=rejected → 回 todo 并
 * 递增 metadata.refix_count、写入 metadata.reject_reason（给 dev 驳回原因）。
 * 仅 review 态 issue 可复核；裁定者必须为报 issue 的对应 review step（谁提谁裁定，与豁免裁定同源归因）。
 * 越权/非法状态抛错，不产生任何状态变更。
 */
export function adjudicateRecheck(
  item: WorkItem,
  workflow: LoadedWorkflow,
  input: { issueId: string; agentKey: string; verdict: "passed" | "rejected"; rejectReason?: string },
): RecheckAdjudicationResult {
  const child = issueChildrenOf(item).find((c) => c.id === input.issueId)
  if (!child) {
    throw new Error(`复核失败：issue "${input.issueId}" 不存在于 item "${item.id}" 的 issue children 中。`)
  }
  if (child.phase !== "review") {
    throw new Error(
      `复核失败：issue "${input.issueId}" 当前 phase 为 "${child.phase}"，仅 review 态（已修复待复核）issue 可复核。`
    )
  }
  // 谁提谁裁定：解析报源 review step 并校验复核者权限（与豁免裁定同源，复用公共裁定权校验）。
  resolveAdjudicatorStepForIssue(workflow, child, input.agentKey, "复核")

  if (input.verdict === "passed") {
    child.phase = "done"
    delete child.metadata["reject_reason"]
  } else {
    if (!input.rejectReason) {
      throw new Error(`复核失败：issue "${input.issueId}" 驳回（verdict=rejected）必须提供 reject_reason。`)
    }
    child.phase = "todo"
    child.metadata["refix_count"] = (typeof child.metadata["refix_count"] === "number" ? child.metadata["refix_count"] : 0) + 1
    child.metadata["reject_reason"] = input.rejectReason
  }
  return { issueId: input.issueId, verdict: input.verdict, childPhase: child.phase }
}
