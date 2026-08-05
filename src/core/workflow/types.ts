export const WORK_ITEM_PHASES = ["todo", "in_progress", "review", "done", "cancelled"] as const
export type WorkItemPhase = typeof WORK_ITEM_PHASES[number]

export const WORK_ITEM_TYPES = ["task", "issue"] as const
export type WorkItemType = typeof WORK_ITEM_TYPES[number]

export const VERDICTS = ["pending", "passed", "failed"] as const
export type Verdict = typeof VERDICTS[number]

export const SEVERITY_LEVELS = ["Critical", "High", "Medium", "Low", "Info"] as const
export type Severity = typeof SEVERITY_LEVELS[number]

export const BLOCKING_SEVERITIES = ["Critical", "High", "Medium", "Low"] as const

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
  allowed_tools?: string[]
  timeout_ms?: number
  max_retries?: number
  transitions: StepTransitions
}

export interface PhaseConfig {
  name: WorkItemPhase
  steps: StepConfig[]
}

export interface WorkflowConfig {
  id: string
  name?: string
  max_retries: number
  phases: PhaseConfig[]
}

export type StepAdjudication = "passed" | "failed" | "pending"
