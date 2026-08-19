/**
 * 模式固化（full / simple）与 task-simple 流程文件测试（变更组 1）：
 * - opx_orch_init 经 mode 参数固化模式（缺省 simple）；重复初始化 / 切换任务组沿用既有 mode；
 *   旧 state 缺 mode 读时兜底 full 不写回
 * - mode 值域外报错（不落盘，新建与已存在 state 两种情形）
 * - task-simple.yaml 可经 loadWorkflowFile 加载且结构正确（双文件并行缓存、互不污染）
 * - resolveWorkflowPath 按 state.mode 选择 workflow 文件
 * - agentToReviewLayer 的 openspec-reviewer → quality 映射（D1）
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { __setGitRunner } from "../src/core/git"
import { init } from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeOrchCtx, setupWithFakeGit, teardown } from "./helpers"
import {
  loadWorkflowFile, TASK_WORKFLOW_PATH, SIMPLE_WORKFLOW_PATH, resolveWorkflowPath,
} from "../src/core/workflow/loader"
import { agentToReviewLayer } from "../src/core/constants"

const CID = "mode-test"

afterAll(() => { __setGitRunner(null) })

function fresh(): { wt: string; root: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/mode-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree, fakeGit } = setupWithFakeGit(root, CID)
  return { wt: worktree, root, fakeGit }
}

function stateOf(wt: string): any {
  const p = join(wt, "openspec", "states", `${CID}.json`)
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null
}

/** 直写旧格式 state（无 mode 字段）到磁盘。 */
function writeLegacyState(wt: string): void {
  const stateDir = join(wt, "openspec", "states")
  mkdirSync(stateDir, { recursive: true })
  const legacy = {
    changeId: CID,
    isolationNamespace: "abc123",
    taskGroupId: "1",
    baseBranch: "main",
    workItems: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  writeFileSync(join(stateDir, `${CID}.json`), JSON.stringify(legacy))
}

describe("opx_orch_init 模式固化", () => {
  test("新建 state：不传 mode 缺省 simple 并写入 mode=simple", async () => {
    const { wt, root } = fresh()
    try {
      await init.execute({ change_id: CID, task_group_id: "1" }, makeOrchCtx(wt))
      expect(stateOf(wt).mode).toBe("simple")
    } finally { teardown(root) }
  })

  test("新建 state：mode=simple 写入 mode=simple", async () => {
    const { wt, root } = fresh()
    try {
      await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, makeOrchCtx(wt))
      expect(stateOf(wt).mode).toBe("simple")
    } finally { teardown(root) }
  })

  test("新建 state：mode=full 写入 mode=full", async () => {
    const { wt, root } = fresh()
    try {
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, makeOrchCtx(wt))
      expect(stateOf(wt).mode).toBe("full")
    } finally { teardown(root) }
  })

  test("重复初始化沿用既有 mode：simple 开始后传 mode=full 再 init，mode 仍为 simple", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, o)
      expect(stateOf(wt).mode).toBe("simple")
      // 已开始的变更沿用固化模式，mode 参数不再生效
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
      expect(stateOf(wt).mode).toBe("simple")
    } finally { teardown(root) }
  })

  test("切换任务组沿用既有 mode：simple 固化后切组仍为 simple", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, o)
      await init.execute({ change_id: CID, task_group_id: "2" }, o)
      expect(stateOf(wt).taskGroupId).toBe("2")
      expect(stateOf(wt).mode).toBe("simple")
    } finally { teardown(root) }
  })

  test("旧 state 缺 mode：不写回（state.mode 保持 undefined），消费端读时兜底 full", async () => {
    const { wt, root } = fresh()
    try {
      writeLegacyState(wt)
      // 已存在的 state 不受 mode 参数影响
      await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, makeOrchCtx(wt))
      expect(stateOf(wt).mode).toBeUndefined()
      expect(stateOf(wt).isolationNamespace).toBe("abc123")
    } finally { teardown(root) }
  })

  test("mode 值域外报错且不落盘（新建 state）", async () => {
    const { wt, root } = fresh()
    try {
      const err = await init.execute(
        { change_id: CID, task_group_id: "1", mode: "banana" } as any,
        makeOrchCtx(wt)
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/mode 参数不合法/)
      expect(err.message).toMatch(/banana/)
      expect(existsSync(join(wt, "openspec", "states", `${CID}.json`))).toBe(false)
    } finally { teardown(root) }
  })

  test("mode 值域外报错且不落盘（已存在 state）", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, o)
      const err = await init.execute(
        { change_id: CID, task_group_id: "1", mode: "banana" } as any,
        o
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/mode 参数不合法/)
      // 值域外参数被拒绝，state 未被改写，仍为既有 simple
      expect(stateOf(wt).mode).toBe("simple")
    } finally { teardown(root) }
  })
})

