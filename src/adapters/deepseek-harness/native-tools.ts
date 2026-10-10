/**
 * DeepSeek Harness 原生工具插件：把 6 个 opx_* 编排工具注册为 DSH 原生工具。
 *
 * 与 MCP 形态的根本差异（本次改造的核心）：
 * - MCP server 是常驻子进程，启动时只能拿到一份固定的 `--worktree`，与用户当前打开的项目无关；
 *   DSH 是「单 profile 全局装一份插件、多项目共用同一 MCP server 进程」，该固定目录指向
 *   `~/.dsh/profiles/desktop`，工具因此报「无法从 tasks.md 解析出任务组」。
 * - 原生工具在进程内执行，每次调用都能从 `exec.agent.session.header.cwd` 取到本次会话的项目目录，
 *   目录错配从根上消失（与官方文件工具同一机制，见 dsh-tool-fs/lib/index.js 的 sessionCwd）。
 *
 * 业务逻辑不重写：所有编排行为继续由 src/core/tools 下的 *Execute 承担，本文件只做三件事：
 * 注册名、参数 schema 投影、上下文注入。
 */
import type { ToolExecution } from "@deepseek-ai/dsh-tools"
import type { ToolContext } from "../../core/tools/types.ts"
import {
  initExecute, setWorktreeExecute, statusExecute,
  completeTaskGroupExecute, setUnattendedExecute,
} from "../../core/tools/lifecycle.ts"
import { agentSubmitExecute } from "../../core/tools/submit.ts"
import { readStateByWorktree, writeState } from "../../core/state.ts"
import { jsonSchemaToToolParameters, type ToolParameters } from "./schema-dsl.ts"
import { OPX_TOOL_SPECS, OPX_TOOL_NAMES } from "../tool-specs.ts"

/**
 * DSH 工具执行上下文（本插件只消费三处，均已在 DSH 0.2.0-rc.2 源码中核实）：
 * - agent.session.header.cwd：本次会话的项目目录（会话目录，非进程启动目录）；
 *   官方文件工具同机制，见 dsh-tool-fs/lib/index.js:161-173 的 sessionCwd。
 * - agent.id：与 agent.session.id 同值（dsh-agent/lib/index.js:510 的 enter() 校验）。
 * - signal：协作式取消信号。
 * 结构用 ambient 声明（src/types/dsh-runtime.d.ts）而非本地手写，避免与官方形状漂移。
 */
export type DshToolExec = Pick<ToolExecution, "agent" | "signal">

/** 编排主代理视角的固定身份（与 MCP 侧 resolveContext 缺省口径一致）。 */
export const PRIMARY_AGENT = "primary"

/**
 * 解析调用上下文。
 *
 * worktree 取会话项目目录：原生工具每次调用都拿到本次会话自己的 cwd，多项目共用同一插件进程时
 * 各自作用于各自的项目。
 *
 * 会话目录缺失时**不静默降级**：DSH 进程的 cwd 正是 profile 目录（如 ~/.dsh/profiles/desktop），
 * 恰是本次改造要消灭的那个错误目录——静默降级等于把原缺陷（状态写进错误目录且返回成功）以
 * 无人察觉的方式复现。故 agent 调用路径下取不到会话目录即明确报错，调用方无从「不知情地作用于
 * 错误目录」；唯一的例外是无 agent 上下文的非 agent 调用（DSH 运行时不会这样调用本工具），
 * 与官方 dsh-tool-fs 一样不在工具边界读进程 cwd 由后端兜底，此处后端即进程 cwd。
 *
 * agent 身份：DSH 未把子代理的注册名（如 openspec_architect）写入 Agent 或 session header——
 * Agent 只有 { id, options, session, inbox, status, ctx }（见 dsh-agent 的 Agent 接口声明），
 * subagent/descriptor 事件的 label 来自模型自填的 description（dsh-tool-subagent/lib/index.js:510），
 * 都不是稳定角色标识。因此按官方可判定的口径分流：
 * - 调用方通过 `_agent` 显式声明角色名（分派 prompt 中携带，与 MCP 形态同一范式）→ 采用声明值；
 * - 顶层会话未声明（orchestrator 的正常形态）→ 编排主代理视角（orchestrator: true），
 *   与 MCP 侧 `_agent` 缺省口径一致；
 * - 子会话未声明 → 无法判定角色，按编排视角放行但标记身份未声明，
 *   由 opx_status 视图输出身份补传提示（与 MCP 侧 identityDeclared 兜底同一机制）。
 */
export function resolveToolContext(
  exec: DshToolExec,
  args: Record<string, unknown>,
  opts: { processCwd: string },
): ToolContext {
  const worktree = resolveSessionWorktree(exec, opts.processCwd)
  const raw = args[AGENT_ARG]
  const declared = typeof raw === "string" ? raw : ""
  const agent = declared !== "" ? declared : PRIMARY_AGENT
  return {
    worktree,
    agent,
    orchestrator: agent === PRIMARY_AGENT,
    // 身份未显式声明时置 false：子代理首次查状态会落入编排视角，视图据此追加身份补传提示。
    // DSH 不暴露子代理的注册名给工具（见上），故此处只能声明「未声明」，无法替其推断角色。
    identityDeclared: declared !== "",
  }
}

