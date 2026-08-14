import { tool } from "@opencode-ai/plugin"
import { BUILD_PHASE_TARGETS, REVIEW_LAYERS, REVIEW_VERIFY_STEPS } from "../../core/types.ts"
import {
  initExecute, setWorktreeExecute, statusExecute,
  completeTaskGroupExecute, setUnattendedExecute,
} from "../../core/tools/lifecycle.ts"
import { agentSubmitExecute } from "../../core/tools/submit.ts"
import {
  orchInitSchema, setWorktreeSchema, statusSchema,
  completeTaskGroupSchema, setUnattendedSchema, agentSubmitSchema,
} from "../../core/tools/schemas.ts"
import { jsonSchemaToZod } from "./json-schema.ts"
import { isPrimaryAgent } from "./agents.ts"
import type { ToolContext } from "../../core/tools/types.ts"

/** 直载形态调用上下文：agent 身份由会话运行时推导（恒显式声明），编排视角按主代理名判定。 */
function makeCtx(context: { worktree: string; agent: string }): ToolContext {
  return {
    worktree: context.worktree,
    agent: context.agent,
    orchestrator: isPrimaryAgent(context.agent),
    identityDeclared: true,
  }
}

export const init = tool({
  description:
    "初始化编排会话。传入变更 ID 和任务组 ID，工具自动解析 tasks.md 提取全部任务组并解析目标组子任务。可通过 recovery 参数恢复到指定阶段。无 recovery 重复初始化当前任务组时保留其阶段和进度；切换到其它任务组时初始化该组。",
  args: jsonSchemaToZod(orchInitSchema).shape as any,
  async execute(args, context) {
    return initExecute(args as any, makeCtx(context))
  },
})

export const set_worktree = tool({
  description:
    "确保目标组的 git worktree 就绪。若已存在则复用，否则按规范自动创建（分支 task-group/{changeId}/{taskGroupId}，路径 .worktree/{changeId}/task-group-{taskGroupId}）。只补齐资源，不改变阶段。",
  args: jsonSchemaToZod(setWorktreeSchema).shape as any,
  async execute(args, context) {
    return setWorktreeExecute(args as any, makeCtx(context))
  },
})

export const status = tool({
  description:
    "统一状态/上下文查询（只读为主）。按调用者角色路由：编排视角→统计+worktree；architect→spec/blocker；developer→worktree/boundary/task/issue；reviewer-tool→tool 层控件 issue；reviewer-task→task 验证状态；quality reviewer→自维度既有 issue。",
  args: jsonSchemaToZod(statusSchema).shape as any,
  async execute(args, context) {
    return statusExecute({ change_id: args.change_id as string }, makeCtx(context))
  },
})

export const complete_task_group = tool({
  description:
    "完成任务组收尾：合并 task-group 分支到 baseBranch → 清理 worktree 与分支。须在收尾验证（verify_cleanup）通过后调用。合并冲突时中止并返回 blocked（保留 worktree/分支）。",
  args: jsonSchemaToZod(completeTaskGroupSchema).shape as any,
  async execute(args, context) {
    return completeTaskGroupExecute({ change_id: args.change_id as string }, makeCtx(context))
  },
})

export const set_unattended = tool({
  description:
    "开启/关闭无人值守模式。开启后编排流程不再向用户提问：analyze 确认模式由架构师自行裁决（不确认用户）；重试检查点、状态异常、blocker 处理等需拍板事项由主代理按编排行为准则自行决策并提交——检查点决策是 opx_agent_submit 工具调用，主代理可自行执行，不因无人值守而抑制。",
  args: jsonSchemaToZod(setUnattendedSchema).shape as any,
  async execute(args, context) {
    return setUnattendedExecute(args as any, makeCtx(context))
  },
})

export const agent_submit = tool({
  description:
    "通用 step 提交，按 step_id 路由到 workflow 对应 step。校验调用者属于该 step 的 agents（越权直接拒绝），提交后推进 workflow 状态机并写回编排状态。可通过 exempt_adjudications 对已申请豁免的 issue 进行裁定（dismissed→cancelled、rejected→回 todo）；可通过 recheck_adjudications 复核已修复待复核（review 态）的 issue（passed→done、rejected→回 todo 并记 refix_count 与 reject_reason，谁提谁裁定）。",
  args: jsonSchemaToZod(agentSubmitSchema).shape as any,
  async execute(args, context) {
    return agentSubmitExecute(args as any, makeCtx(context))
  },
})
