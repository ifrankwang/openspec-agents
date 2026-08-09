/**
 * 新流（workItems 单轨）测试基建助手。
 *
 * 与 tests/helpers.ts 分工：helpers.ts 保持不动（FakeGitRunner/makeCtx/readState/
 * setupWorkspace/setupWithFakeGit/teardown），本文件在其之上提供新流测试专用基建：
 *
 * 1. WorkItem 纯投影读取：taskItemOf/taskListOf/blockersOf/metaOf
 * 2. 阶段驱动：setupToAnalyze/driveToImplement/driveToVerifyTool/driveToVerifyTask/driveToQuality
 *    —— 全部经 opx_agent_submit.execute 驱动状态机，按 step 门禁自动补齐参数
 *
 * 约定：
 * - 调用前需先 setupWorkspace + __setGitRunner(FakeGitRunner)（或 setupWithFakeGit）
 * - task_group_id 默认 "1"，可通过 opts.groupId 覆盖
 * - worktree 指状态文件所在 repo 根（非 .worktree 子目录）；setupToAnalyze 自动补调 set_worktree
 *   使 worktree 就绪，需 worktree/branch 元数据的用例无需自行调用
 */
import type { ToolContext } from "@opencode-ai/plugin"
import type { WorkItem } from "../src/core/workflow/types"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadWorkflow } from "../src/core/workflow/loader"
import { renderWorkflowStatusView } from "../src/core/workflow/status"
import { taskListOf as projectTaskList } from "../src/core/task-children"
import { init, agent_submit, set_worktree } from "../src/adapters/opencode/tools"
import { makeCtx, readState } from "./helpers"

export type Ctx = ReturnType<typeof makeCtx>

export interface AgentCtx {
  orch: Ctx
  arch: Ctx
  dev: Ctx
  toolR: Ctx
  taskR: Ctx
  dims: Record<string, Ctx>
}

export const DIMENSION_AGENTS = [
  "style",
  "architecture",
  "performance",
  "security",
  "maintainability",
] as const

export const DEFAULT_EXECUTION_BOUNDARY = {
  allowed_directories: ["src"],
  allowed_packages: ["com.t"],
  notes: "",
}

export interface DriveOpts {
  groupId?: string
  recovery?: { phase: string; review_layer?: "tool" | "task" | "quality"; reopenIssues?: boolean }
  boundary?: unknown
  completedTaskIds?: string[]
  verifiedTasks?: string[]
}

// ─── WorkItem 纯投影读取 ───

/** 从 state 取 task WorkItem（id="task:{groupId}"，缺省组 "1"）。 */
export function taskItemOf(state: any, groupId = "1"): WorkItem {
  return state?.workItems?.find((w: any) => w.id === `task:${groupId}`)
}

/** 取 WorkItem 的 task 清单（从 children 投影 task child，TaskStatus 由 phase 反查）。 */
export function taskListOf(item: any): any[] {
  return projectTaskList(item as any) as any[]
}

/** 取 WorkItem 的 metadata.blockers。 */
export function blockersOf(item: any): any[] {
  return Array.isArray(item?.metadata?.blockers) ? (item.metadata.blockers as any[]) : []
}

/** 取 WorkItem 的 metadata 字段。 */
export function metaOf(item: any, key: string): any {
  return item?.metadata?.[key]
}

/** 从状态文件读取当前 task WorkItem（未初始化返回 undefined）。 */
export function readItem(wt: string, cid: string, groupId = "1"): any {
  const state = readState(wt, cid)
  return state ? taskItemOf(state, groupId) : undefined
}

/** task 清单的 id 列表（供 completed_task_ids / verified_tasks 默认值）。 */
export function taskIdsOf(item: any): string[] {
  return taskListOf(item).map((t: any) => t.id)
}

/** 直接渲染 working 视图（读取仓库 task.yaml，聚焦 status 渲染逻辑；options 透传给 WorkflowStatusViewOptions）。 */
export function renderWorkingView(item: any, stepId: string, agent: string, options: Record<string, unknown> = {}): string {
  const workflow = loadWorkflow(readFileSync(join(import.meta.dir, "../assets/workflows/task.yaml"), "utf8"))
  const state = {
    changeId: "cid", isolationNamespace: "ns", taskGroupId: "1", baseBranch: "main",
    workItems: [item], createdAt: "", updatedAt: "",
  }
  const tg = { worktreePath: "/wt", branchName: "b", baseRef: "base" }
  return renderWorkflowStatusView(
    item,
    workflow,
    { status: "recommend", stepId, agents: [agent] },
    agent,
    { state, tg, ...options } as any,
  )
}

// ─── 阶段驱动助手 ───

