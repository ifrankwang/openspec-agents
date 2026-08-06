import type { BuildPhaseTarget, ReviewLayer } from "../types.js"

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
    phase: BuildPhaseTarget
    review_layer?: ReviewLayer
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

export interface AgentSubmitParams {
  change_id: string
  step_id: string
  verdict: "passed" | "failed"
  fixed_issue_ids?: string[]
  exempt_issue_ids?: string[]
  exempt_adjudications?: Array<{
    issue_id: string
    action: "dismissed" | "rejected"
  }>
  recheck_adjudications?: Array<{
    issue_id: string
    verdict: "passed" | "rejected"
    reject_reason?: string
  }>
  checkpoint_decision?: "continue" | "giveup"
  new_children?: Array<{
    id: string
    title: string
    description: string
    severity?: string
    dimension?: string
    file?: string
    line?: number
    suggestion?: string
    rule?: string
    root_cause_guess?: string
  }>
  execution_boundary?: {
    allowed_directories: string[]
    allowed_packages: string[]
    notes: string
  }
  blockers?: Array<{
    source_role: string
    task_id?: string
    category: string
    description: string
    evidence: string
    attempted_actions: string
    options?: string[]
  }>
  blocker_updates?: Array<{
    blocker_id: string
    user_response: string
  }>
  blocker?: {
    source_role: string
    task_id?: string
    category: string
    description: string
    evidence: string
    attempted_actions: string
    options?: string[]
  }
  self_check_results?: string
  completed_task_ids?: string[]
  test_results?: string
  validation_steps?: Array<{
    step: string
    completed: boolean
    evidence?: string
    skip_reason?: string
  }>
  boundary_expansion?: {
    allowed_directories?: string[]
    allowed_packages?: string[]
  }
  verified_tasks?: string[]
  failed_tasks?: Array<{
    task_id: string
    reason: string
  }>
}
