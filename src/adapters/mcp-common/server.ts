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
import { readStateByWorktree, writeState } from "../../core/state.ts"
import { jsonSchemaToZod } from "./json-schema.ts"
import { OPX_TOOL_SPECS } from "../tool-specs.ts"

/** 私有身份参数：附加到每个工具的 MCP 暴露 schema（下划线前缀表示非业务参数）。 */
const AGENT_ARG = "_agent"

interface ToolSpec {
  description: string
  schema: JSONSchema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>
}

/** 工具名 → 内核执行器；名称与描述取自共享规格表（src/adapters/tool-specs.ts）。 */
const TOOL_EXECUTORS: Record<string, (args: any, ctx: ToolContext) => Promise<string>> = {
  opx_orch_init: (args, ctx) => initExecute(args, ctx),
  opx_orch_set_worktree: (args, ctx) => setWorktreeExecute(args, ctx),
  opx_status: (args, ctx) => statusExecute({ change_id: args.change_id }, ctx),
  opx_orch_complete_task_group: (args, ctx) => completeTaskGroupExecute(args, ctx),
  opx_orch_set_unattended: (args, ctx) => setUnattendedExecute(args, ctx),
  opx_agent_submit: (args, ctx) => agentSubmitExecute(args, ctx),
}

/** 规格表与执行器的合并视图，保持 buildMcpServer 的注册遍历不变。 */
const TOOL_SPECS: Record<string, ToolSpec> = Object.fromEntries(
  OPX_TOOL_SPECS.map((spec) => [spec.name, { description: spec.description, schema: spec.schema, execute: TOOL_EXECUTORS[spec.name]! }]),
)

/** 附加 _agent 身份参数到 P1 schema（仅 MCP 暴露层）。 */
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
