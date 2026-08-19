/**
 * workflow poller 测试：定时拉取 + 去重 + 失败不阻塞 + 写回失败记录 + ADO 占位。
 * 通过 init 建立真实编排会话（state.workItems），pollOnce 注入 worktree+changeId 拉取写入。
 */
import { describe, expect, test, afterAll, spyOn } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init } from "../src/adapters/opencode/tools"
import { loadWorkflow } from "../src/core/workflow"
import {
  OpenSpecCollector, AdoCollector, registerCollector, getCollectors, __resetCollectors,
  pollOnce, pollAdapter, startPolling, __resetPoller,
} from "../src/core/workflow"
import type { CollectorAdapter } from "../src/core/workflow"
import { createInitialWorkItem } from "../src/core/workflow/engine"
import type { WorkItem } from "../src/core/workflow/types"
import { FakeGitRunner, makeCtx, makeOrchCtx, setupWorkspace } from "./helpers"

const CID = "poller"

afterAll(() => {
  __setGitRunner(null)
  __resetCollectors()
  __resetPoller()
})

function readStateSync(wt: string): any {
  const p = join(wt, "openspec", "states", `${CID}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

function workItemsOf(wt: string): WorkItem[] {
  return readStateSync(wt)?.workItems ?? []
}

function freshSetup(root: string): { wt: string } {
  const wt = setupWorkspace(root, CID)
  __setGitRunner(new FakeGitRunner())
  return { wt }
}

async function initSession(wt: string): Promise<void> {
  await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, makeOrchCtx(wt))
}

/** 可配置假 adapter：pull 返回固定原始项，可注入 pull/transform/writeback 失败。 */
class FakeAdapter implements CollectorAdapter {
  readonly name: string
  readonly pollIntervalMs: number
  raw: unknown[] = []
  failPull = false
  failTransform = false
  writebackError: string | null = null

  constructor(name: string, pollIntervalMs = 100) {
    this.name = name
    this.pollIntervalMs = pollIntervalMs
  }

  async pull(): Promise<unknown[]> {
    if (this.failPull) throw new Error("pull boom")
    return this.raw
  }

  transform(raw: unknown[]): WorkItem[] {
    if (this.failTransform) throw new Error("transform boom")
    return (raw as Array<{ id: string }>).map((r) =>
      createInitialWorkItem({
        id: `${this.name}:${r.id}`,
        source: this.name,
        externalId: r.id,
        type: "task",
        title: r.id,
        description: r.id,
      })
    )
  }

  async writeback(_item: WorkItem, _payload: unknown): Promise<{ success: boolean; error?: string }> {
    if (this.writebackError) return { success: false, error: this.writebackError }
    return { success: true }
  }
}

describe("poller 拉取与去重", () => {
  test("自定义 adapter 注册后 pollOnce 将原始项 transform 并写入 state.workItems", async () => {
    const root = `/tmp/opxpoll-1-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      const fake = new FakeAdapter("fake")
      fake.raw = [{ id: "x1" }, { id: "x2" }]
      registerCollector(fake)

      const r = await pollOnce(wt, CID)
      expect(r.added).toEqual(["fake:x1", "fake:x2"])
      expect(r.skipped).toEqual([])
      expect(r.errors).toEqual([])
      expect(workItemsOf(wt).filter((w) => w.source === "fake")).toHaveLength(2)
      const x1 = workItemsOf(wt).find((w) => w.externalId === "x1")
      expect(x1!.phase).toBe("todo")
      expect(x1!.suspended).toBe(false)
      expect(x1!.children).toEqual([])
      expect(x1!.tags).toEqual({})
      expect(x1!.writeback?.lastSuccess).toBeDefined()
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("去重：相同 externalId+source 再次 poll → 不重复新增，标记 skipped", async () => {
    const root = `/tmp/opxpoll-2-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      const fake = new FakeAdapter("fake")
      fake.raw = [{ id: "x1" }]
      registerCollector(fake)

      const r1 = await pollOnce(wt, CID)
      expect(r1.added).toEqual(["fake:x1"])
      const r2 = await pollOnce(wt, CID)
      expect(r2.added).toEqual([])
      expect(r2.skipped).toEqual(["fake:x1"])
      expect(workItemsOf(wt).filter((w) => w.source === "fake")).toHaveLength(1)
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("拉取抛错 → 不阻塞其他 adapter，错误记录在 errors", async () => {
    const root = `/tmp/opxpoll-3-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      const bad = new FakeAdapter("bad")
      bad.failPull = true
      const good = new FakeAdapter("good")
      good.raw = [{ id: "y1" }]
      registerCollector(bad)
      registerCollector(good)

      const r = await pollOnce(wt, CID)
      expect(r.added).toEqual(["good:y1"])
      expect(r.errors.some((e) => e.includes("bad"))).toBe(true)
      expect(workItemsOf(wt).find((w) => w.externalId === "y1")).toBeDefined()
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("transform 抛错 → 记录错误且不写入任何项", async () => {
    const root = `/tmp/opxpoll-4-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      const fake = new FakeAdapter("fake")
      fake.raw = [{ id: "x1" }]
      fake.failTransform = true
      registerCollector(fake)

      const r = await pollOnce(wt, CID)
      expect(r.added).toEqual([])
      expect(r.errors.some((e) => e.includes("transform"))).toBe(true)
      expect(workItemsOf(wt).filter((w) => w.source === "fake")).toHaveLength(0)
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
})

describe("poller 写回与占位", () => {
  test("writeback 失败 → item.writeback 记录 lastAttempt 与 error，且不阻塞整体调度", async () => {
    const root = `/tmp/opxpoll-5-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      const fake = new FakeAdapter("fake")
      fake.raw = [{ id: "x1" }]
      fake.writebackError = "external down"
      registerCollector(fake)

      const r = await pollOnce(wt, CID)
      expect(r.added).toEqual(["fake:x1"])
      expect(r.errors).toEqual([])
      const x1 = workItemsOf(wt).find((w) => w.externalId === "x1")
      expect(x1!.writeback?.lastAttempt).toBeDefined()
      expect(x1!.writeback?.error).toBe("external down")
      expect(x1!.writeback?.lastSuccess).toBeUndefined()
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("ADO 占位注册参与调度：pull 返回空列表不抛错", async () => {
    const root = `/tmp/opxpoll-6-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      registerCollector(new AdoCollector())

      const r = await pollOnce(wt, CID)
      expect(r.added).toEqual([])
      expect(r.skipped).toEqual([])
      expect(r.errors).toEqual([])
      expect(getCollectors().map((c) => c.name)).toContain("ado")
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("pollAdapter 对单个 adapter 拉取；无编排会话时静默跳过不产生 error", async () => {
    const root = `/tmp/opxpoll-7-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      // 未 init → 无编排会话 → 静默跳过（不返回 error，避免 poller 刷 console.error 噪音）
      const fake = new FakeAdapter("fake")
      fake.raw = [{ id: "x1" }]
      const r = await pollAdapter(wt, fake, CID)
      expect(r.added).toEqual([])
      expect(r.skipped).toEqual([])
      expect(r.error).toBeUndefined()
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
})

describe("OpenSpec collector 注册", () => {
  test("OpenSpecCollector 注册后参与 pollOnce 拉取 openspec change", async () => {
    const root = `/tmp/opxpoll-8-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      mkdirSync(join(wt, "openspec", "changes", "c-1"), { recursive: true })
      const fs = await import("node:fs")
      fs.writeFileSync(join(wt, "openspec", "changes", "c-1", "proposal.md"), "# Change One\n\n## Why\n\n原因。\n")

      registerCollector(new OpenSpecCollector({ openspecDir: join(wt, "openspec") }))
      const r = await pollOnce(wt, CID)
      expect(r.added).toContain("openspec:c-1")
      const item = workItemsOf(wt).find((w) => w.externalId === "c-1")
      expect(item).toBeDefined()
      expect(item!.source).toBe("openspec")
      expect(item!.type).toBe("task")
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
})

describe("startPolling 定时调度", () => {
  test("短间隔下按 pollIntervalMs 触发，stop 后不再拉取", async () => {
    const root = `/tmp/opxpoll-9-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      const fake = new FakeAdapter("fake", 50)
      fake.raw = [{ id: "x1" }]
      registerCollector(fake)

      const handle = startPolling(wt, { intervalMs: 20, changeId: CID })
      // 等待至少一个 tick 周期完成拉取
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(workItemsOf(wt).find((w) => w.externalId === "x1")).toBeDefined()

      handle.stop()
      const count = workItemsOf(wt).filter((w) => w.externalId === "x1").length
      // stop 后拉取去重，不会重复写入（即使定时器仍会 tick 也跳过已存在项）
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(workItemsOf(wt).filter((w) => w.externalId === "x1")).toHaveLength(count)
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("startPolling 幂等：同 worktree 重复调用复用同一句柄，不累积定时器", async () => {
    const root = `/tmp/opxpoll-10-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      const fake = new FakeAdapter("fake", 50)
      fake.raw = [{ id: "x1" }]
      registerCollector(fake)

      const h1 = startPolling(wt, { intervalMs: 20, changeId: CID })
      const h2 = startPolling(wt, { intervalMs: 20, changeId: CID })
      expect(h2).toBe(h1)

      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(workItemsOf(wt).find((w) => w.externalId === "x1")).toBeDefined()

      h1.stop()
      // stop 后注册表项已删除，允许重新启动
      const h3 = startPolling(wt, { intervalMs: 20, changeId: CID })
      expect(h3).not.toBe(h1)
      h3.stop()
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("pollAdapter 全部 skipped（无新增项）时不写盘", async () => {
    const root = `/tmp/opxpoll-11-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    try {
      await initSession(wt)
      const fake = new FakeAdapter("fake")
      fake.raw = [{ id: "x1" }]
      registerCollector(fake)

      await pollOnce(wt, CID) // 第一次：新增 x1，写盘
      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const mtimeAfterFirst = statSync(statePath).mtimeMs

      // 等待确保 mtime 具备区分度（文件系统时间戳精度）
      await new Promise((resolve) => setTimeout(resolve, 30))
      const r2 = await pollOnce(wt, CID) // 第二次：全部 skipped
      expect(r2.added).toEqual([])
      expect(r2.skipped).toEqual(["fake:x1"])

      expect(statSync(statePath).mtimeMs).toBe(mtimeAfterFirst)
      expect(workItemsOf(wt).filter((w) => w.source === "fake")).toHaveLength(1)
    } finally {
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("startPolling 间隔回调拉取出错时 console.error 被调用（非静默）", async () => {
    const root = `/tmp/opxpoll-12-${Date.now()}`
    const { wt } = freshSetup(root)
    __resetCollectors()
    const spy = spyOn(console, "error").mockImplementation(() => {})
    spy.mockClear()
    try {
      await initSession(wt)
      const bad = new FakeAdapter("bad", 10)
      bad.failPull = true
      registerCollector(bad)

      const handle = startPolling(wt, { intervalMs: 10, changeId: CID })
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(spy.mock.calls.some((call) => String(call[0]).includes("bad"))).toBe(true)
      handle.stop()
    } finally {
      spy.mockRestore()
      __resetCollectors()
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
})
