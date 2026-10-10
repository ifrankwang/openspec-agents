/**
 * DSH cordis 插件入口：把 6 个 opx_* 编排工具注册进 DSH 原生工具注册表。
 *
 * 挂载方式：bundle 的 cordis.patch.yml 以 `insert` 插入本包（与官方 dsh-skill-filesystem 等行同构）。
 * 本文件由 `bun build --target node` 打成单文件 `.dsh-plugin/opx-tools.mjs` 随包分发，
 * `@deepseek-ai/*` 保持 external——插件在 profile 的 node_modules 下被 cordis import 时，
 * 这些官方包由 DSH 安装目录的 node_modules 提供，不随本包分发。
 *
 * cordis 插件契约三处缺一不可（官方 dsh-tool-skill / dsh-tool-fs / dsh-mcp-client 同形）：
 * - `Config` 必须是 Standard Schema（schemastery 构造）——cordis 直接取 `Config["~standard"].validate`，
 *   普通对象会在加载期崩于 `Cannot read properties of undefined (reading 'validate')`；
 * - `inject` 必须声明 apply 内访问的服务——fiber 的上下文代理对未 inject 的属性访问抛
 *   `cannot get property "tools" without inject`；
 * - 导出形态为命名导出 `{ Config, apply, inject, name }`，由 loaders 的 unwrapExports 直接取插件对象。
 *
 * 与 MCP 形态的差异只有「工具在谁进程里跑」：
 * - MCP：常驻子进程，worktree 与身份都靠启动参数/入参传入，多项目共用一个进程 → 目录与项目无关；
 * - 原生：本进程，每次调用从 exec 注入的会话上下文取 worktree 与取消信号，多项目天然隔离。
 */
import z from "@deepseek-ai/schemastery"
import { defineTool, type ToolExecution } from "@deepseek-ai/dsh-tools"
import { buildNativeToolDefinitions, type DshToolExec } from "./native-tools.ts"

/** DSH 插件配置：cordis 按 Standard Schema 校验并注入默认值。默认无人值守与 MCP 侧 --unattended 同口径。 */
const Config = z.object({
  /** 默认无人值守：会话已初始化且未显式设置时自动开启。默认 true，与 MCP 侧 --unattended 同口径。 */
  unattended: z.boolean().default(true),
})

/** cordis 插件名。 */
const name = "openspec-opx-tools"

/** cordis 依赖声明：apply 内访问 ctx.tools，未声明即抛「cannot get property "tools" without inject」。 */
const inject = ["tools"]

/**
 * 插件主体：注册 6 个 opx_* 原生工具。
 *
 * worktree 每次调用从 `exec.agent.session.header.cwd` 取会话项目目录（该字段缺失即报错，不静默回落进程 cwd）；
 * `exec.signal` 在每次调用入口检查取消；调用者身份由 `_agent` 入参声明（缺省=编排主代理视角）。
 */
function apply(ctx: any, config: { unattended?: boolean } = {}): void {
  const unattended = config.unattended !== false
  // 进程 cwd 仅用于「无 agent 上下文的非 agent 调用」兜底；agent 调用缺会话目录时工具直接报错。
  const processCwd = process.cwd()
  for (const spec of buildNativeToolDefinitions(unattended, processCwd)) {
    ctx.tools.register(
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: spec.output,
        async execute(args: any, exec: ToolExecution) {
          return await spec.execute(args as Record<string, unknown>, exec as unknown as DshToolExec)
        },
      }),
    )
  }
}

export { Config, apply, inject, name }
