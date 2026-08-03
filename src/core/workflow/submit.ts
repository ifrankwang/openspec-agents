import type { WorkItem, WorkItemPhase, StepConfig, StepAdjudication } from "./types.js"
import type { LoadedWorkflow } from "./loader.js"
import { applyAgentVerdict, adjudicateStep, stepCanPass, applyTransition } from "./engine.js"
import { DIMENSION_AGENT_MAP } from "../constants.js"
import { REVIEW_DIMENSIONS } from "../types.js"
import type { Dimension } from "../types.js"

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
}

export interface ExemptRouteResult {
  routed: boolean
  targetStepId?: string
  reason?: string
}

export interface AdjudicationResult {
  issueId: string
  action: "dismissed" | "rejected"
  childPhase: WorkItemPhase
}

/** 读取 issue child 的报源 agent（metadata.source），缺省返回 undefined */
function readIssueSource(child: WorkItem): string | undefined {
  return typeof child.metadata["source"] === "string" ? child.metadata["source"] : undefined
}

/** 报源 agent 属于哪个 review step 的 agents 就由谁裁定（固定逻辑，非可配置），未命中返回 null */
function resolveReviewStepForSource(workflow: LoadedWorkflow, source: string): StepConfig | null {
  for (const phase of workflow.phases) {
    if (phase.name !== "review") continue
    for (const step of phase.steps) {
      if (step.agents.includes(source)) return step
    }
  }
  return null
}

/**
 * 提交路由与归属校验（submitForStep 与 agentSubmitExecute 共用）：
 * step 声明存在、agent 属于 step.agents、提交 step 与当前 step 一致，任一不满足即抛错且零状态变更。
 */
export function assertSubmitRouting(workflow: LoadedWorkflow, item: WorkItem, stepId: string, agentKey: string): StepConfig {
  const entry = workflow.stepMap.get(stepId)
  if (!entry) {
    throw new Error(`submit 路由失败：step "${stepId}" 未在 workflow "${workflow.id}" 中声明。`)
  }
  const step = entry.step
  if (!step.agents.includes(agentKey)) {
    throw new Error(`submit 越权：agent "${agentKey}" 不属于 step "${stepId}" 的 agents，拒绝提交且不产生任何状态变更。`)
  }
  if (item.currentStep !== null && item.currentStep !== stepId) {
    throw new Error(`submit 校验失败：item "${item.id}" 当前 step 为 "${item.currentStep}"，与提交的 step "${stepId}" 不一致，拒绝提交且不产生任何状态变更。`)
  }
  return step
}

/**
 * 通用提交入口：写 tag → children 更新 → 裁决与推进。
 * 路由/归属校验在一切状态变更之前完成，越权提交不产生任何副作用。
 */
export function submitForStep(item: WorkItem, workflow: LoadedWorkflow, input: SubmitInput): SubmitResult {
  const step = assertSubmitRouting(workflow, item, input.stepId, input.agentKey)

  applyAgentVerdict(item, input.stepId, input.agentKey, input.verdict)

  const childById = new Map<string, WorkItem>()
  for (const c of item.children) {
    childById.set(c.id, c)
    // 兼容外部以原始 issue id 引用 child（child.id 可能带 issue: 前缀，externalId 为原始 id）
    if (c.externalId) childById.set(c.externalId, c)
  }
  const updated = new Set<string>()

  for (const id of input.fixedIds ?? []) {
    const child = childById.get(id)
    if (child) {
      child.phase = "done"
      updated.add(id)
    }
  }

  for (const id of input.exemptIds ?? []) {
    const child = childById.get(id)
    if (child) {
      child.metadata[EXEMPT_REQUEST_KEY] = { requestedBy: input.agentKey }
      updated.add(id)
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
  let advanced = false
  let transitionTarget: string | undefined
  if (adjudication === "passed" && stepCanPass(item, step)) {
    const r = applyTransition(item, workflow, "pass")
    advanced = r.advanced
    if (r.advanced && r.target !== undefined) transitionTarget = r.target
  } else if (adjudication === "failed") {
    const r = applyTransition(item, workflow, "fail")
    advanced = r.advanced
    if (r.advanced && r.target !== undefined) transitionTarget = r.target
  }

  return {
    stepId: input.stepId,
    agentKey: input.agentKey,
    verdict: input.verdict,
    stepAdjudication: adjudication,
    advanced,
    transitionTarget,
    childrenUpdated: [...updated],
  }
}

/** 依据 issue 来源 agent 路由豁免申请到对应 review step */
export function routeExempt(item: WorkItem, workflow: LoadedWorkflow, issueId: string): ExemptRouteResult {
  const child = item.children.find((c) => c.id === issueId)
  if (!child) {
    return { routed: false, reason: `issue "${issueId}" 不存在于 item "${item.id}" 的 children 中。` }
  }
  const source = readIssueSource(child)
  if (!source) {
    return { routed: false, reason: `issue "${issueId}" 未声明 metadata.source（报 issue 的 agent），无法路由豁免。` }
  }
  const step = resolveReviewStepForSource(workflow, source)
  if (!step) {
    return {
      routed: false,
      reason: `来源 agent "${source}" 不属于任何 review step 的 agents，请 orchestrator 手动处理该豁免申请。`,
    }
  }
  return { routed: true, targetStepId: step.id }
}

/**
 * 裁定豁免申请：dismissed → cancelled；rejected → todo（清除 exempt_request 标记）。
 * 裁定者必须属于对应 review step 的 agents。
 */
export function adjudicateExempt(
  item: WorkItem,
  workflow: LoadedWorkflow,
  input: { issueId: string; agentKey: string; action: "dismissed" | "rejected" },
): AdjudicationResult {
  const child = item.children.find((c) => c.id === input.issueId)
  if (!child) {
    throw new Error(`豁免裁定失败：issue "${input.issueId}" 不存在于 item "${item.id}" 的 children 中。`)
  }
  const source = readIssueSource(child)
  const step = source ? resolveReviewStepForSource(workflow, source) : null
  if (!step) {
    throw new Error(`豁免裁定失败：issue "${input.issueId}" 无对应 review step（来源 agent "${source ?? "缺失"}" 不属于任何 review step 的 agents）。`)
  }
  // verify_quality 维度限定裁定：quality 层 issue 须由报 issue 的维度 reviewer 裁定（谁提谁裁定），
  // 避免 verify_quality 多 agent 共享 step 导致白名单放行全部 5 个 quality reviewer。
  const dimension = (REVIEW_DIMENSIONS as readonly string[]).includes(child.metadata["dimension"] as string)
    ? (child.metadata["dimension"] as Dimension)
    : undefined
  if (child.metadata["source_phase"] === "quality" && dimension) {
    const requiredAgent = DIMENSION_AGENT_MAP[dimension]
    if (input.agentKey !== requiredAgent) {
      throw new Error(
        `豁免裁定失败：issue "${input.issueId}" 属于质量维度 "${dimension}"，裁定者必须为报 issue 的 "${requiredAgent}"（谁提谁裁定），拒绝 "${input.agentKey}" 裁定。`
      )
    }
  } else {
    const whitelist = new Set<string>(step.agents)
    if (!whitelist.has(input.agentKey)) {
      throw new Error(`豁免裁定失败：agent "${input.agentKey}" 不在 review step "${step.id}" 的裁定白名单（agents）内。`)
    }
  }

  if (input.action === "dismissed") {
    child.phase = "cancelled"
  } else {
    child.phase = "todo"
    delete child.metadata[EXEMPT_REQUEST_KEY]
  }
  return { issueId: input.issueId, action: input.action, childPhase: child.phase }
}
