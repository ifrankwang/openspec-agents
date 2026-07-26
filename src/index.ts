import { type Plugin, tool } from "@opencode-ai/plugin"
import { loadSkillBody } from "./skills/tool.js"
import { injectSkills } from "./skills/loader.js"
import { injectAgents } from "./agents/loader.js"
import { startDashboard } from "./dashboard/server.js"

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
} from "./tools/orchestrate.js"

export const OpenspecOrchestratePlugin: Plugin = async (input) => {
  // 启动编排进度看板（非阻塞，失败不影响工具注册）
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
      opx_skill: tool({
        description: "Load a bundled orchestration skill by name",
        args: {
          name: tool.schema.string().describe("Skill name loaded from standard OpenCode skill directories"),
        },
        async execute(args) {
          const body = loadSkillBody(args.name)
          return `## Skill: ${args.name}\n\n${body}`
        },
      }),
    },
  }
}
