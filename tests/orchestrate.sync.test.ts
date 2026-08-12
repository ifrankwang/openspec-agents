/**
 * syncTaskChildren 断根修复 + 推进失败显式化回归测试。
 *
 * 覆盖：
 * 1. 组切换 1→2→1 多次 init 不产生重复 task children
 * 2. recovery（dev_impl / review / task_analysis，forceOpen 与非 forceOpen）不产生重复 task children，
 *    且对已损坏 state（重复 id）自愈去重
 * 3. 同组 continue（无 recovery 重复 init）：tasks.md 增删任务后 children 一致性刷新
 * 4. 重复 id 存在时提交 completed_task_ids 被门禁显式拒绝（不静默）
 * 5. 推进失败时 submit 返回含 reason + item.metadata 落盘；引擎 recommendForItem 返回 blocked
 * 6. 推进成功时清理 _advance_block_reason；orchestrator 视图附推进阻塞原因
 */
import { describe, expect, test, afterAll } from "bun:test"
import { writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init, status, agent_submit } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWithFakeGit, teardown } from "./helpers"
import { setupToAnalyze, driveToImplement, readItem, taskListOf } from "./helpers-workflow"
import { loadWorkflow } from "../src/core/workflow/loader"
import { submitForStep } from "../src/core/workflow/submit"
import { recommendForItem } from "../src/core/workflow/engine"
import type { WorkItem } from "../src/core/workflow/types"

const CID = "test-sync"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/sync-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function statePath(wt: string): string {
  return join(wt, "openspec", "states", `${CID}.json`)
}

/** 直接改写活跃 task WorkItem（手动构造前置状态用）。 */
function rewriteItem(wt: string, groupId: string, mutate: (item: any) => void): void {
  const p = statePath(wt)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === `task:${groupId}`))
  writeFileSync(p, JSON.stringify(state, null, 2))
}

function taskChildIds(item: any): string[] {
  return item.children.filter((c: any) => c.type === "task").map((c: any) => c.id)
}

function assertNoDuplicateTaskChildren(item: any): void {
  const ids = taskChildIds(item)
  expect(new Set(ids).size).toBe(ids.length)
}

/** 注入重复 task children（模拟已损坏 state：整段复制，id/externalId 全部撞车）。 */
function injectDuplicateTaskChildren(wt: string, groupId = "1"): void {
  rewriteItem(wt, groupId, (item) => {
    const tasks = item.children.filter((c: any) => c.type === "task")
    item.children = [
      ...item.children.filter((c: any) => c.type !== "task"),
      ...tasks,
      ...tasks.map((t: any) => ({ ...t })),
    ]
  })
}

describe("syncTaskChildren 断根：重复 task children", () => {
  test("组切换 1→2→1 多次 init 不产生重复 task children", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await init.execute({ change_id: CID, task_group_id: "2" }, o)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await init.execute({ change_id: CID, task_group_id: "2" }, o)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      assertNoDuplicateTaskChildren(readItem(wt, CID, "1"))
      assertNoDuplicateTaskChildren(readItem(wt, CID, "2"))
      expect(taskChildIds(readItem(wt, CID, "1")).length).toBe(3)
      expect(taskChildIds(readItem(wt, CID, "2")).length).toBe(2)
    } finally { teardown(root) }
  })

  test("recovery 多路径重复 init（含已损坏重复 state）不产生重复 task children 且自愈", async () => {
    const { wt, root } = fresh()
    try {
      const ctx = await setupToAnalyze(wt, CID)
      injectDuplicateTaskChildren(wt)
      // forceOpen 路径：task_analysis 全新开始
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "task_analysis" } }, ctx.orch)
      assertNoDuplicateTaskChildren(readItem(wt, CID))
      expect(taskChildIds(readItem(wt, CID)).length).toBe(3)
      // 非 forceOpen 路径：dev_impl 保留既有进度（重复 init 两次）
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "dev_impl" } }, ctx.orch)
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "dev_impl" } }, ctx.orch)
      assertNoDuplicateTaskChildren(readItem(wt, CID))
      expect(taskChildIds(readItem(wt, CID)).length).toBe(3)
      // review 路径：defaultStatus=done，重复 init 两次
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, ctx.orch)
      assertNoDuplicateTaskChildren(readItem(wt, CID))
      expect(taskChildIds(readItem(wt, CID)).length).toBe(3)
    } finally { teardown(root) }
  })

  test("同组 continue（无 recovery 重复 init）：tasks.md 增删任务后 children 一致性刷新", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      expect(taskChildIds(readItem(wt, CID)).length).toBe(3)

      const p = join(wt, "openspec", "changes", CID, "tasks.md")
      writeFileSync(
        p,
        `## 1. First Task Group\n\n- [ ] 1.1 Task one [spec:spec-a]\n- [ ] 1.4 Task four [spec:spec-b]\n\n## 2. Second Task Group\n\n- [ ] 2.1 Another task [spec:spec-b]\n\n## 3. Third Task Group\n\n- [ ] 3.1 Final task [spec:spec-a]\n`,
        "utf-8"
      )
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      const item = readItem(wt, CID)
      assertNoDuplicateTaskChildren(item)
      expect(taskChildIds(item).length).toBe(2)
      // 既有任务（1.1）进度保留；新增任务（1.4）为 todo
      expect(taskListOf(item).find((t: any) => t.taskNumber === "1.1")).toBeDefined()
      expect(taskListOf(item).find((t: any) => t.taskNumber === "1.4")?.status).toBe("open")
    } finally { teardown(root) }
  })

  test("同组 continue 清除残留推进阻塞原因（_advance_block_reason）", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      rewriteItem(wt, "1", (item) => {
        item.metadata["_advance_block_reason"] = "跨 phase 正向推进被门禁拦截：测试原因"
      })
      // 阻塞条件经"改 tasks.md + 无 recovery 同组重 init"解除后，continue 路径须清除过期原因
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      expect(readItem(wt, CID).metadata["_advance_block_reason"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

describe("重复 id 提交门禁（不静默）", () => {
  test("重复 task children 存在时提交 completed_task_ids 被显式拒绝", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      injectDuplicateTaskChildren(wt)
      const err: unknown = await agent_submit
        .execute({ change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] }, ctx.dev)
        .catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/open\/rejected 状态且未在 completed_task_ids/)
      // 未落盘：拒绝后 phase 仍为 in_progress（handleImplementParams 在 writeState 前抛错）
      expect(readItem(wt, CID).phase).toBe("in_progress")
    } finally { teardown(root) }
  })
})

