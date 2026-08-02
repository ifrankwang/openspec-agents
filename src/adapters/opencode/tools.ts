import { tool } from "@opencode-ai/plugin"
import {
  initExecute, setWorktreeExecute, statusExecute,
  completeTaskGroupExecute, setUnattendedExecute,
} from "../../core/tools/lifecycle.js"
import {
  archSubmitExecute, archBlockerExecute, devSubmitExecute,
  toolReviewSubmitExecute, taskReviewSubmitExecute,
  qualityReviewSubmitExecute, resolveReviewExecute,
} from "../../core/tools/review.js"
import {
  executionBoundarySchema, boundaryExpansionSchema, reviewIssue, blockerItem,
  requestExemptItem, rejectedIssueItem, toolIssueItem, taskVerifyResult, validationStepSchema,
} from "./schemas.js"

export const init = tool({
  description:
    "初始化编排会话。传入变更 ID 和任务组 ID，工具自动解析 tasks.md 提取全部任务组并解析目标组子任务。可通过 recovery 参数恢复到指定阶段。无 recovery 重复初始化当前任务组时保留其阶段和进度；切换到其它任务组时初始化该组。",
  args: {
    change_id: tool.schema.string().min(1).describe("OpenSpec 变更 ID"),
    task_group_id: tool.schema.string().min(1).describe("要初始化的任务组 ID。无 recovery 重复调用当前组时保留进度；切换任务组时仅初始化目标组。"),
    base_branch: tool.schema.string().optional().describe("基准分支名（如 main、develop），用于计算 merge-base 和 worktree fork 源。未传则自动从当前 git 分支推导。"),
    recovery: tool.schema.object({
      phase: tool.schema.enum(["task_analysis", "dev_impl", "review"] as const).describe("恢复到哪个阶段"),
      review_layer: tool.schema
        .enum(["tool", "task", "quality"] as const)
        .optional()
        .describe("恢复到 review 内某子层（仅 phase=review 时有效）。tool→从 tool 层开始（默认），task→tool 层标记完成从 task 层开始，quality→tool+task 层完成从 quality 层开始"),
      reopenIssues: tool.schema.boolean().default(false).optional().describe("完成后继续修 issue：将目标任务组全部非 verified issue 置为 rejected，重置 review 进度，回到 dev_impl 阶段。目标组必须为 completed。与 review_layer 互斥。"),
    }).optional().describe("进度恢复参数。提供后按 phase 恢复阶段状态，< phase 为 completed，== phase 为 in_progress，> phase 为 not_started。"),
  },
  async execute(args, context) {
    return initExecute(args, { worktree: context.worktree, agent: context.agent })
  },
})

export const set_worktree = tool({
  description:
    "确保目标组的 git worktree 就绪。若已存在则复用，否则按规范自动创建（分支 task-group/{changeId}/{taskGroupId}，路径 .worktree/{changeId}/task-group-{taskGroupId}）。只补齐资源，不改变阶段。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
    worktree_path: tool.schema.string().optional().describe("git worktree 的绝对路径（可选，不传则按规范自动生成）"),
    branch_name: tool.schema.string().optional().describe("worktree 对应的分支名（可选，不传则按规范 task-group/{changeId}/{taskGroupId}）"),
  },
  async execute(args, context) {
    return setWorktreeExecute(args, { worktree: context.worktree, agent: context.agent })
  },
})

export const status = tool({
  description:
    "统一只读状态/上下文查询。按调用者角色路由：orchestrator→统计+worktree；architect→spec/blocker；developer→worktree/boundary/task/issue；reviewer-tool→tool 层控件 issue；reviewer-task→task 验证状态；quality reviewer→自维度既有 issue。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
  },
  async execute(args, context) {
    return statusExecute({ change_id: args.change_id }, { worktree: context.worktree, agent: context.agent })
  },
})

export const complete_task_group = tool({
  description:
    "完成任务组收尾：合并 task-group 分支到 baseBranch → 清理 worktree 与分支。合并冲突时中止并返回 blocked（保留 worktree/分支）。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
  },
  async execute(args, context) {
    return completeTaskGroupExecute({ change_id: args.change_id }, { worktree: context.worktree, agent: context.agent })
  },
})

export const set_unattended = tool({
  description:
    "开启/关闭无人值守模式。开启后编排流程在重试检查点、状态异常、blocker 处理等场景不再 question 用户，自动决策。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
    enabled: tool.schema.boolean().default(true).describe("true=开启；false=关闭"),
  },
  async execute(args, context) {
    return setUnattendedExecute(args, { worktree: context.worktree, agent: context.agent })
  },
})

export const arch_submit = tool({
  description:
    "架构师提交预检结果。仅 outcome=ready，所有 blocker 需先通过 opx_arch_blocker 处理。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
    outcome: tool.schema.enum(["ready"]),
    execution_boundary: executionBoundarySchema.optional(),
  },
  async execute(args, context) {
    return archSubmitExecute(args as any, { worktree: context.worktree, agent: context.agent })
  },
})

