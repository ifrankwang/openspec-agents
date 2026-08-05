/**
 * 状态异常（phase ↔ step 归属错位）防护测试
 *
 * 覆盖场景：
 * M1  错位态（phase=in_progress + currentStep=verify_tool）下被调度 reviewer 渲染 ⛔ 拒绝视图且含 recovery 指引
 * M2  错位态下非被调度 agent 也渲染拒绝视图
 * M3  错位态下 orchestrator 分派视图含 ⚠️ 状态异常诊断
 * M4  currentStep 指向未声明 step（resolveCurrentStep 返 null）→ 拒绝视图
 * M5  错位态下 submit 抛错且 snapshot 零变更
 * M6  反方向错位（phase=review + currentStep=implement）submit 拦截
 * M7  in_progress/implement 一致态正常 ✅（不回归）
 * M8  review/verify_tool 一致态正常 ✅（不回归）
 * M9  currentStep=null（todo 初始态）不误报且提交放行
 */
import { describe, expect, test, afterAll } from "bun:test"
import { writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, status, agent_submit } from "../src/adapters/opencode/tools"
import { loadWorkflowFile, TASK_WORKFLOW_PATH } from "../src/core/workflow/loader"
import { phaseStepMismatch } from "../src/core/workflow/engine"
import { FakeGitRunner, setupWithFakeGit, teardown } from "./helpers"
import {
  setupToAnalyze, driveToImplement, driveToVerifyTool, readItem, DEFAULT_EXECUTION_BOUNDARY,
} from "./helpers-workflow"

const CID = "test-state-mismatch"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/sm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function statePath(wt: string): string {
  return join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
}

/** 直接改写活跃 task WorkItem（手工构造前置状态用）。 */
function rewriteItem(wt: string, mutate: (item: any) => void): void {
  const p = statePath(wt)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

/** 捕获抛错并断言错误文案。 */
async function expectError(p: Promise<unknown>, pattern: RegExp): Promise<Error> {
  const err = await p.catch((e: Error) => e)
  expect(err).toBeInstanceOf(Error)
  expect(err.message).toMatch(pattern)
  return err
}

/** 构造错位态：把 task WorkItem 的 phase 与 currentStep 归属拆开（currentStep 不变，phase 改为不匹配值）。 */
function breakPhase(wt: string, phase: string): void {
  rewriteItem(wt, (item) => { item.phase = phase })
}

describe("状态异常拒绝视图", () => {
  test("M1. 错位态（in_progress + verify_tool）下被调度 reviewer 渲染拒绝视图且含 recovery 指引", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      breakPhase(wt, "in_progress")
      const view = await status.execute({ change_id: CID }, ctx.toolR)
      expect(view).toContain("# ⛔ 状态异常，当前拒绝执行")
      expect(view).toContain("phase ↔ step 错位")
      expect(view).toContain("opx_orch_init(recovery=...)")
      expect(view).not.toContain("# ✅ 当前轮到你执行")
    } finally { teardown(root) }
  })

  test("M2. 错位态下非被调度 agent 也渲染拒绝视图", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      breakPhase(wt, "in_progress")
      const devView = await status.execute({ change_id: CID }, ctx.dev)
      expect(devView).toContain("# ⛔ 状态异常，当前拒绝执行")
      expect(devView).not.toContain("# ⛔ 阶段门禁")
    } finally { teardown(root) }
  })

  test("M3. 错位态下 orchestrator 分派视图含 ⚠️ 状态异常诊断", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      breakPhase(wt, "in_progress")
      const view = await status.execute({ change_id: CID }, ctx.orch)
      expect(view).toContain("# 编排进度")
      expect(view).toContain("⚠️ 状态异常")
      expect(view).toContain("step 预期归属阶段")
      expect(view).toContain("`review`")
      expect(view).toContain("opx_orch_init(recovery=...)")
    } finally { teardown(root) }
  })

  test("M4. currentStep 指向未声明 step → 拒绝视图", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      rewriteItem(wt, (item) => { item.phase = "in_progress"; item.currentStep = "ghost_step" })
      const view = await status.execute({ change_id: CID }, ctx.toolR)
      expect(view).toContain("# ⛔ 状态异常，当前拒绝执行")
      expect(view).toContain("`ghost_step`")
      expect(view).toContain("opx_orch_init(recovery=...)")
    } finally { teardown(root) }
  })

  test("M5. 错位态下 submit 抛错且 snapshot 零变更", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      breakPhase(wt, "in_progress")
      const before = readFileSync(statePath(wt), "utf-8")
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "verify_tool", verdict: "passed" }, ctx.toolR),
        /phase ↔ step 错位/
      )
      const after = readFileSync(statePath(wt), "utf-8")
      expect(after).toBe(before)
    } finally { teardown(root) }
  })

  test("M6. 反方向错位（review + implement）submit 拦截", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      rewriteItem(wt, (item) => { item.phase = "review"; item.currentStep = "implement" })
      await expectError(
        agent_submit.execute({ change_id: CID, step_id: "implement", verdict: "passed" }, ctx.dev),
        /phase ↔ step 错位/
      )
    } finally { teardown(root) }
  })

  test("M7. in_progress/implement 一致态正常 ✅（不回归）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
      expect(phaseStepMismatch(readItem(wt, CID), workflow)).toBe(false)
      const devView = await status.execute({ change_id: CID }, ctx.dev)
      expect(devView).toContain("# ✅ 当前轮到你执行")
      expect(devView).not.toContain("状态异常")
    } finally { teardown(root) }
  })

  test("M8. review/verify_tool 一致态正常 ✅（不回归）", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToVerifyTool(wt, CID)
      const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
      expect(phaseStepMismatch(readItem(wt, CID), workflow)).toBe(false)
      const toolView = await status.execute({ change_id: CID }, ctx.toolR)
      expect(toolView).toContain("# ✅ 当前轮到你执行")
      expect(toolView).not.toContain("状态异常")
    } finally { teardown(root) }
  })

  test("M9. currentStep=null（todo 初始态）不误报且提交放行", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      rewriteItem(wt, (item) => { item.currentStep = null })
      const item = readItem(wt, CID)
      expect(item.phase).toBe("todo")
      expect(item.currentStep).toBeNull()
      const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
      expect(phaseStepMismatch(item, workflow)).toBe(false)
      const archView = await status.execute({ change_id: CID }, ctx.arch)
      expect(archView).toContain("# ✅ 当前轮到你执行")
      expect(archView).not.toContain("状态异常")
      await agent_submit.execute(
        { change_id: CID, step_id: "analyze", verdict: "passed", execution_boundary: DEFAULT_EXECUTION_BOUNDARY },
        ctx.arch
      )
      expect(readItem(wt, CID).phase).toBe("in_progress")
    } finally { teardown(root) }
  })
})
