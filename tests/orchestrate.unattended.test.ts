import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import {
  init, status, set_unattended,
} from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWithFakeGit, teardown, readState } from "./helpers"
import { setupToAnalyze, driveToVerifyTool } from "./helpers-workflow"
import {
  createInitialWorkItem, checkpointTriggered, effectiveMaxRetries,
} from "../src/core/workflow/engine"
import { loadWorkflowFile, TASK_WORKFLOW_PATH } from "../src/core/workflow/loader"

const CID = "test-unattended"

afterAll(() => { __setGitRunner(null) })

function freshWt(root: string): string {
  const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = join(root, id, "w")
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n\n## 2. G2\n\n- [ ] 2.1 T3\n`,
    "utf-8"
  )
  return wt
}

/** 从 state 取 task WorkItem。 */
function taskItemOf(wt: string): any {
  const state = readState(wt, CID)
  return state?.workItems?.find((w: any) => w.id === "task:1")
}

// ───── Test 1: set_unattended sets/clears flag ─────

describe("T1: set_unattended tool", () => {
  test("sets unattended=true", async () => {
    const root = `/tmp/ut1-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const o = makeOrchCtx(wt)

      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await set_unattended.execute({ change_id: CID, enabled: true }, o)

      const state = readState(wt, CID)
      expect(state.unattended).toBe(true)
    } finally { teardown(root) }
  })

  test("enabled 缺省（default=true）与显式传值语义一致", async () => {
    const root = `/tmp/ut1b-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const o = makeOrchCtx(wt)

      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await set_unattended.execute({ change_id: CID }, o)

      const state = readState(wt, CID)
      expect(state.unattended).toBe(true)
    } finally { teardown(root) }
  })

  test("clears unattended=false", async () => {
    const root = `/tmp/ut2-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const o = makeOrchCtx(wt)

      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await set_unattended.execute({ change_id: CID, enabled: true }, o)
      await set_unattended.execute({ change_id: CID, enabled: false }, o)

      const state = readState(wt, CID)
      expect(state.unattended).toBe(false)
    } finally { teardown(root) }
  })

  test("orchestrator-only: non-orchestrator gets error", async () => {
    const root = `/tmp/ut3-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const o = makeOrchCtx(wt)
      const d = makeCtx("openspec-developer", wt)

      await init.execute({ change_id: CID, task_group_id: "1" }, o)

      try {
        await set_unattended.execute({ change_id: CID, enabled: true }, d)
        expect.unreachable("should have thrown")
      } catch (e: any) {
        expect(e.message).toContain("仅限编排者")
      }
    } finally { teardown(root) }
  })

  test("architect analyze 视图渲染确认模式：有人值守/无人值守切换", async () => {
    const root = `/tmp/ut-mode-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const ctx = await setupToAnalyze(wt, CID)

      // 默认有人值守：视图渲染「确认模式」且标识为有人值守
      const out1 = await status.execute({ change_id: CID }, ctx.arch)
      expect(out1).toContain("## 确认模式")
      expect(out1).toContain("当前：**有人值守**")
      expect(out1).not.toContain("当前：**无人值守**")

      // 开启无人值守：视图切换为无人值守标识（架构师据此自行裁决）
      await set_unattended.execute({ change_id: CID, enabled: true }, ctx.orch)
      const out2 = await status.execute({ change_id: CID }, ctx.arch)
      expect(out2).toContain("## 确认模式")
      expect(out2).toContain("当前：**无人值守**")
      expect(out2).not.toContain("当前：**有人值守**")
    } finally { teardown(root) }
  })
})

// ───── Test 2: checkpoint 时 unattended 行为（新流：检查点由引擎触发，不因 unattended 抑制）─────

describe("T2: checkpoint 时 unattended 行为", () => {
  test("unattended 开启下检查点仍由引擎触发：opx_status 渲染检查点视图", async () => {
    const root = `/tmp/ut4-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      await setupToAnalyze(wt, CID)
      await driveToVerifyTool(wt, CID)
      expect(taskItemOf(wt).currentStep).toBe("verify_tool")

      // 注入未终态 child + retryCount 达上限 → 检查点态
      const state = readState(wt, CID)
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.metadata["_retryCount"] = 10
      item.children.push({
        id: "issue:7", externalId: "7", source: "openspec", type: "issue",
        title: "遗留 issue", description: "d", phase: "todo", suspended: false,
        currentStep: null, tags: {}, metadata: {}, children: [], labels: [], severity: "Low",
      })
      const p = join(wt, "openspec", "states", `${CID}.json`)
      writeFileSync(p, JSON.stringify(state, null, 2))

      const o = makeOrchCtx(wt)
      await set_unattended.execute({ change_id: CID, enabled: true }, o)

      const output = await status.execute({ change_id: CID }, o)
      // 检查点视图（unattended 不抑制）
      expect(output).toContain("检查点")
      expect(output).toContain("continue / giveup")
      expect(output).toContain("checkpoint_decision")
    } finally { teardown(root) }
  })

  test("引擎 checkpointTriggered 判定与 unattended 无关（retry 达上限 + 未终态 children）", async () => {
    const root = `/tmp/ut5-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      await setupToAnalyze(wt, CID)
      await driveToVerifyTool(wt, CID)

      const state = readState(wt, CID)
      const item = state.workItems.find((w: any) => w.id === "task:1")
      item.metadata["_retryCount"] = 10
      item.children.push({
        id: "issue:7", externalId: "7", source: "openspec", type: "issue",
        title: "遗留 issue", description: "d", phase: "todo", suspended: false,
        currentStep: null, tags: {}, metadata: {}, children: [], labels: [], severity: "Low",
      })
      const p = join(wt, "openspec", "states", `${CID}.json`)
      writeFileSync(p, JSON.stringify(state, null, 2))

      const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
      const step = workflow.stepMap.get("verify_tool")!.step
      expect(checkpointTriggered(item, workflow, step)).toBe(true)
      expect(effectiveMaxRetries(workflow, step)).toBe(10)

      // 关闭 unattended 后判定不变（引擎按 retry 计数，与无人值守标志无关）
      const o = makeOrchCtx(wt)
      await set_unattended.execute({ change_id: CID, enabled: false }, o)
      const again = JSON.parse(readFileSync(p, "utf-8"))
      const item2 = again.workItems.find((w: any) => w.id === "task:1")
      expect(checkpointTriggered(item2, workflow, step)).toBe(true)
    } finally { teardown(root) }
  })
})

// ───── Test 5: 引擎 checkpointTriggered / effectiveMaxRetries（替代已删 handleRetryCheckpoint）─────

describe("T5: checkpointTriggered / effectiveMaxRetries", () => {
  const workflow = loadWorkflowFile(TASK_WORKFLOW_PATH)
  const step = workflow.stepMap.get("verify_tool")!.step

  /** 构造含 child 的 WorkItem（hasUnresolvedChildren 由 children 相位决定）。 */
  function itemWithChildren(resolvedAll: boolean): any {
    const item = createInitialWorkItem({
      id: "task:1", source: "openspec", externalId: "1", type: "task",
      title: "G1", description: "G1",
    })
    if (!resolvedAll) {
      item.children.push({
        id: "issue:7", externalId: "7", source: "openspec", type: "issue",
        title: "遗留 issue", description: "d", phase: "todo", suspended: false,
        currentStep: null, tags: {}, metadata: {}, children: [], labels: [], severity: "Low",
      })
    }
    return item
  }

  test("retryCount=0 → 不触发检查点", () => {
    const item = itemWithChildren(false)
    expect(checkpointTriggered(item, workflow, step)).toBe(false)
  })

  test("retryCount 未达上限 → 不触发检查点", () => {
    const item = itemWithChildren(false)
    item.metadata["_retryCount"] = 3
    expect(checkpointTriggered(item, workflow, step)).toBe(false)
  })

  test("retryCount 达上限且存在未终态 children → 触发检查点", () => {
    const item = itemWithChildren(false)
    item.metadata["_retryCount"] = 10
    expect(checkpointTriggered(item, workflow, step)).toBe(true)
  })

  test("retryCount 达上限但全部 children 已终态 → 不触发", () => {
    const item = itemWithChildren(true)
    item.metadata["_retryCount"] = 10
    expect(checkpointTriggered(item, workflow, step)).toBe(false)
  })

  test("effectiveMaxRetries：step 无 max_retries 时回退 workflow.max_retries", () => {
    const wf = { ...workflow, max_retries: 5 } as any
    const s = { ...step, max_retries: undefined } as any
    expect(effectiveMaxRetries(wf, s)).toBe(5)
  })

  test("effectiveMaxRetries：step 声明 max_retries 时优先", () => {
    const wf = { ...workflow, max_retries: 5 } as any
    const s = { ...step, max_retries: 3 } as any
    expect(effectiveMaxRetries(wf, s)).toBe(3)
  })
})