export const arch_blocker = tool({
  description: "架构师记录/更新 blocker，不结束本环节。创建 mode 入库 awaiting_user；更新 mode 写入 user_response 并置 resolved。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
    blocker_id: tool.schema.string().optional().describe("提供=更新模式；不提供=创建模式"),
    blockers: tool.schema.array(blockerItem).optional().describe("创建模式：新增 blocker 列表"),
    user_response: tool.schema.string().optional().describe("用户答复。创建模式有则立即 resolved；更新模式必传"),
  },
  async execute(args, context) {
    return archBlockerExecute(args, { worktree: context.worktree, agent: context.agent })
  },
})

export const dev_submit = tool({
  description:
    "developer 提交实现结果。outcome=completed 提交实现；outcome=blocked 上报 blocker。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
    outcome: tool.schema.enum(["completed", "blocked"]).optional(),
    completed_task_ids: tool.schema.array(tool.schema.string()).optional().describe("已完成的 task ID 列表"),
    self_check_results: tool.schema.string().optional().describe("提交前自检结果汇总"),
    blocker: blockerItem.optional(),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("确认修复的 issue ID 列表"),
    request_exempts: tool.schema.array(requestExemptItem).optional().describe("不可修的 issue 申请豁免"),
  },
  async execute(args, context) {
    return devSubmitExecute(args, { worktree: context.worktree, agent: context.agent })
  },
})

export const tool_review_submit = tool({
  description:
    "工具审核层提交。跨维提交 tool issues（issues 自带 dimension 字段），含 UT 结果。调用者必须为 openspec-reviewer-tool。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
    passed: tool.schema.boolean().describe("工具层是否通过。有未解决的 Low+ issue 时须设为 false"),
    issues: tool.schema.array(toolIssueItem).optional().describe("跨维 issue，每个 item 需带 dimension"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("豁免裁定的 issue ID 列表"),
    rejected_issue_ids: tool.schema.array(rejectedIssueItem).optional().describe("驳回的 issue 列表（含原因）"),
    test_results: tool.schema.string().optional().describe("UT 运行结果摘要"),
    boundary_expansion: boundaryExpansionSchema.optional().describe("执行边界扩展（仅 passed=false 时有效）"),
  },
  async execute(args, context) {
    return toolReviewSubmitExecute(args, { worktree: context.worktree, agent: context.agent })
  },
})

export const task_review_submit = tool({
  description:
    "任务审核层提交。验证 task 产出、服务启动、接口可用性、测试代码审查。调用者必须为 openspec-reviewer-task。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
    passed: tool.schema.boolean().describe("任务层是否通过。有未解决的 Low+ issue 或 task 未通过时须设为 false"),
    verified_task_ids: tool.schema.array(tool.schema.string()).optional().describe("已验证完成的 task ID 列表"),
    failed_task_ids: tool.schema.array(taskVerifyResult).optional().describe("未完成的 task 列表（含原因）"),
    issues: tool.schema.array(reviewIssue).optional().describe("测试代码审查 issue"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("豁免裁定的 issue ID 列表"),
    rejected_issue_ids: tool.schema.array(rejectedIssueItem).optional().describe("驳回的 issue 列表（含原因）"),
    boundary_expansion: boundaryExpansionSchema.optional().describe("执行边界扩展（仅 passed=false 时有效）"),
    validation_steps: tool.schema.array(validationStepSchema).optional().describe("验证步骤执行摘要。必须覆盖 opx_status 操作指引中的全部步骤，已完成的标记 completed=true 并附 evidence，跳过的标记 completed=false 并附 skip_reason"),
  },
  async execute(args, context) {
    return taskReviewSubmitExecute(args, { worktree: context.worktree, agent: context.agent })
  },
})

export const quality_review_submit = tool({
  description:
    "AI 语义审查层提交。维度由调用者身份自动识别。调用者必须为 openspec-reviewer-{style|architecture|performance|security|maintainability}。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
    passed: tool.schema.boolean().describe("本维度是否通过。有未解决的 Low+ issue 时须设为 false"),
    issues: tool.schema.array(reviewIssue).optional().describe("新报审查 issue"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("豁免裁定的 issue ID 列表"),
    rejected_issue_ids: tool.schema.array(rejectedIssueItem).optional().describe("驳回的 issue 列表（含原因）"),
    boundary_expansion: boundaryExpansionSchema.optional().describe("执行边界扩展（仅 passed=false 时有效）"),
  },
  async execute(args, context) {
    return qualityReviewSubmitExecute(args, { worktree: context.worktree, agent: context.agent })
  },
})

export const resolve_review = tool({
  description:
    "编排者在 review 阶段重试超上限（needs_user_decision）后，根据用户决策推进。decision=continue：重置审查进度后继续修复；decision=giveup：将剩余待审 issue 置为 exempted 后完成。",
  args: {
    change_id: tool.schema.string().min(1).describe("change ID"),
    decision: tool.schema
      .enum(["continue", "giveup"])
      .describe("continue=继续修复；giveup=放弃"),
  },
  async execute(args, context) {
    return resolveReviewExecute(args, { worktree: context.worktree, agent: context.agent })
  },
})
