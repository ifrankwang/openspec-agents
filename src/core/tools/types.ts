import type { BuildPhaseTarget, ReviewLayer, ReviewVerifyStep, SimpleReviewStep, WorkflowMode } from "../types.ts"

export interface ToolContext {
  worktree: string
  agent: string
  /** 编排视角角色判定：true 表示调用者承担编排者职责（各 agent 主代理），替代 agent 名硬编码 openspec-orchestrator。 */
  orchestrator?: boolean
  /** 调用者 agent 身份是否显式声明：MCP 形态下为是否携带 `_agent` 参数。
   *   false 且落入编排视角时，opx_status 视图渲染补传 `_agent` 的身份提示（MCP 子代理首查死锁兜底）。 */
  identityDeclared?: boolean
  remote?: boolean
}

export interface ToolResult {
  content: string
  isError?: boolean
}

export interface InitParams {
  /** change 会话入口必传；独立审查入口（review_scope）不传（会话 id 由 review_scope 推导并在返回体回传）。 */
  change_id?: string
  /** change 会话入口必传；独立审查会话用固定虚拟组 review（recovery 时可缺省）。 */
  task_group_id?: string
  /** 独立审查会话入口：与 change_id/task_group_id 互斥（同传报错、都不传报错）。 */
  review_scope?: {
    scope_type: "pr" | "full"
    base_ref?: string
    head_ref?: string
    granularity: "simple" | "thorough"
    fix: "none" | "fix"
  }
  base_branch?: string
  recovery?: {
    phase: BuildPhaseTarget
    review_layer?: ReviewLayer
    reopenIssues?: boolean
    /** 重置指定审查 step 的审查 tags 为 pending（仅 phase=review 时有效，与 review_layer 互斥），
     *  恢复后 currentStep 落在第一个未全部通过的审查 step，可能早于被重置的 step。
     *  值按模式生效：full 模式为 verify_tool/verify_task/verify_quality，simple 模式为 quality_review
     *  （跨模式值在运行时报错）。 */
    reset_steps?: ReviewVerifyStep[] | SimpleReviewStep[]
  }
  /** 流程模式（full/simple）：首次新建编排状态时固化；已开始的变更仅在切组（其他任务组均已完成
   *  或从未激活）或 recovery.phase=task_analysis 重制当前组（其他任务组同样须已完成或从未激活）
   *  时允许更新，窗口外传不同 mode 报错。 */
  mode?: WorkflowMode
  /** 会话项目栈（两入口必传）：skill 加载清单与 must_do 门禁的过滤基准。
   *  每个值必须命中当前 skill 索引中实际存在的标签（动态校验）。 */
  project_stacks: string[]
  project_frameworks: string[]
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
  /** giveup 决策配套：对当前 step 必做清单（workflow step 声明，按会话项目栈过滤）未覆盖项逐项提供的结构化降级理由
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
  /** implement step：规划文档未记载的部署注意点（实施时新发现），随收尾汇总转述。 */
  deployment_notes?: string[]
  completed_task_ids?: string[]
  /** 本 step 必做项申报（implement / review step 通用）：逐项申报生效必做清单的处理结果。
   *  completed=true 须附 evidence；completed=false 须附结构化 skip_reason。 */
  must_do_checks?: Array<{
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
