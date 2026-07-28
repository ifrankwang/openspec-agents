import { type Plugin } from "@opencode-ai/plugin"
import { injectSkills } from "./skills.js"
import { injectAgents } from "./agents.js"
import { startDashboard } from "./dashboard.js"

import {
  init,
  set_worktree,
  status,
  complete_task_group,
  set_unattended,
  arch_submit,
  arch_blocker,
  dev_submit,
  tool_review_submit,
  task_review_submit,
  quality_review_submit,
  resolve_review,
} from "./tools.js"

export const OpenspecOrchestratePlugin: Plugin = async (input) => {
  try {
    if (input?.worktree) startDashboard(input.worktree)
  } catch { /* dashboard 启动失败不影响编排功能 */ }

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
      opx_arch_submit: arch_submit,
      opx_arch_blocker: arch_blocker,
      opx_dev_submit: dev_submit,
      opx_tool_review_submit: tool_review_submit,
      opx_task_review_submit: task_review_submit,
      opx_quality_review_submit: quality_review_submit,
      opx_orch_resolve_review: resolve_review,
    },
  }
}
