import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenSpecCollector, AdoCollector, registerCollector, getCollectors, __resetCollectors } from "../src/core/workflow/collector"
import type { CollectorAdapter, OpenSpecChangeRef } from "../src/core/workflow/collector"
import { loadWorkflow } from "../src/core/workflow"

function makeTempOpenspec(): string {
  const root = mkdtempSync(join(tmpdir(), "openspec-coll-"))
  mkdirSync(join(root, "changes"), { recursive: true })
  return root
}

function addChange(root: string, name: string, proposal: string): void {
  const dir = join(root, "changes", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "proposal.md"), proposal)
}

describe("OpenSpecCollector 扫描", () => {
  test("pull 返回原始 change ref，transform 产出符合 design 约束的 task WorkItem，且幂等", async () => {
    const root = makeTempOpenspec()
    addChange(root, "c1", "# Change One\n\n## Why\n\n因为 c1。\n")
    addChange(root, "c2", "## Why\n\n因为 c2。\n")
    const collector: CollectorAdapter = new OpenSpecCollector({ openspecDir: root })

    const raw = await collector.pull()
    expect(raw).toHaveLength(2)
    expect(raw.map((r) => (r as OpenSpecChangeRef).changeName).sort()).toEqual(["c1", "c2"])

    const items = collector.transform(raw)
    expect(items).toHaveLength(2)
    const c1 = items.find((i) => i.externalId === "c1")
    expect(c1).toBeDefined()
    expect(c1!.source).toBe("openspec")
    expect(c1!.id).toBe("openspec:c1")
    expect(c1!.type).toBe("task")
    expect(c1!.phase).toBe("todo")
    expect(c1!.suspended).toBe(false)
    expect(c1!.currentStep).toBeNull()
    expect(c1!.children).toEqual([])
    expect(c1!.tags).toEqual({})
    expect(c1!.labels).toEqual(["openspec-change"])
    expect(c1!.title).toBe("Change One")
    expect(c1!.description).toContain("因为 c1")

    const c2 = items.find((i) => i.externalId === "c2")
    expect(c2).toBeDefined()
    expect(c2!.title).toBe("c2")
    expect(c2!.description).toContain("因为 c2")

    const again = await collector.pull()
    expect(again).toEqual(raw)
    rmSync(root, { recursive: true, force: true })
  })

  test("openspecDir 不存在 → pull 返回空数组且不抛错", async () => {
    const root = mkdtempSync(join(tmpdir(), "openspec-missing-"))
    rmSync(root, { recursive: true, force: true })
    const collector = new OpenSpecCollector({ openspecDir: root })
    expect(await collector.pull()).toEqual([])
  })

  test("无 proposal.md 的目录被跳过", async () => {
    const root = makeTempOpenspec()
    addChange(root, "c1", "# One\n")
    mkdirSync(join(root, "changes", "no-proposal"), { recursive: true })
    const collector = new OpenSpecCollector({ openspecDir: root })
    const raw = await collector.pull()
    expect(raw.map((r) => (r as OpenSpecChangeRef).changeName)).toEqual(["c1"])
    rmSync(root, { recursive: true, force: true })
  })

  test("默认 pollIntervalMs=30000，name=openspec，writeback 默认成功", async () => {
    const collector = new OpenSpecCollector({ openspecDir: "/tmp" })
    expect(collector.pollIntervalMs).toBe(30_000)
    expect(collector.name).toBe("openspec")
    const r = await collector.writeback({} as never, null)
    expect(r.success).toBe(true)
  })
})

describe("ADO 收集器占位与自定义注册", () => {
  test("ADO 占位：pull/transform 返回空且不抛错，writeback 成功", async () => {
    const ado = new AdoCollector()
    expect(ado.name).toBe("ado")
    expect(await ado.pull()).toEqual([])
    expect(ado.transform([])).toEqual([])
    const r = await ado.writeback({} as never, null)
    expect(r.success).toBe(true)
  })

  test("registerCollector 注册后 getCollectors 可见，同名重复注册幂等", () => {
    __resetCollectors()
    registerCollector(new OpenSpecCollector({ openspecDir: "/tmp" }))
    registerCollector(new AdoCollector())
    const names = getCollectors().map((c) => c.name)
    expect(names).toContain("openspec")
    expect(names).toContain("ado")

    registerCollector(new AdoCollector())
    expect(getCollectors().filter((c) => c.name === "ado")).toHaveLength(1)
    __resetCollectors()
  })
})

describe("task.yaml 加载", () => {
  test("loadWorkflow 解析成功：id/max_retries/5 phase/step 全量可解析", () => {
    const yamlText = readFileSync(join(import.meta.dir, "../assets/workflows/task.yaml"), "utf8")
    const wf = loadWorkflow(yamlText)
    expect(wf.id).toBe("task")
    expect(wf.max_retries).toBe(5)
    expect(wf.phases.map((p) => p.name)).toEqual(["todo", "in_progress", "review", "done", "cancelled"])
    const expectedSteps = [
      "analyze", "implement",
      "verify_tool", "verify_task", "verify_quality",
      "terminal_done", "terminal_cancelled",
    ]
    const stepIds = wf.phases.flatMap((p) => p.steps.map((s) => s.id))
    expect(stepIds).toEqual(expectedSteps)
    for (const phase of wf.phases) {
      expect(phase.steps.length).toBeGreaterThan(0)
    }
    for (const step of wf.phases.flatMap((p) => p.steps)) {
      for (const target of [step.transitions.on_pass, step.transitions.on_fail]) {
        if (target === "done" || target === "halt") continue
        expect(wf.stepMap.has(target)).toBe(true)
      }
    }
  })
})
