import { tool } from "@opencode-ai/plugin"
import { BUILD_PHASE_TARGETS, REVIEW_LAYERS } from "../../core/types.js"
import {
  initExecute, setWorktreeExecute, statusExecute,
  completeTaskGroupExecute, setUnattendedExecute,
} from "../../core/tools/lifecycle.js"
import { agentSubmitExecute } from "../../core/tools/submit.js"
import { agentSubmitSchema } from "./schemas.js"

export const init = tool({
  description:
    "初始化编排会话。传入变更 ID 和任务组 ID，工具自动解析 tasks.md 提取全部任务组并解析目标组子任务。可通过 recovery 参数恢复到指定阶段。无 recovery 重复初始化当前任务组时保留其阶段和进度；切换到其它任务组时初始化该组。",
  args: {
    change_id: tool.schema.string().min(1).describe("OpenSpec 变更 ID"),
    task_group_id: tool.schema.string().min(1).describe("要初始化的任务组 ID。无 recovery 重复调用当前组时保留进度；切换任务组时仅初始化目标组。"),
    base_branch: tool.schema.string().optional().describe("基准分支名（如 main、develop），用于计算 merge-base 和 worktree fork 源。未传则自动从当前 git 分支推导。"),
    recovery: tool.schema.object({
      phase: tool.schema.enum(BUILD_PHASE_TARGETS).describe("恢复到哪个阶段"),
      review_layer: tool.schema
        .enum(REVIEW_LAYERS)
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

export const agent_submit = tool({
  description:
    "通用 step 提交，按 step_id 路由到 workflow 对应 step。校验调用者属于该 step 的 agents（越权直接拒绝），提交后推进 workflow 状态机并写回编排状态。可通过 exempt_adjudications 对已申请豁免的 issue 进行裁定（dismissed→cancelled、rejected→回 todo）。",
  args: agentSubmitSchema.shape,
  async execute(args, context) {
    return agentSubmitExecute(args as any, { worktree: context.worktree, agent: context.agent })
  },
})