describe("task-simple.yaml 加载与结构", () => {
  test("可经 loadWorkflowFile 加载且结构正确（骨架 + quality_review 语义合并验收）", () => {
    const wf = loadWorkflowFile(SIMPLE_WORKFLOW_PATH)
    expect(wf.id).toBe("task-simple")
    expect(wf.phases.map((p) => p.name)).toEqual(["in_progress", "review"])

    const impl = wf.stepMap.get("implement")!
    expect(impl.phase.name).toBe("in_progress")
    expect(impl.step.agents.map((a) => a.id)).toEqual(["openspec-developer"])
    expect(impl.step.transitions).toEqual({ on_pass: "quality_review", on_fail: "implement" })
    // 1.4 验收：constraints 不含边界占位符（执行边界默认整个 worktree）
    for (const c of impl.step.constraints ?? []) {
      expect(c).not.toMatch(/\{\{allowed_directories\}\}/)
      expect(c).not.toMatch(/\{\{allowed_packages\}\}/)
      expect(c).not.toMatch(/\{\{notes\}\}/)
    }

    const qr = wf.stepMap.get("quality_review")!
    expect(qr.phase.name).toBe("review")
    expect(qr.step.agents.map((a) => a.id)).toEqual(["openspec-reviewer"])
    // 1.4 验收：capability_tags 为 10 项集合（verify_tool + verify_task + verify_quality 能力并集）
    const expectedTags = [
      "quality-gate", "api-testing", "dev-practices", "efficiency", "style", "architecture",
      "performance", "security", "maintainability", "tool-improvement",
    ]
    expect([...qr.step.agents[0].capability_tags].sort()).toEqual([...expectedTags].sort())
    expect(qr.step.transitions).toEqual({ on_pass: "done", on_fail: "implement" })

    // 1.5 验收：constraints 不含「禁止运行确定性工具检查」与禁 bash 表述
    const qrConstraints = (qr.step.constraints ?? []).join("\n")
    expect(qrConstraints).not.toMatch(/禁止运行确定性工具检查/)
    expect(qrConstraints).not.toMatch(/仅输出审查报告/)
    expect(qrConstraints).not.toMatch(/不得 edit\/write 任何文件/)
    // 确定性工具检查允许 + 文档/注释直改允许（只报不改的例外）
    expect(qrConstraints).toMatch(/可 bash 运行确定性工具检查/)
    expect(qrConstraints).toMatch(/文档\/注释等不影响代码运行的内容可直接修改/)

    // 1.5 验收：instructions 含工具改进双报与只报不改语义
    const qrInstructions = (qr.step.instructions ?? []).join("\n")
    expect(qrInstructions).toMatch(/必须双报/)
    expect(qrInstructions).toMatch(/只报不改/)
    // 任务验证语义（verified_tasks / failed_tasks）
    expect(qrInstructions).toMatch(/failed_tasks/)
    expect(qrInstructions).toMatch(/verified_tasks/)

    // common 复用 task.yaml 的 _agent 传递指引与「缺省视为编排视角」提示文案
    expect(wf.common?.instructions?.[0]).toMatch(/_agent/)
    expect(wf.common?.instructions?.[0]).toMatch(/缺省会被视为编排主代理视角/)
  })

  test("双文件并行缓存且互不污染", () => {
    const full = loadWorkflowFile(TASK_WORKFLOW_PATH)
    const simple = loadWorkflowFile(SIMPLE_WORKFLOW_PATH)
    expect(loadWorkflowFile(TASK_WORKFLOW_PATH)).toBe(full)
    expect(loadWorkflowFile(SIMPLE_WORKFLOW_PATH)).toBe(simple)
    expect(full).not.toBe(simple)
    expect(full.stepMap.has("quality_review")).toBe(false)
    expect(simple.stepMap.has("verify_tool")).toBe(false)
    expect(simple.stepMap.has("verify_task")).toBe(false)
    expect(simple.stepMap.has("verify_quality")).toBe(false)
  })
})

describe("resolveWorkflowPath 按 state.mode 选择文件", () => {
  test("simple → task-simple.yaml；full / 缺 mode（旧 state）→ task.yaml", () => {
    expect(resolveWorkflowPath({ mode: "simple" })).toBe(SIMPLE_WORKFLOW_PATH)
    expect(resolveWorkflowPath({ mode: "full" })).toBe(TASK_WORKFLOW_PATH)
    expect(resolveWorkflowPath({})).toBe(TASK_WORKFLOW_PATH)
    expect(resolveWorkflowPath({ mode: undefined })).toBe(TASK_WORKFLOW_PATH)
  })
})

describe("agentToReviewLayer 的 openspec-reviewer 映射（D1）", () => {
  test("openspec-reviewer → quality；其余映射不变", () => {
    expect(agentToReviewLayer("openspec-reviewer")).toBe("quality")
    expect(agentToReviewLayer("openspec-reviewer-tool")).toBe("tool")
    expect(agentToReviewLayer("openspec-reviewer-task")).toBe("task")
    expect(agentToReviewLayer("openspec-reviewer-style")).toBe("quality")
    expect(agentToReviewLayer("openspec-developer")).toBeUndefined()
    expect(agentToReviewLayer(undefined)).toBeUndefined()
  })
})
