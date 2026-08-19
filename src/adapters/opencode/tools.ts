/**
 * OpenCode 直载工具注册已移除（BREAKING，change agent-merge-and-mode-config 组 5.1）：
 * - 插件壳不再直载 opx_* 工具，统一经 MCP server 配置（config.mcp，stdio bundle）暴露；
 * - 身份不再由会话运行时推导（makeCtx 与 isPrimaryAgent 判定已删），统一走 mcp-common 的 `_agent` 参数解析。
 * 本文件仅保留测试直调核心 execute 的无状态透传壳（不注册 OpenCode 工具、无身份推导），
 * 调用方（tests/ 既有用例）显式构造 ToolContext 传入。
 */
import {
  initExecute, setWorktreeExecute, statusExecute,
  completeTaskGroupExecute, setUnattendedExecute,
} from "../../core/tools/lifecycle.ts"
import { agentSubmitExecute } from "../../core/tools/submit.ts"

export const init = { execute: initExecute }
export const set_worktree = { execute: setWorktreeExecute }
export const status = { execute: statusExecute }
export const complete_task_group = { execute: completeTaskGroupExecute }
export const set_unattended = { execute: setUnattendedExecute }
export const agent_submit = { execute: agentSubmitExecute }
