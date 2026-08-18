/**
 * 通用 MCP Server 承载层：6 个 opx_* 工具由 agent 无关的 MCP Server（HTTP transport）承载，
 * 参数采用 P1 纯 JSON Schema。任意支持 MCP client 的 agent（opencode / claude code / codex / zcode）
 * 均可发现与调用同一套工具。
 *
 * 身份约定（适配层职责，不污染 P1 契约）：
 * - 每个工具在 P1 schema 基础上附加可选 `_agent` 参数：子代理调用时传自身角色名
 *   （如 openspec-reviewer-tool），主代理调用缺省即编排视角（orchestrator: true）；
 * - `_agent` 缺省/为空视为编排主代理视角。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { JSONSchema } from "../../core/provider.ts"
import type { ToolContext } from "../../core/tools/types.ts"
import {
  initExecute, setWorktreeExecute, statusExecute,
  completeTaskGroupExecute, setUnattendedExecute,
} from "../../core/tools/lifecycle.ts"
import { agentSubmitExecute } from "../../core/tools/submit.ts"
import {
  orchInitSchema, setWorktreeSchema, statusSchema,
  completeTaskGroupSchema, setUnattendedSchema, agentSubmitSchema,
} from "../../core/tools/schemas.ts"
import { readStateByWorktree, writeState } from "../../core/state.ts"
import { jsonSchemaToZod } from "./json-schema.ts"

/** 私有身份参数：附加到每个工具的 MCP 暴露 schema（下划线前缀表示非业务参数）。 */
const AGENT_ARG = "_agent"