describe("推进失败显式化", () => {
  const YAML = `
id: t
max_retries: 3
phases:
  - name: todo
    steps:
      - id: analyze
        agents:
          - id: architect
            capability_tags: [architecture]
        transitions:
          on_pass: implement
          on_fail: analyze
  - name: in_progress
    steps:
      - id: implement
        agents:
          - id: developer
            capability_tags: [efficiency]
        transitions:
          on_pass: verify
          on_fail: analyze
  - name: review
    steps:
      - id: verify
        agents:
          - id: reviewer
            capability_tags: [quality-gate]
        transitions:
          on_pass: done
          on_fail: implement
`
  const WF = loadWorkflow(YAML)

  function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
    return {
      id: "w1",
      source: "openspec",
      type: "task",
      title: "T1",
      description: "d",
      phase: "todo",
      suspended: false,
      currentStep: "analyze",
      tags: {},
      metadata: {},
      children: [],
      labels: [],
      ...overrides,
    }
  }

  function taskChild(id: string, phase: WorkItem["phase"]): WorkItem {
    return makeItem({ id, type: "task", title: `T-${id}`, description: "d", phase })
  }

  test("跨 phase 门禁拦截：submit 返回 reason + metadata 落盘；引擎 blocked", () => {
    const item = makeItem({ phase: "in_progress", currentStep: "implement" })
    item.children.push(taskChild("1", "todo"))
    const r = submitForStep(item, WF, { stepId: "implement", agentKey: "developer", verdict: "passed" })
    expect(r.advanced).toBe(false)
    expect(r.reason).toBeDefined()
    expect(r.reason).toMatch(/门禁|子任务/)
    expect(item.metadata["_advance_block_reason"]).toBe(r.reason)

    const rec = recommendForItem(item, WF)
    expect(rec.status).toBe("blocked")
    expect(rec.blockedReason).toBeDefined()
  })

  test("done 目标 task child 未终态：submit 返回 reason；引擎 blocked", () => {
    const item = makeItem({ phase: "review", currentStep: "verify" })
    item.children.push(taskChild("1", "todo"))
    const r = submitForStep(item, WF, { stepId: "verify", agentKey: "reviewer", verdict: "passed" })
    expect(r.advanced).toBe(false)
    expect(r.reason).toMatch(/子任务/)
    expect(item.metadata["_advance_block_reason"]).toBe(r.reason)

    const rec = recommendForItem(item, WF)
    expect(rec.status).toBe("blocked")
  })

  test("推进成功：清理 _advance_block_reason，引擎返回 terminal", () => {
    const item = makeItem({
      phase: "review",
      currentStep: "verify",
      tags: { "verify:reviewer": "passed" },
      metadata: { _advance_block_reason: "历史阻塞原因" },
    })
    item.children.push(taskChild("1", "done"))
    const rec = recommendForItem(item, WF)
    expect(rec.status).toBe("terminal")
    const r = submitForStep(item, WF, { stepId: "verify", agentKey: "reviewer", verdict: "passed" })
    expect(r.advanced).toBe(true)
    expect(r.transitionTarget).toBe("done")
    expect(r.reason).toBeUndefined()
    expect(item.metadata["_advance_block_reason"]).toBeUndefined()
  })
})

describe("orchestrator 视图附推进阻塞原因", () => {
  test("metadata._advance_block_reason 存在时编排者分派视图展示", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      rewriteItem(wt, "1", (item) => {
        item.metadata["_advance_block_reason"] = "跨 phase 正向推进被门禁拦截：测试原因"
      })
      const view = await status.execute({ change_id: CID }, ctx.orch)
      expect(view).toContain("# 编排进度")
      expect(view).toContain("**推进阻塞**: 跨 phase 正向推进被门禁拦截：测试原因")
    } finally { teardown(root) }
  })

  test("引擎 blocked（task child 未达 review）时编排者分派视图附阻塞原因", async () => {
    const { wt, root } = fresh()
    try {
      const { ctx } = await driveToImplement(wt, CID)
      // 模拟死锁态：implement 全 passed + 遗留 todo task child → forwardGatePassed 拦截
      rewriteItem(wt, "1", (item) => {
        item.tags["implement:openspec-developer"] = "passed"
        item.children.push({
          id: "9", source: "openspec", externalId: "1.9", type: "task", title: "遗留子任务",
          description: "遗留子任务", phase: "todo", suspended: false, currentStep: null,
          tags: {}, metadata: {}, children: [], labels: [],
        })
      })
      const view = await status.execute({ change_id: CID }, ctx.orch)
      expect(view).toContain("# 编排进度")
      expect(view).toContain("**推进阻塞**:")
    } finally { teardown(root) }
  })
})
