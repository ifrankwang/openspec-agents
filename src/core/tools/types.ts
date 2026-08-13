import type { BuildPhaseTarget, ReviewLayer, ReviewVerifyStep } from "../types.ts"

export interface ToolContext {
  worktree: string
  agent: string
  /** 编排视角角色判定：true 表示调用者承担编排者职责（各 agent 主代理），替代 agent 名硬编码 openspec-orchestrator。 */
  orchestrator?: boolean
  /** 调用者 agent 身份是否显式声明：MCP 形态下为是否携带 `_agent` 参数，OpenCode 直载形态恒为 true。
   *   false 且落入编排视角时，opx_status 视图渲染补传 `_agent` 的身份提示（MCP 子代理首查死锁兜底）。 */
  identityDeclared?: boolean
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
    /** 重置指定 verify step 的审查 tags 为 pending（仅 phase=review 时有效，与 review_layer 互斥），
     *  恢复后 currentStep 落在第一个未全部通过的 verify step，可能早于被重置的 step。 */
    reset_steps?: ReviewVerifyStep[]
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

export interface StatusParams {
  change_id: string
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
  /** giveup 决策配套：对当前 step 质量门必做清单（must_do）未覆盖项逐项提供的结构化降级理由
   * （giveup 未覆盖项缺理由则拒绝 giveup）。adjudication 取值 user_response / unattended_auto / env_unavailable。 */
  checkpoint_skip_reasons?: Array<{
    item: string
    category: string
    adjudication: string
    note?: string
  }>
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
