/**
 * 模式固化（full / simple）与 task-simple 流程文件测试（变更组 1）：
 * - opx_orch_init 经 mode 参数固化模式（缺省 simple）；重复初始化 / 切换任务组沿用既有 mode；
 *   旧 state 缺 mode 读时兜底 full 不写回
 * - mode 值域外报错（不落盘，新建与已存在 state 两种情形）
 * - state 已存在时的 mode 变更窗口（W1/W2）：切组 / recovery=task_analysis 重制可更新，
 *   其余场景传不同 mode 显式报错且状态未变更；不传或相同 mode 保持既有行为
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

/** 直改 state 文件（构造其他组终态 / 执行痕迹等场景）。 */
function mutateState(wt: string, mutate: (state: any) => void): void {
  const p = join(wt, "openspec", "states", `${CID}.json`)
  const state = JSON.parse(readFileSync(p, "utf-8"))
  mutate(state)
  writeFileSync(p, JSON.stringify(state, null, 2))
}

function itemOf(state: any, groupId: string): any {
  return state.workItems.find((w: any) => w.id === `task:${groupId}`)
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

  test("重复初始化当前组（无 recovery）传不同 mode → 报错且 mode 保持不变", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, o)
      expect(stateOf(wt).mode).toBe("simple")
      // 已开始的变更在窗口外（同组重复初始化、无 recovery）传不同 mode：显式报错，不再静默忽略
      const err = await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/mode 参数与已固化的流程模式不一致/)
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
      // 已存在的 state 不传 mode：mode 保持缺省不写回（窗口外传不同 mode 会显式报错）
      await init.execute({ change_id: CID, task_group_id: "1" }, makeOrchCtx(wt))
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

