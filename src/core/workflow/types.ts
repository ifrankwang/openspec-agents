import { SEVERITY_LEVELS, BLOCKING_SEVERITIES } from "../constants.js"
export { SEVERITY_LEVELS, BLOCKING_SEVERITIES }

export const WORK_ITEM_PHASES = ["todo", "in_progress", "review", "done", "cancelled"] as const
export type WorkItemPhase = typeof WORK_ITEM_PHASES[number]

export const WORK_ITEM_TYPES = ["task", "issue"] as const
export type WorkItemType = typeof WORK_ITEM_TYPES[number]

export const VERDICTS = ["pending", "passed", "failed"] as const
export type Verdict = typeof VERDICTS[number]

export type Severity = typeof SEVERITY_LEVELS[number]

export interface WorkItemWriteback {
  lastAttempt?: string
  lastSuccess?: string
  error?: string
}

export interface WorkItem {
  id: string
  source: string
  externalId?: string
  type: WorkItemType
  title: string
  description: string
  phase: WorkItemPhase
  suspended: boolean
  currentStep: string | null
  tags: Record<string, Verdict>
  metadata: Record<string, unknown>
  children: WorkItem[]
  labels: string[]
  severity?: Severity
  writeback?: WorkItemWriteback
}

export const INTERNAL_METADATA_PREFIX = "_"

export function isInternalMetadataKey(key: string): boolean {
  return key.startsWith(INTERNAL_METADATA_PREFIX)
}

export function tagKey(stepId: string, agentKey: string): string {
  return `${stepId}:${agentKey}`
}

export interface StepTransitions {
  on_pass: string | "done" | "halt"
  on_fail: string | "done" | "halt"
}

export interface StepConfig {
  id: string
  agents: string[]
  always_run?: boolean
  capability_tags?: string[]
  max_retries?: number
  instructions?: string[]
  constraints?: string[]
  transitions: StepTransitions
}

export interface PhaseConfig {
  name: WorkItemPhase
  steps: StepConfig[]
}

/** 跨所有 step 共享的通用指引/约束（step 自动继承，渲染时合并进对应视图区块），缺省 undefined。 */
export interface WorkflowCommon {
  /** 通用操作指引（所有 step 的操作指引均前置追加）。 */
  instructions?: string[]
  /** 通用约束（所有 step 的约束区块均前置追加）。 */
  constraints?: string[]
}

export interface WorkflowConfig {
  id: string
  name?: string
  max_retries: number
  phases: PhaseConfig[]
  /** 跨 step 共享的通用语义（step 自动继承），缺省 undefined。 */
  common?: WorkflowCommon
}

export type StepAdjudication = "passed" | "failed" | "pending"
