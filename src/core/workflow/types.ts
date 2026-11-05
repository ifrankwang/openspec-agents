import { SEVERITY_LEVELS, BLOCKING_SEVERITIES } from "../constants.ts"
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

/** 豁免申请标记键（非内部下划线前缀，属于业务语义字段）。定义在本模块使 engine 与 submit 均可
 *  免循环引用（submit 依赖 engine，engine 依赖本模块，不产生新环）。 */
export const EXEMPT_REQUEST_KEY = "exempt_request"

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

export interface StepAgent {
  id: string
  capability_tags: string[]
}

/**
 * step 必做清单（按项目形态栈分组）：always 对所有会话生效；其余键为栈名（值域来自 skill frontmatter
 * 声明的 stacks 并集，见 knownStacks()），仅当会话 project_stacks 命中该键时并入生效清单。
 * always 可声明为空数组（该 step 无通用必做项），缺省视同空。
 */
export interface StepMustDoGroups {
  always?: string[]
  [stack: string]: string[] | undefined
}

export interface StepConfig {
  id: string
  agents: StepAgent[]
  always_run?: boolean
  max_retries?: number
  instructions?: string[]
  constraints?: string[]
  /** 本 step 的必做清单分组（缺省 = 该 step 无必做清单，不设门禁）。 */
  must_do?: StepMustDoGroups
  transitions: StepTransitions
}

/** 词表条目：item id 的一句话要求与该填什么证据（证据口径的单一事实源）。 */
export interface MustDoCatalogItem {
  description: string
  evidence: string
}

/** must-do 词表：item id → 条目（workflow step 只能引用表内 id）。 */
export type MustDoCatalog = Record<string, MustDoCatalogItem>

/** step.agents 的 id 投影：状态机/视图消费点统一从对象数组归一化为 id 字符串数组。 */
export function stepAgentIds(step: { agents: StepAgent[] }): string[] {
  return step.agents.map((a) => a.id)
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
  /** must-do 词表（item id → 要求与证据口径），每份 workflow 加载后同一份实例。 */
  mustDoCatalog: MustDoCatalog
}

export type StepAdjudication = "passed" | "failed" | "pending"
