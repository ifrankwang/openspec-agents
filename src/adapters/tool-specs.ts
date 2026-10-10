/**
 * 6 个 opx_* 工具的名称、描述与参数 schema 单一事实源（DRY）。
 *
 * MCP 形态（claude-code / codex / zcode / opencode 外的各 harness）与 DSH 原生工具形态
 * 消费同一张表：描述文案与参数 schema 只在此定义一次，任一形态改动不会与另一形态漂移。
 * 两种承载的差异只在参数投影与上下文注入（见各自 adapter）。
 */
import type { JSONSchema } from "../core/provider.ts"
import {
  orchInitSchema, setWorktreeSchema, statusSchema,
  completeTaskGroupSchema, setUnattendedSchema, agentSubmitSchema,
} from "../core/tools/schemas.ts"

export interface OpxToolSpec {
  /** 工具注册名（DSH 原生与 MCP 一律 opx_ 前缀）。 */
  name: string
  description: string
  schema: JSONSchema
}

export const OPX_TOOL_NAMES = [
  "opx_orch_init",
  "opx_orch_set_worktree",
  "opx_status",
  "opx_orch_complete_task_group",
  "opx_orch_set_unattended",
  "opx_agent_submit",
] as const

/** 6 个工具的规格表，顺序即注册顺序。 */
export const OPX_TOOL_SPECS: readonly OpxToolSpec[] = [
  {
    name: "opx_orch_init",
    description:
      "初始化编排会话。传入变更 ID 和任务组 ID，工具自动解析 tasks.md 提取全部任务组并解析目标组子任务。可通过 recovery 参数恢复到指定阶段。无 recovery 重复初始化当前任务组时保留其阶段和进度；切换到其它任务组时初始化该组。可选 mode 参数（full/simple，缺省 simple）选择流程模式：首次新建状态时固化；已开始的变更仅切组（其他任务组均已完成或从未激活）或 recovery.phase=task_analysis 重制当前组（其他任务组同样须已完成或从未激活）时可更新，其余场景传不同 mode 报错。",
    schema: orchInitSchema,
  },
  {
    name: "opx_orch_set_worktree",
    description:
      "确保目标组的 git worktree 就绪。change 会话按 change 模型 create-or-reuse：分支 change/{changeId} 不存在时从基准分支 tip 创建，worktree 常驻于 .worktree/{changeId}/ws，全部任务组串行复用（复用校验：目录缺失自愈重建、openspec 文档脏自动提交、代码文件脏拒绝）。只补齐资源，不改变阶段。",
    schema: setWorktreeSchema,
  },
  {
    name: "opx_status",
    description:
      "统一状态/上下文查询（只读为主）。按调用者角色路由：编排视角→统计+worktree；architect→spec/blocker；developer→worktree/boundary/task/issue；reviewer-tool→tool 层控件 issue；reviewer-task→task 验证状态；quality reviewer→自维度既有 issue。",
    schema: statusSchema,
  },
  {
    name: "opx_orch_complete_task_group",
    description:
      "完成任务组收尾。非最后任务组仅做门禁与范围标记（不合并、不销毁）；最后一个任务组收口时把 change 分支（change/{changeId}）一次性合并回 baseBranch（漂移无害——文档、openspec 规划路径或仅版本号变更的 package.json——时直接合并收口；漂移含任一其他文件或文本冲突时回退到收尾验证 verify_cleanup 并返回 blocked），成功后销毁 worktree 并删分支。须在收尾验证（verify_cleanup）通过后调用。主仓库本地改动文件与合并写入文件重合、或存在部分暂存文件时中止并返回 blocked（保留 worktree/分支）；主仓库无关脏文件不阻塞合并。",
    schema: completeTaskGroupSchema,
  },
  {
    name: "opx_orch_set_unattended",
    description:
      "开启/关闭无人值守模式。开启后编排流程不再向用户提问：analyze 确认模式由架构师自行裁决（不确认用户）；重试检查点、状态异常、blocker 处理等需拍板事项由主代理按编排行为准则自行决策并提交——检查点决策是 opx_agent_submit 工具调用，主代理可自行执行，不因无人值守而抑制。",
    schema: setUnattendedSchema,
  },
  {
    name: "opx_agent_submit",
    description:
      "通用 step 提交，按 step_id 路由到 workflow 对应 step。校验调用者属于该 step 的 agents（越权直接拒绝），提交后推进 workflow 状态机并写回编排状态。可通过 exempt_adjudications 对已申请豁免的 issue 进行裁定（dismissed→cancelled、rejected→回 todo）；可通过 recheck_adjudications 复核已修复待复核（review 态）的 issue（passed→done、rejected→回 todo 并记 refix_count 与 reject_reason，谁提谁裁定）。",
    schema: agentSubmitSchema,
  },
]

/** 规格表查表。 */
export function opxToolSpec(name: string): OpxToolSpec {
  const spec = OPX_TOOL_SPECS.find((s) => s.name === name)
  if (!spec) throw new Error(`未注册的 opx 工具：${name}`)
  return spec
}