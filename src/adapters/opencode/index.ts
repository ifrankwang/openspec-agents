import { type Plugin } from "@opencode-ai/plugin"
import { injectSkills } from "./skills.ts"
import { injectAgents } from "./agents.ts"
import { resolve } from "../agent-md.ts"

/**
 * OpenCode 插件壳（MCP 形态）：配置注入（agent/skill）+ MCP server 配置注入（config.mcp）。
 * 直载工具注册已移除（BREAKING，change agent-merge-and-mode-config 组 5.1）：
 * - opx_* 工具统一经 MCP server 暴露（stdio bundle，--worktree 指向当前项目根），
 *   与 claude-code / zcode / codex 插件的 .mcp.json 形态一致；
 * - 身份不再由会话运行时推导，统一走 mcp-common 的 `_agent` 参数解析（缺省视为编排视角）。
 * dashboard/collector/poller 副作用已迁移至 MCP server 进程（src/adapters/mcp-common/）。
 */
export const OpenspecOrchestratePlugin: Plugin = async (input) => {
  return {
    config: async (config) => {
      injectAgents(config)
      injectSkills(config)
      // MCP server 声明：opencode config 的 mcp 段（官方形态
      // { mcp: { <server>: { type: "local", command: [...] } } }，见 opencode docs/mcp-servers）。
      // 入口为包内 .mcp-server/cli.mjs（prepack 构建的 MCP server 自包含 bundle），
      // --worktree 指向当前项目根（input.worktree 即 opencode 打开的 git worktree 路径）。
      config.mcp = {
        ...(config.mcp ?? {}),
        opx: {
          type: "local",
          command: [
            "node",
            resolve(".mcp-server", "cli.mjs"),
            "--transport",
            "stdio",
            "--worktree",
            input.worktree,
            "--unattended",
            "--strip-opx-prefix",
          ],
        },
      }
    },
  }
}