describe("opx_orch_init mode 变更窗口（W1 切组 / W2 重制当前组）", () => {
  test("W1 切组 + 其他任务组均终态：传不同 mode → 更新生效、目标组按新 mode 重建、返回体含切换说明", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
      // 当前组（组 1）标记终态：phase=done + completed_at
      mutateState(wt, (s) => {
        const g1 = itemOf(s, "1")
        g1.phase = "done"
        g1.metadata["completed_at"] = new Date().toISOString()
      })
      const out = await init.execute({ change_id: CID, task_group_id: "2", mode: "simple" }, o)
      expect(out).toContain("流程模式已从 full 切换为 simple")
      const s = stateOf(wt)
      expect(s.mode).toBe("simple")
      expect(s.taskGroupId).toBe("2")
      // 目标组按新 mode 重建：simple 初始态 in_progress/implement
      const g2 = itemOf(s, "2")
      expect(g2.phase).toBe("in_progress")
      expect(g2.currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  test("W1 切组 + 存在有执行痕迹的未终态组：传不同 mode → 报错且状态未变更", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
      // 当前组（组 1，切组后成为其他任务组）注入执行痕迹：analyze 已 passed 但未终态
      mutateState(wt, (s) => {
        itemOf(s, "1").tags["analyze:openspec-architect"] = "passed"
      })
      const before = readFileSync(join(wt, "openspec", "states", `${CID}.json`), "utf-8")
      const err = await init.execute({ change_id: CID, task_group_id: "2", mode: "simple" }, o).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/mode 参数与已固化的流程模式不一致/)
      expect(err.message).toContain('"full"')
      expect(err.message).toContain('"simple"')
      expect(err.message).toMatch(/切换任务组须其他任务组均已完成或从未激活/)
      // 错误早于任何状态变更：state 文件未被改写
      expect(readFileSync(join(wt, "openspec", "states", `${CID}.json`), "utf-8")).toBe(before)
    } finally { teardown(root) }
  })

  test("W1 切组 + 其他任务组均从未激活：传不同 mode → 放行更新", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      // 组 1 仅初始化未推进（tags 空、task children 全 todo）→ 从未激活
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
      const out = await init.execute({ change_id: CID, task_group_id: "2", mode: "simple" }, o)
      expect(out).toContain("流程模式已从 full 切换为 simple")
      const s = stateOf(wt)
      expect(s.mode).toBe("simple")
      expect(s.taskGroupId).toBe("2")
    } finally { teardown(root) }
  })

  test("W2 重制当前组（recovery.phase=task_analysis）：传不同 mode → 更新生效、当前组按新 mode 重制到初始状态", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
      // 注入执行进度：analyze passed、task child 1 进入 review
      mutateState(wt, (s) => {
        const g1 = itemOf(s, "1")
        g1.tags["analyze:openspec-architect"] = "passed"
        g1.children.find((c: any) => c.type === "task" && c.id === "1").phase = "review"
      })
      const out = await init.execute(
        { change_id: CID, task_group_id: "1", mode: "simple", recovery: { phase: "task_analysis" } },
        o
      )
      expect(out).toContain("已恢复到 task_analysis 阶段")
      expect(out).toContain("流程模式已从 full 切换为 simple")
      const s = stateOf(wt)
      expect(s.mode).toBe("simple")
      // 按新 mode 重制到初始状态：simple 全新开始（in_progress/implement、tags 清空、task children 全 todo）
      const g1 = itemOf(s, "1")
      expect(g1.phase).toBe("in_progress")
      expect(g1.currentStep).toBe("implement")
      expect(g1.tags).toEqual({})
      for (const c of g1.children.filter((c: any) => c.type === "task")) expect(c.phase).toBe("todo")
    } finally { teardown(root) }
  })

  test("W2 窗口外：recovery.phase=dev_impl 传不同 mode → 报错且 mode 保持", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
      const err = await init.execute(
        { change_id: CID, task_group_id: "1", mode: "simple", recovery: { phase: "dev_impl" } },
        o
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/mode 参数与已固化的流程模式不一致/)
      expect(err.message).toMatch(/重制当前组仅支持 recovery\.phase="task_analysis"/)
      expect(stateOf(wt).mode).toBe("full")
    } finally { teardown(root) }
  })

  test("W2 窗口外：recovery.phase=review 传不同 mode → 报错且 mode 保持", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, o)
      const err = await init.execute(
        { change_id: CID, task_group_id: "1", mode: "full", recovery: { phase: "review" } },
        o
      ).catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.message).toMatch(/mode 参数与已固化的流程模式不一致/)
      expect(stateOf(wt).mode).toBe("simple")
    } finally { teardown(root) }
  })

  test("传相同 mode 或不传 mode → 既有行为不变（无切换提示）", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, o)
      // 同组重复初始化传相同 mode：无提示
      const out1 = await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, o)
      expect(out1).toBe("编排会话已初始化。")
      // 切组不传 mode：沿用固化模式
      const out2 = await init.execute({ change_id: CID, task_group_id: "2" }, o)
      expect(out2).toBe("编排会话已初始化。")
      expect(stateOf(wt).mode).toBe("simple")
      // 切组传相同 mode：同样无提示
      const out3 = await init.execute({ change_id: CID, task_group_id: "1", mode: "simple" }, o)
      expect(out3).toBe("编排会话已初始化。")
      expect(stateOf(wt).mode).toBe("simple")
    } finally { teardown(root) }
  })

  test("旧 state 缺 mode + 传 mode=full（与生效兜底值一致）→ 放行无提示、mode 保持缺省不写回", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      writeLegacyState(wt)
      // 生效值为兜底 full，传入 full 视为无变更意图：放行且无切换提示
      const out = await init.execute({ change_id: CID, task_group_id: "1", mode: "full" }, o)
      expect(out).toBe("编排会话已初始化。")
      // 不写回：mode 保持缺省（消费端读时兜底 full 的既有语义不变）
      expect(stateOf(wt).mode).toBeUndefined()
    } finally { teardown(root) }
  })

  test("旧 state 缺 mode + 传 mode=simple 且满足 W1 切组窗口（其他组终态）→ 更新生效", async () => {
    const { wt, root } = fresh()
    try {
      const o = makeOrchCtx(wt)
      writeLegacyState(wt)
      // 旧 state（缺 mode，生效 full）先初始化组 1 物化 workItems
      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      expect(stateOf(wt).mode).toBeUndefined()
      // 组 1 标记终态后切组传 simple：属变更意图（simple ≠ 兜底 full），W1 窗口内放行
      mutateState(wt, (s) => {
        const g1 = itemOf(s, "1")
        g1.phase = "done"
        g1.metadata["completed_at"] = new Date().toISOString()
      })
      const out = await init.execute({ change_id: CID, task_group_id: "2", mode: "simple" }, o)
      expect(out).toContain("流程模式已从 full 切换为 simple")
      const s = stateOf(wt)
      expect(s.mode).toBe("simple")
      expect(s.taskGroupId).toBe("2")
      // 目标组按新 mode 重建：simple 初始态 in_progress/implement
      const g2 = itemOf(s, "2")
      expect(g2.phase).toBe("in_progress")
      expect(g2.currentStep).toBe("implement")
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
    // 1.4 验收：capability_tags 为 11 项集合（verify_tool + verify_task + verify_quality 能力并集 + cleanup 清理规范）
    const expectedTags = [
      "quality-gate", "api-testing", "dev-practices", "efficiency", "style", "architecture",
      "performance", "security", "maintainability", "tool-improvement", "cleanup",
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
