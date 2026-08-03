import { type Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { injectSkills } from "./skills.js"
import { injectAgents } from "./agents.js"
import { startDashboard } from "./dashboard.js"
import { OpenSpecCollector, AdoCollector, registerCollector, startPolling } from "../../core/workflow/index.js"

import {
  init,
  set_worktree,
  status,
  complete_task_group,
  set_unattended,
  agent_submit,
} from "./tools.js"

export const OpenspecOrchestratePlugin: Plugin = async (input) => {
  try {
    if (input?.worktree) {
      startDashboard(input.worktree)
      // 注册内置收集器（OpenSpec + ADO 占位）并启动定时拉取；worktree 为动态上下文在此注入。
      registerCollector(new OpenSpecCollector({ openspecDir: join(input.worktree, "openspec") }))
      registerCollector(new AdoCollector())
      startPolling(input.worktree)
    }
  } catch { /* dashboard/调度启动失败不影响编排功能 */ }

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
