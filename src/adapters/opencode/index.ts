import { type Plugin } from "@opencode-ai/plugin"
import { injectSkills } from "./skills.ts"
import { injectAgents } from "./agents.ts"

import {
  init,
  set_worktree,
  status,
  complete_task_group,
  set_unattended,
  agent_submit,
} from "./tools.ts"

/**
 * OpenCode 插件壳（兼容过渡入口）：配置注入（agent/skill）+ 工具直载。
 * dashboard/collector/poller 副作用已迁移至 MCP server 进程（src/adapters/mcp-common/），
 * OpenCode 建议切换为 MCP client 形态接入；插件壳保留兼容直到双轨验证完成。
 */
export const OpenspecOrchestratePlugin: Plugin = async (input) => {
  return {
    config: async (config) => {
      injectAgents(config)
      injectSkills(config)
    },
    tool: {
      opx_orch_init: init,
      opx_orch_set_worktree: set_worktree,
      opx_status: status,
      opx_orch_complete_task_group: complete_task_group,
      opx_orch_set_unattended: set_unattended,
      opx_agent_submit: agent_submit,
    },
  }
}
