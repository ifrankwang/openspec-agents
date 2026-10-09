import type { Plugin } from "@opencode/plugin"
import { resolve } from "../agent-md.ts"
import { collectSkills, type SkillRegistration } from "./skills.ts"
import { writeAgents } from "./agents.ts"

/**
 * OpenCode V2 插件壳：MCP server 注册 + skill 注册 + 子代理文件投放。
 *
 * V2 插件以默认导出 { id, setup } 生效，setup 内按域注册，不再持有全局配置对象：
 * - MCP server 走 mcp 域 transform 声明（local + stdio command 数组），opx_* 工具由此暴露，
 *   身份统一由 mcp-common 的 `_agent` 参数解析（缺省视为编排视角）；
 * - 随包 skill 走 skill 域 transform 逐项注册，path 指向包内 SKILL.md 以保留附属文件基准；
 * - 子代理以文件形式投放至项目 `.opencode/agents/`（V2 插件接口无新增 agent 的能力）。
 *
 * dashboard/collector/poller 副作用由 MCP server 进程承担（src/adapters/mcp-common/），
 * 插件壳不启动任何后台任务。
 *
 * 插件 ID 稳定为 openspec-agents：V2 以该 ID 标识插件、隔离其持久化存储，并用于配置中的
 * 启用/禁用前缀匹配。
 */
export const OPENCODE_PLUGIN_ID = "openspec-agents"

/**
 * 构造 opx MCP server 配置。入口为包内 .mcp-server/cli.mjs（prepack 构建的自包含 bundle），
 * --worktree 指向当前加载本插件的项目根（ctx.location.directory），dashboard/collector 副作用
 * 与状态读写均以此为根。
 */
function mcpServerConfig(projectRoot: string) {
  return {
    type: "local" as const,
    command: [
      "node",
      resolve(".mcp-server", "cli.mjs"),
      "--transport",
      "stdio",
      "--worktree",
      projectRoot,
      "--unattended",
      "--strip-opx-prefix",
    ],
  }
}

const plugin: Plugin.Plugin = {
  id: OPENCODE_PLUGIN_ID,
  async setup(ctx) {
    const projectRoot = ctx.location.directory

    await ctx.mcp.transform((editor) => {
      editor.set("opx", mcpServerConfig(projectRoot))
    })

    await ctx.skill.transform((editor) => {
      for (const skill of collectSkills()) {
        editor.add(skill)
      }
    })

    writeAgents(projectRoot)
  },
}

export default plugin