interface ToolSpec {
  description: string
  schema: JSONSchema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

const TOOL_SPECS: Record<string, ToolSpec> = {
  opx_orch_init: {
    description:
      "初始化编排会话。传入变更 ID 和任务组 ID，工具自动解析 tasks.md 提取全部任务组并解析目标组子任务。可通过 recovery 参数恢复到指定阶段。无 recovery 重复初始化当前任务组时保留其阶段和进度；切换到其它任务组时初始化该组。",
    schema: orchInitSchema,
    execute: (args, ctx) => initExecute(args as any, ctx),
  },
  opx_orch_set_worktree: {
    description:
      "确保目标组的 git worktree 就绪。若已存在则复用，否则按规范自动创建（分支 task-group/{changeId}/{taskGroupId}，路径 .worktree/{changeId}/task-group-{taskGroupId}）。只补齐资源，不改变阶段。",
    schema: setWorktreeSchema,
    execute: (args, ctx) => setWorktreeExecute(args as any, ctx),
  },
  opx_status: {
    description:
      "统一状态/上下文查询（只读为主）。按调用者角色路由：编排视角→统计+worktree；architect→spec/blocker；developer→worktree/boundary/task/issue；reviewer-tool→tool 层控件 issue；reviewer-task→task 验证状态；quality reviewer→自维度既有 issue。",
    schema: statusSchema,
    execute: (args, ctx) => statusExecute({ change_id: (args as any).change_id }, ctx),
  },
  opx_orch_complete_task_group: {
    description:
      "完成任务组收尾：合并 task-group 分支到 baseBranch → 清理 worktree 与分支。须在收尾验证（verify_cleanup）通过后调用。合并冲突时中止并返回 blocked（保留 worktree/分支）。",
    schema: completeTaskGroupSchema,
    execute: (args, ctx) => completeTaskGroupExecute(args as any, ctx),
  },
  opx_orch_set_unattended: {
    description:
      "开启/关闭无人值守模式。开启后编排流程不再向用户提问：analyze 确认模式由架构师自行裁决（不确认用户）；重试检查点、状态异常、blocker 处理等需拍板事项由主代理按编排行为准则自行决策并提交——检查点决策是 opx_agent_submit 工具调用，主代理可自行执行，不因无人值守而抑制。",
    schema: setUnattendedSchema,
    execute: (args, ctx) => setUnattendedExecute(args as any, ctx),
  },
  opx_agent_submit: {
    description:
      "通用 step 提交，按 step_id 路由到 workflow 对应 step。校验调用者属于该 step 的 agents（越权直接拒绝），提交后推进 workflow 状态机并写回编排状态。可通过 exempt_adjudications 对已申请豁免的 issue 进行裁定（dismissed→cancelled、rejected→回 todo）；可通过 recheck_adjudications 复核已修复待复核（review 态）的 issue（passed→done、rejected→回 todo 并记 refix_count 与 reject_reason，谁提谁裁定）。",
    schema: agentSubmitSchema,
    execute: (args, ctx) => agentSubmitExecute(args as any, ctx),
  },
}

/** 附加 _agent 身份参数到 P1 schema（仅 MCP 暴露层；OpenCode 直载形态无此参数）。 */
function withAgentArg(schema: JSONSchema): JSONSchema {
  return {
    ...schema,
    properties: {
      ...(schema.properties ?? {}),
      [AGENT_ARG]: {
        type: "string",
        description: "调用者 agent 标识（子代理调用时传自身角色名，如 openspec-reviewer-tool；缺省为编排主代理视角）",
      },
    },
    required: schema.required ?? [],
  }
}

/** 解析调用上下文：_agent 缺省/空 → 编排主代理视角（orchestrator: true）。 */
function resolveContext(args: Record<string, unknown>, worktree: string): ToolContext {
  const declared = typeof args[AGENT_ARG] === "string" && args[AGENT_ARG] !== ""
  const agent = declared ? (args[AGENT_ARG] as string) : "primary"
  return { worktree, agent, orchestrator: agent === "primary", identityDeclared: declared }
}

/**
 * 默认无人值守：server 启动时声明（claude code / codex / zcode 适配器分发），
 * 会话已初始化（有 changeId 与状态）且 state.unattended 未设置时自动置 true。
 * 幂等：已设置过则跳过，不覆盖用户显式关闭的会话。
 */
async function ensureDefaultUnattended(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<void> {
  const changeId = typeof (args as any).change_id === "string" ? (args as any).change_id : undefined
  if (!changeId) return
  try {
    const state = await readStateByWorktree(ctx.worktree, changeId)
    if (state && state.unattended === undefined) {
      state.unattended = true
      await writeState(ctx.worktree, state)
    }
  } catch {
    // 状态不可读/不可写时静默跳过（不阻断工具主流程）
  }
}

declare const __OPX_PKG_VERSION__: string | undefined
/** 版本号单一来源：package.json（发布时仅需改一处）；bundle 形态（ZCode 插件包）由构建期 --define 注入常量，避免运行时读文件。 */
const PKG_VERSION =
  typeof __OPX_PKG_VERSION__ === "string"
    ? __OPX_PKG_VERSION__
    : (JSON.parse(
        readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf-8"),
      ) as { version: string }).version

/** 构建承载 6 个 opx_* 工具的 MCP server。unattended=true 时启用默认无人值守（spec: unattended-default）。 */
export function buildMcpServer(worktree: string, opts: { unattended?: boolean; stripOpxPrefix?: boolean } = {}): McpServer {
  const mcp = new McpServer({ name: "openspec-agents", version: PKG_VERSION })
  for (const [name, spec] of Object.entries(TOOL_SPECS)) {
    const toolName = opts.stripOpxPrefix ? name.replace(/^opx_/, "") : name
    mcp.registerTool<any, any>(
      toolName,
      {
        title: toolName,
        description: spec.description,
        inputSchema: jsonSchemaToZod(withAgentArg(spec.schema)),
      },
      async (args: any, _extra: any) => {
        const cleanArgs = { ...(args as Record<string, unknown>) }
        delete cleanArgs[AGENT_ARG]
        const ctx = resolveContext(args as Record<string, unknown>, worktree)
        if (opts.unattended) {
          // 执行前（存量会话）+ 执行后（opx_orch_init 新建会话）各补一次：幂等，已设置则跳过
          await ensureDefaultUnattended(cleanArgs, ctx)
        }
        const result = await spec.execute(cleanArgs, ctx)
        if (opts.unattended) {
          await ensureDefaultUnattended(cleanArgs, ctx)
        }
        return { content: [{ type: "text" as const, text: result }] }
      },
    )
  }
  return mcp
}
