import { tool } from "@opencode-ai/plugin"
import { SEVERITY_LEVELS } from "../../core/constants.js"
import { CODE_DIMENSIONS } from "../../core/types.js"

export const executionBoundarySchema = tool.schema.object({
  allowed_directories: tool.schema.array(tool.schema.string().min(1)).min(1).describe("developer 只能修改/创建文件的目录列表（含实施与验证所需的测试代码目录）"),
  allowed_packages: tool.schema.array(tool.schema.string().min(1)).min(1).describe("developer 只能新增/修改代码的包路径列表（含对应的测试包路径）"),
  notes: tool.schema.string().describe("实施建议：关键坑位提醒、组件复用指引、设计约束边缘场景、框架应用说明（如对象映射框架使用要点）；不含目录/包路径（见 allowed_directories/allowed_packages），无则留空"),
})

export const boundaryExpansionSchema = tool.schema.object({
  allowed_directories: tool.schema.array(tool.schema.string().min(1)).optional().describe("reviewer 声明的额外允许目录"),
  allowed_packages: tool.schema.array(tool.schema.string().min(1)).optional().describe("reviewer 声明的额外允许包路径"),
})

export const taskVerifyItem = tool.schema.object({
  task_id: tool.schema.string().min(1).describe("子任务 ID（task 清单中 task 项的 id）"),
  reason: tool.schema.string().min(1).describe("失败理由"),
})

export const validationStepSchema = tool.schema.object({
  step: tool.schema.string().min(1).describe("验证步骤名称，对应 opx_status 操作指引中的步骤描述"),
  completed: tool.schema.boolean().describe("是否完成"),
  evidence: tool.schema.string().optional().describe("执行结果摘要或证据，含关键输出指标"),
  skip_reason: tool.schema.string().optional().describe("跳过原因（仅 completed=false 时必填）"),
})

export const blockerItem = tool.schema.object({
  source_role: tool.schema.string().min(1),
  task_id: tool.schema.string().min(1).optional(),
  category: tool.schema.string().min(1),
  description: tool.schema.string().min(1),
  evidence: tool.schema.string().min(1),
  attempted_actions: tool.schema.string().min(1),
  options: tool.schema.array(tool.schema.string().min(1)).optional(),
})

export const exemptAdjudicationItem = tool.schema.object({
  issue_id: tool.schema.string().min(1).describe("申请豁免的 issue ID"),
  action: tool.schema.enum(["dismissed", "rejected"]).describe("dismissed=豁免成立（issue 置 cancelled）；rejected=驳回（issue 回 todo 继续修复）"),
})

export const agentSubmitSchema = tool.schema.object({
  change_id: tool.schema.string().min(1).describe("change ID"),
  step_id: tool.schema.string().min(1).describe("workflow step 的 id"),
  verdict: tool.schema.enum(["passed", "failed"]).describe("裁决结果"),
  fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("声明已修复的 issue child id"),
  exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("声明申请豁免的 issue child id"),
  exempt_adjudications: tool.schema.array(exemptAdjudicationItem).optional().describe("裁定的豁免申请列表：dismissed→cancelled，rejected→回 todo"),
  checkpoint_decision: tool.schema.enum(["continue", "giveup"]).optional().describe("重试检查点决策：continue=重置该 step tag 并回退 parent；giveup=未解决 children 强制 cancelled 并将 step 标记 completed"),
  new_children: tool.schema.array(tool.schema.object({
    id: tool.schema.string(),
    title: tool.schema.string(),
    description: tool.schema.string(),
    severity: tool.schema.enum(SEVERITY_LEVELS).optional(),
    source_phase: tool.schema.enum(["tool", "task", "quality"]).optional().describe("issue 归因阶段（tool/task/quality）。quality reviewer 提报时缺省归因 quality，其余调用方缺省 tool"),
    dimension: tool.schema.enum(CODE_DIMENSIONS).optional().describe("issue 归因维度，缺省 style"),
    file: tool.schema.string().optional().describe("问题所在文件路径（相对于 worktree）"),
    line: tool.schema.number().int().min(0).optional().describe("问题所在行号（0=整文件/待新建文件）"),
    suggestion: tool.schema.string().optional().describe("修复建议"),
    rule: tool.schema.string().optional().describe("工具规则名（如 PMD Rule / SonarQube rule），无则省略"),
    root_cause_guess: tool.schema.string().optional().describe("根因猜测（仅特定维度需要）"),
  })).optional().describe("提交时新增的 issue child"),
  execution_boundary: executionBoundarySchema.optional().describe("analyze step：架构预检产出的执行边界（verdict=passed 必传）"),
  blockers: tool.schema.array(blockerItem).optional().describe("analyze step：新增 blocker 列表"),
  blocker_updates: tool.schema.array(tool.schema.object({
    blocker_id: tool.schema.string().min(1).describe("blocker ID"),
    user_response: tool.schema.string().min(1).describe("用户答复"),
  })).optional().describe("analyze step：按 blocker_id 置 resolved 并记录用户答复"),
  blocker: blockerItem.optional().describe("implement step：outcome=blocked 等价，须配合 verdict=failed"),
  self_check_results: tool.schema.string().optional().describe("implement step：提交前自检结果汇总"),
  completed_task_ids: tool.schema.array(tool.schema.string()).optional().describe("implement step：已完成的 task id（覆盖门禁：全部 open/rejected task 必须被覆盖）"),
  test_results: tool.schema.string().optional().describe("verify_tool step：UT 运行结果摘要"),
  validation_steps: tool.schema.array(validationStepSchema).optional().describe("verify_task step：验证步骤执行摘要"),
  boundary_expansion: boundaryExpansionSchema.optional().describe("review step：执行边界扩展（仅 verdict=failed 有效）"),
  verified_tasks: tool.schema.array(tool.schema.string()).optional().describe("verify_task step：验证通过的 task id"),
  failed_tasks: tool.schema.array(taskVerifyItem).optional().describe("verify_task step：验证失败的 task 列表（含原因）"),
})