/**
 * 解析本次调用的项目目录。
 * - 有 agent 上下文：只认 `agent.session.header.cwd`；缺失（undefined / 空串）即报错，
 *   绝不回落到进程 cwd（进程 cwd 是 DSH profile 目录，回落会把状态写进错误目录）。
 * - 无 agent 上下文（非 agent 调用）：回落进程 cwd，与官方 dsh-tool-fs 一样把兜底交给后端
 *   （本工具的后端就是进程自身）。
 */
export function resolveSessionWorktree(exec: DshToolExec, processCwd: string): string {
  const sessionCwd = exec.agent?.session.header.cwd
  if (typeof sessionCwd === "string" && sessionCwd !== "") return sessionCwd
  if (exec.agent) {
    throw new Error(
      "无法确定本次调用所属的项目目录：DSH 执行上下文未提供 agent.session.header.cwd（会话项目目录）。" +
        "进程启动目录是 DSH profile 目录（如 ~/.dsh/profiles/desktop），不是任何项目，继续执行会把编排状态写进错误目录，" +
        "因此本工具拒绝在缺会话目录时执行。请在项目会话中重新调用本工具。",
    )
  }
  return processCwd
}

/** 私有身份参数：下划线前缀表示非业务参数，与 MCP 形态的 `_agent` 同名同义。 */
export const AGENT_ARG = "_agent"

/**
 * 默认无人值守：DSH 形态保持与 MCP 侧一致的默认（DSH patch 分发时开启）。
 * 会话已初始化且 state.unattended 未设置时自动置 true；幂等，不覆盖用户显式关闭的会话。
 */
async function ensureDefaultUnattended(args: Record<string, unknown>, ctx: ToolContext): Promise<void> {
  const changeId = typeof args.change_id === "string" ? args.change_id : undefined
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

/**
 * 构造 6 个工具的 execute 包装：注入会话上下文与取消信号，业务逻辑直接委托给内核 *Execute。
 * @param unattended - 是否启用默认无人值守（DSH 分发形态为 true）
 * @param processCwd - 无 agent 上下文的非 agent 调用时的兜底目录（agent 调用缺会话目录即报错，不兜底）
 */
export function buildNativeToolExecutes(
  unattended: boolean,
  processCwd: string,
): Record<string, (args: Record<string, unknown>, exec: DshToolExec) => Promise<string>> {
  const wrap = (execute: (args: any, ctx: ToolContext) => Promise<string>) =>
    async (args: Record<string, unknown>, exec: DshToolExec): Promise<string> => {
      // 取消采用协作式：调度前已取消的调用不进入内核（与 DSH 官方工具一致的 ABORTED_BEFORE_DISPATCH 语义）。
      exec.signal?.throwIfAborted?.()
      const ctx = resolveToolContext(exec, args, { processCwd })
      // 私有身份参数不进入内核参数（内核校验的是纯业务 schema）。
      const cleanArgs: Record<string, unknown> = { ...args }
      delete cleanArgs[AGENT_ARG]
      if (unattended) await ensureDefaultUnattended(cleanArgs, ctx)
      const result = await execute(cleanArgs, ctx)
      if (unattended) await ensureDefaultUnattended(cleanArgs, ctx)
      return result
    }

  return {
    opx_orch_init: wrap((args, ctx) => initExecute(args, ctx)),
    opx_orch_set_worktree: wrap((args, ctx) => setWorktreeExecute(args, ctx)),
    opx_status: wrap((args, ctx) => statusExecute({ change_id: args.change_id as string }, ctx)),
    opx_orch_complete_task_group: wrap((args, ctx) => completeTaskGroupExecute(args, ctx)),
    opx_orch_set_unattended: wrap((args, ctx) => setUnattendedExecute(args, ctx)),
    opx_agent_submit: wrap((args, ctx) => agentSubmitExecute(args, ctx)),
  }
}

export interface NativeToolDefinition {
  name: string
  description: string
  parameters: ToolParameters
  output: { schema: { type: "string" }; render: (args: any, value: string) => { type: "text"; text: string }[] }
  execute: (args: Record<string, unknown>, exec: DshToolExec) => Promise<string>
}

/**
 * 组装 6 个 DSH 原生工具的完整定义（可直接交给 defineTool）。
 * 参数定义来自内核纯 JSON Schema（src/core/tools/schemas.ts），只做协议形态投影，不复制参数语义。
 */
export function buildNativeToolDefinitions(
  unattended: boolean,
  processCwd: string,
): NativeToolDefinition[] {
  const executes = buildNativeToolExecutes(unattended, processCwd)
  return OPX_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    // 附加 _agent 身份参数，与 MCP 形态对齐（子代理显式声明自身角色名）。
    parameters: withAgentArg(jsonSchemaToToolParameters(spec.schema)),
    output: {
      // 工具返回体一律 markdown 文本（见 AGENTS.md「工具返回体须为 markdown 格式」）。
      schema: { type: "string" as const },
      render: (_args: any, value: string) => [{ type: "text" as const, text: value }],
    },
    execute: executes[spec.name]!,
  }))
}

/** 附加 _agent 身份参数（仅暴露层，模型侧可见；内核执行前会剔除）。 */
function withAgentArg(parameters: ToolParameters): ToolParameters {
  return {
    ...parameters,
    [AGENT_ARG]: {
      type: "string",
      description:
        "调用者 agent 标识（子代理调用时传自身角色名，如 openspec-reviewer-tool；缺省为编排主代理视角）",
    },
  }
}

export { OPX_TOOL_NAMES }