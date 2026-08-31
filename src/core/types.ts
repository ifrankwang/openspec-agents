import type { WorkItem } from "./workflow/types.ts"

export const CODE_DIMENSIONS = ["style", "architecture", "performance", "security", "maintainability"] as const
export const REVIEW_DIMENSIONS = [...CODE_DIMENSIONS] as const
export type ReviewDimension = typeof REVIEW_DIMENSIONS[number]
export type Dimension = ReviewDimension

export const TASK_STATUSES = ["open", "submitted", "rejected", "verified"] as const
export type TaskStatus = typeof TASK_STATUSES[number]
export const ISSUE_STATUSES = ["open", "submitted", "rejected", "verified", "exemption_requested", "exempted"] as const
export type IssueStatus = typeof ISSUE_STATUSES[number]

export type Phase = "task_analysis" | "dev_impl" | "review" | "completed"

/** 恢复（recovery）可恢复的阶段合法值，与 InitParams.recovery.phase 值域一致。 */
export const BUILD_PHASE_TARGETS = ["task_analysis", "dev_impl", "review"] as const
export type BuildPhaseTarget = typeof BUILD_PHASE_TARGETS[number]

/** review 内子层合法值（review_layer / issue 报源层共用同一三元组）。 */
export const REVIEW_LAYERS = ["tool", "task", "quality"] as const
export type ReviewLayer = typeof REVIEW_LAYERS[number]

/** review 三个验证 step 合法值（recovery.reset_steps 在 full 模式的值域）。 */
export const REVIEW_VERIFY_STEPS = ["verify_tool", "verify_task", "verify_quality"] as const
export type ReviewVerifyStep = typeof REVIEW_VERIFY_STEPS[number]

/** simple 模式 review 合并审查 step 合法值（recovery.reset_steps 在 simple 模式的值域）。 */
export const SIMPLE_REVIEW_STEPS = ["quality_review"] as const
export type SimpleReviewStep = typeof SIMPLE_REVIEW_STEPS[number]
export type OrchestrateStatus = "not_started" | "in_progress" | "completed"
export type DimensionVerdict = "pending" | "passed" | "failed"
export type QualityLayerProgress = Record<ReviewDimension, DimensionVerdict>

/** 流程模式：full（默认，analyze → implement → 三重审查+收尾验证）或 simple（implement → quality_review → done）。 */
export type WorkflowMode = "full" | "simple"

/** 独立审查会话的审查范围类型：pr=按 base..head 分支区间审查，full=全量代码库审查。 */
export type ReviewScopeType = "pr" | "full"
/** 独立审查颗粒度：thorough=三层审查（verify_tool → verify_task → verify_quality），simple=单层合并审查（quality_review）。 */
export type ReviewGranularity = "simple" | "thorough"
/** 独立审查修复策略：none=只审不修（issue 报告即交付物），fix=审并修（失败回 implement 修复闭环）。 */
export type ReviewFixPolicy = "none" | "fix"

/** 独立审查会话的审查范围（opx_orch_init 的 review_scope 参数固化，不绑定 OpenSpec change）。 */
export interface ReviewScope {
  scopeType: ReviewScopeType
  /** pr 形态的基准本地分支（init 推导后固化；full 形态缺省）。 */
  baseRef?: string
  /** pr 形态的头部本地分支（审查目标分支；full 形态缺省）。 */
  headRef?: string
  granularity: ReviewGranularity
  fix: ReviewFixPolicy
}

/** 独立审查会话的固定虚拟任务组 id（workItem id 为 task:review，无 tasks.md / task children）。 */
export const REVIEW_TASK_GROUP_ID = "review"

export interface ExecutionBoundary {
  allowed_directories: string[]
  allowed_packages: string[]
  notes: string
}

export interface TaskItem {
  id: string
  specTrace: string
  title: string
  status: TaskStatus
  taskNumber: string
  rejectReason: string | null
}

export interface IssueItem {
  id: string
  dimension: Dimension
  sourcePhase: ReviewLayer
  severity: string
  file: string
  line: number
  description: string
  suggestion: string
  status: IssueStatus
  refixCount: number
  rootCauseGuess: string | null
  exemptReason: string | null
  rejectReason: string | null
  rule?: string   // 工具规则名（如 PMD Rule / SonarQube rule），非工具来源可为空
}

export type BlockerStatus = "awaiting_user" | "resolved"

export interface BlockerItem {
  id: string
  sourceRole: string
  taskId: string | null
  category: string
  description: string
  evidence: string
  attemptedActions: string
  options: string[]
  status: BlockerStatus
  userResponse: string | null
  architectConclusion: string | null
}

export interface ValidationStep {
  step: string
  completed: boolean
  evidence: string
  skip_reason: string | null
}

export interface ReviewLayerData {
  completed: boolean
  testResults?: string
  validationSteps?: ValidationStep[]
}

export interface ReviewPhaseData {
  retryCount: number
  lastResolvedRetryCount: number
  tool: ReviewLayerData
  task: ReviewLayerData
  quality: { progress: QualityLayerProgress }
}

export interface SimplePhaseData {
  completed: boolean
}

export interface Phases {
  architect_review: SimplePhaseData
  review: ReviewPhaseData
}

export interface TaskGroupState {
  id: string
  name: string
  taskCount: number
  worktreePath: string | null
  branchName: string | null
  baseRef: string | null
  executionBoundary: ExecutionBoundary | null
  relevantSpecs: string[]
  devSelfCheckResults?: string
  status: Phase
  phases: Phases
  tasks: TaskItem[]
  issues: IssueItem[]
  blockers: BlockerItem[]
  agentSummaries?: Record<string, string>   // agent 名 → 最近一次提交摘要（单值覆盖）
}

export interface OrchestrateState {
  changeId: string
  isolationNamespace: string
  taskGroupId: string
  baseBranch: string
  workItems: WorkItem[]   // 工作流引擎原生持久化（单轨事实源）
  createdAt: string
  updatedAt: string
  unattended?: boolean
  /** 变更开始时固化的流程模式（经 opx_orch_init 的 mode 参数写入，缺省 simple）。
   *  缺失即旧变更，一律按 full 处理（读时兜底，不写回）；已存在的 state 仅在 init 允许窗口
   *  （切组且其他任务组均已完成或从未激活，或 recovery.phase=task_analysis 重制当前组）内
   *  可被 mode 参数更新。 */
  mode?: WorkflowMode
  /** 会话形态：review=独立审查会话（不绑定 OpenSpec change，无 tasks.md 解析 / mode 字段）；
   *  缺省视为 change 会话（读时兜底，不写回旧 state）。workflow 选择按 kind 优先于 mode。 */
  kind?: "review"
  /** kind=review 时的审查范围（granularity 决定 workflow 文件、fix 决定 fail 方向转移策略）。 */
  reviewScope?: ReviewScope
}
