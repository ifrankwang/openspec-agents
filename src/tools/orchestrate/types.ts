export const CODE_DIMENSIONS = ["style", "architecture", "performance", "security", "maintainability"] as const
export const REVIEW_DIMENSIONS = [...CODE_DIMENSIONS] as const
export type ReviewDimension = typeof REVIEW_DIMENSIONS[number]
export type Dimension = ReviewDimension

export const TASK_STATUSES = ["open", "submitted", "rejected", "verified"] as const
export type TaskStatus = typeof TASK_STATUSES[number]
export const ISSUE_STATUSES = ["open", "submitted", "rejected", "verified", "exemption_requested", "exempted"] as const
export type IssueStatus = typeof ISSUE_STATUSES[number]

export type Phase = "task_analysis" | "dev_impl" | "review" | "completed"
export type BuildPhaseTarget = "task_analysis" | "dev_impl" | "review"
export type OrchestrateStatus = "not_started" | "in_progress" | "completed"
export type DimensionVerdict = "pending" | "passed" | "failed"
export type QualityLayerProgress = Record<ReviewDimension, DimensionVerdict>

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
  sourcePhase: "tool" | "task" | "quality"
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
  lastFilesChanged: string[]
  devSelfCheckResults?: string
  status: Phase
  phases: Phases
  tasks: TaskItem[]
  issues: IssueItem[]
  blockers: BlockerItem[]
}

export interface OrchestrateState {
  changeId: string
  taskGroupId: string
  baseBranch: string
  taskGroups: TaskGroupState[]
  createdAt: string
  updatedAt: string
  unattended?: boolean
}
