export interface ToolContext {
  worktree: string
  agent: string
  remote?: boolean
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface InitParams {
  change_id: string
  task_group_id: string
  base_branch?: string
  recovery?: {
    phase: string
    review_layer?: "tool" | "task" | "quality"
    reopenIssues?: boolean
  }
}

export interface SetWorktreeParams {
  change_id: string
  worktree_path?: string
  branch_name?: string
}

export interface UnattendedParams {
  change_id: string
  enabled: boolean
}

export interface ArchSubmitParams {
  change_id: string
  outcome: "ready"
  execution_boundary: {
    allowed_directories: string[]
    allowed_packages: string[]
    notes: string
  }
}

export interface ArchBlockerParams {
  change_id: string
  blocker_id?: string
  blockers?: Array<{
    source_role: string
    task_id?: string
    category: string
    description: string
    evidence: string
    attempted_actions: string
    options?: string[]
  }>
  user_response?: string
}

export interface DevSubmitParams {
  change_id: string
  outcome?: "completed" | "blocked"
  completed_task_ids?: string[]
  self_check_results?: string
  blocker?: {
    source_role: string
    task_id?: string
    category: string
    description: string
    evidence: string
    attempted_actions: string
    options?: string[]
  }
  fixed_issue_ids?: string[]
  request_exempts?: Array<{ issue_id: string; reason: string }>
}

export interface ToolReviewParams {
  change_id: string
  passed: boolean
  issues?: Array<{
    dimension: string
    severity: string
    file: string
    line: number
    description: string
    suggestion?: string
    rule?: string
  }>
  fixed_issue_ids?: string[]
  exempt_issue_ids?: string[]
  rejected_issue_ids?: Array<{ issue_id: string; reason: string }>
  test_results?: string
  boundary_expansion?: {
    allowed_directories?: string[]
    allowed_packages?: string[]
  }
}

export interface TaskReviewParams {
  change_id: string
  passed: boolean
  verified_task_ids?: string[]
  failed_task_ids?: Array<{ task_id: string; reason: string }>
  issues?: Array<{
    severity: string
    file: string
    line: number
    description: string
    suggestion?: string
    root_cause_guess?: string
    rule?: string
  }>
  fixed_issue_ids?: string[]
  exempt_issue_ids?: string[]
  rejected_issue_ids?: Array<{ issue_id: string; reason: string }>
  boundary_expansion?: {
    allowed_directories?: string[]
    allowed_packages?: string[]
  }
  validation_steps?: Array<{
    step: string
    completed: boolean
    evidence?: string
    skip_reason?: string
  }>
}

export interface QualityReviewParams {
  change_id: string
  passed: boolean
  issues?: Array<{
    severity: string
    file: string
    line: number
    description: string
    suggestion?: string
    root_cause_guess?: string
    rule?: string
  }>
  fixed_issue_ids?: string[]
  exempt_issue_ids?: string[]
  rejected_issue_ids?: Array<{ issue_id: string; reason: string }>
  boundary_expansion?: {
    allowed_directories?: string[]
    allowed_packages?: string[]
  }
}

export interface ResolveReviewParams {
  change_id: string
  decision: "continue" | "giveup"
}