/** 构造全部角色 ctx（agent 名与 task.yaml step.agents 一致）。 */
export function makeAgentCtxs(wt: string): AgentCtx {
  return {
    orch: makeCtx("openspec-orchestrator", wt),
    arch: makeCtx("openspec-architect", wt),
    dev: makeCtx("openspec-developer", wt),
    toolR: makeCtx("openspec-reviewer-tool", wt),
    taskR: makeCtx("openspec-reviewer-task", wt),
    dims: Object.fromEntries(
      DIMENSION_AGENTS.map((d) => [d, makeCtx(`openspec-reviewer-${d}`, wt)])
    ) as Record<string, Ctx>,
  }
}

/** 初始化到 todo/analyze（无 recovery 时 init 构造 task WorkItem 置 todo/analyze），并补一次 set_worktree 使 worktree 就绪。 */
export async function setupToAnalyze(wt: string, cid: string, opts: { groupId?: string; recovery?: DriveOpts["recovery"] } = {}): Promise<AgentCtx> {
  const ctx = makeAgentCtxs(wt)
  const params: Record<string, unknown> = { change_id: cid, task_group_id: opts.groupId ?? "1" }
  if (opts.recovery) params.recovery = opts.recovery
  await init.execute(params as any, ctx.orch)
  await set_worktree.execute({ change_id: cid }, ctx.orch)
  return ctx
}

/** 驱动到 implement（analyze passed，task 进入 in_progress/implement）。 */
export async function driveToImplement(wt: string, cid: string, opts: DriveOpts = {}): Promise<{ ctx: AgentCtx; item: any }> {
  const ctx = await setupToAnalyze(wt, cid, opts)
  await agent_submit.execute(
    {
      change_id: cid,
      step_id: "analyze",
      verdict: "passed",
      execution_boundary: opts.boundary ?? DEFAULT_EXECUTION_BOUNDARY,
    },
    ctx.arch
  )
  return { ctx, item: readItem(wt, cid, opts.groupId ?? "1") }
}

/** 驱动到 verify_tool（implement passed，task 进入 review/verify_tool）。 */
export async function driveToVerifyTool(wt: string, cid: string, opts: DriveOpts = {}): Promise<{ ctx: AgentCtx; item: any }> {
  const { ctx } = await driveToImplement(wt, cid, opts)
  const item0 = readItem(wt, cid, opts.groupId ?? "1")
  await agent_submit.execute(
    {
      change_id: cid,
      step_id: "implement",
      verdict: "passed",
      completed_task_ids: opts.completedTaskIds ?? taskIdsOf(item0),
    },
    ctx.dev
  )
  return { ctx, item: readItem(wt, cid, opts.groupId ?? "1") }
}

/** 驱动到 verify_task（verify_tool passed）。 */
export async function driveToVerifyTask(wt: string, cid: string, opts: DriveOpts = {}): Promise<{ ctx: AgentCtx; item: any }> {
  const { ctx } = await driveToVerifyTool(wt, cid, opts)
  await agent_submit.execute({ change_id: cid, step_id: "verify_tool", verdict: "passed" }, ctx.toolR)
  return { ctx, item: readItem(wt, cid, opts.groupId ?? "1") }
}

/** 驱动到 verify_quality（verify_task passed，task 停在 review/verify_quality）。 */
export async function driveToQuality(wt: string, cid: string, opts: DriveOpts = {}): Promise<{ ctx: AgentCtx; item: any }> {
  const { ctx } = await driveToVerifyTask(wt, cid, opts)
  const item0 = readItem(wt, cid, opts.groupId ?? "1")
  await agent_submit.execute(
    {
      change_id: cid,
      step_id: "verify_task",
      verdict: "passed",
      verified_tasks: opts.verifiedTasks ?? taskIdsOf(item0),
    },
    ctx.taskR
  )
  return { ctx, item: readItem(wt, cid, opts.groupId ?? "1") }
}

/** 5 维 quality reviewer 逐一提交 verify_quality passed，推进到 done（配合 driveToQuality 使用）。 */
export async function submitQualityPassed(ctx: AgentCtx, cid: string): Promise<void> {
  for (const d of DIMENSION_AGENTS) {
    await agent_submit.execute({ change_id: cid, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
  }
}

/**
 * 触发 verify_quality 聚合回退：failedDim 维提交 failed（可带 new_children），其余维度依次提交 passed。
 * verify_quality 为多 agent step，须全部 5 维已裁决（非 pending）才触发 on_fail 回退 implement。
 */
export async function rollbackQuality(
  ctx: AgentCtx,
  cid: string,
  opts: { failedDim: string; newChildren?: unknown[] },
): Promise<void> {
  const failedParams: Record<string, unknown> = { change_id: cid, step_id: "verify_quality", verdict: "failed" }
  if (opts.newChildren?.length) failedParams.new_children = opts.newChildren
  await agent_submit.execute(failedParams as any, ctx.dims[opts.failedDim])
  for (const d of DIMENSION_AGENTS) {
    if (d === opts.failedDim) continue
    await agent_submit.execute({ change_id: cid, step_id: "verify_quality", verdict: "passed" }, ctx.dims[d])
  }
}
