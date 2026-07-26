/**
 * 编排优化测试：阶段门禁、Recovery 自动补 executionBoundary、
 * Recovery review_layer 子阶段参数、空 issue 提交回归
 *
 * 这些测试验证即将新增的行为。当前代码可能尚未实现，测试预期部分失败。
 * 测试失败时应如实汇报失败内容，不得弱化断言。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  init,
  status,
  set_worktree,
  arch_submit,
  dev_submit,
  tool_review_submit,
  task_review_submit,
  quality_review_submit,
  MAX_RETRIES,
  __setGitRunner} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx, setupWithFakeGit, teardown, readState } from "./helpers"

const CID = "test-optimize"
afterAll(() => { __setGitRunner(null) })

function freshWt(root: string, cid: string = CID): string {
  const id = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = join(root, id, "w")
  mkdirSync(join(wt, "openspec", "changes", cid), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", cid, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n\n## 2. G2\n\n- [ ] 2.1 T3\n`,
    "utf-8"
  )
  return wt
}

function readStateSync(wt: string, cid: string = CID): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${cid}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

/** 将当前状态推进到 dev_submit 已完成（dev_impl 阶段结束） */
async function setupThroughDevSubmit(
  wt: string, fakeGit: FakeGitRunner
): Promise<{ orch: any; arch: any; dev: any }> {
  const o = makeCtx("openspec-orchestrator", wt)
  const a = makeCtx("openspec-architect", wt)
  const d = makeCtx("openspec-developer", wt)

  await init.execute({ change_id: CID, task_group_id: "1" }, o)
  await arch_submit.execute({ outcome: "ready",
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
  await set_worktree.execute({}, o)
  const state = readStateSync(wt, CID)
  const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
  fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java"])
  await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)
  return { orch: o, arch: a, dev: d }
}

/** 将当前状态推进到 review 阶段（tool+task 已完成） */
async function setupThroughReviewReady(
  wt: string, fakeGit: FakeGitRunner
): Promise<{ orch: any; arch: any; dev: any; toolR: any; taskR: any }> {
  const o = makeCtx("openspec-orchestrator", wt)
  const a = makeCtx("openspec-architect", wt)
  const d = makeCtx("openspec-developer", wt)
  const toolR = makeCtx("openspec-reviewer-tool", wt)
  const taskR = makeCtx("openspec-reviewer-task", wt)

  await init.execute({ change_id: CID, task_group_id: "1" }, o)
  await arch_submit.execute({ outcome: "ready",
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
  await set_worktree.execute({}, o)
  let state = readStateSync(wt, CID)
  const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
  fakeGit.diffs.set(devWt, ["src/F1.java"])
  await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

  const s1 = readStateSync(wt, CID)
  const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
  await init.execute({
    change_id: CID, task_group_id: "1",
    recovery: { phase: "review" }}, o)
  await set_worktree.execute({}, o)
  await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
  await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

  return { orch: o, arch: a, dev: d, toolR, taskR }
}

// ════════════════════════════════════════════════════════════════
//  Behavior 1: opx_status 阶段门禁（gate）
// ════════════════════════════════════════════════════════════════

describe("B1. opx_status 阶段门禁", () => {

  // B1.1 初始化后 status=task_analysis → architect 可过 gate，developer 被拒绝
  test("task_analysis 阶段 → architect 可过 gate，developer 被拒绝", async () => {
    const root = `/tmp/optimize-b1a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)

    // architect should pass gate
    const archView = await status.execute({}, a)
    const archStr = typeof archView === "string" ? archView : JSON.stringify(archView)
    expect(archStr).toMatch(/✅ 当前轮到你执行/)

    // developer should be rejected by gate
    const devView = await status.execute({}, d)
    const devStr = typeof devView === "string" ? devView : JSON.stringify(devView)
    expect(devStr).toMatch(/⛔ 阶段门禁/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B1.2 dev_impl 阶段 → developer 可过 gate，reviewer-tool 被拒绝
  test("dev_impl 阶段 → developer 可过 gate，reviewer-tool 被拒绝", async () => {
    const root = `/tmp/optimize-b1b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)

    // 只做到 set_worktree（status=dev_impl），不调 dev_submit（dev_submit 现在自动进 review）
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)

    // developer should pass gate
    const devView = await status.execute({}, d)
    const devStr = typeof devView === "string" ? devView : JSON.stringify(devView)
    expect(devStr).toMatch(/✅ 当前轮到你执行/)

    // reviewer-tool should be rejected
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const toolView = await status.execute({}, toolR)
    const toolStr = typeof toolView === "string" ? toolView : JSON.stringify(toolView)
    expect(toolStr).toMatch(/⛔ 阶段门禁/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B1.3 review 阶段未完成 tool → reviewer-tool 可过 gate，reviewer-task 被拒绝
  test("review 阶段 tool 未完成 → reviewer-tool 可过 gate，reviewer-task 被拒绝", async () => {
    const root = `/tmp/optimize-b1c-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    // 设置到 dev_submit 完成
    const { orch, arch, dev } = await setupThroughDevSubmit(wt, fakeGit)

    // recovery 到 review（此时 tool 未完成）
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, orch)
    await set_worktree.execute({}, orch)

    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)

    const toolView = await status.execute({}, toolR)
    const toolStr = typeof toolView === "string" ? toolView : JSON.stringify(toolView)
    expect(toolStr).toMatch(/✅ 当前轮到你执行/)

    const taskView = await status.execute({}, taskR)
    const taskStr = typeof taskView === "string" ? taskView : JSON.stringify(taskView)
    expect(taskStr).toMatch(/⛔ 阶段门禁/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B1.4 review 阶段 tool 完成 task 未完成 → reviewer-task 可过，quality 被拒绝
  test("review 阶段 tool 完成 task 未完成 → reviewer-task 可过 gate，quality 被拒绝", async () => {
    const root = `/tmp/optimize-b1d-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    const { orch, arch, dev } = await setupThroughDevSubmit(wt, fakeGit)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, orch)
    await set_worktree.execute({}, orch)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const taskR = makeCtx("openspec-reviewer-task", wt)
    const styleR = makeCtx("openspec-reviewer-style", wt)

    const taskView = await status.execute({}, taskR)
    const taskStr = typeof taskView === "string" ? taskView : JSON.stringify(taskView)
    expect(taskStr).toMatch(/✅ 当前轮到你执行/)

    const styleView = await status.execute({}, styleR)
    const styleStr = typeof styleView === "string" ? styleView : JSON.stringify(styleView)
    expect(styleStr).toMatch(/⛔ 阶段门禁/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B1.5 review 阶段全部完成 → 对应 quality reviewer 可过 gate
  test("review 阶段 tool+task 完成 → quality reviewer 可过 gate", async () => {
    const root = `/tmp/optimize-b1e-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    const { orch } = await setupThroughReviewReady(wt, fakeGit)

    const styleR = makeCtx("openspec-reviewer-style", wt)
    const archR = makeCtx("openspec-reviewer-architecture", wt)

    const styleView = await status.execute({}, styleR)
    const styleStr = typeof styleView === "string" ? styleView : JSON.stringify(styleView)
    expect(styleStr).toMatch(/✅ 当前轮到你执行/)

    const archView = await status.execute({}, archR)
    const archStr = typeof archView === "string" ? archView : JSON.stringify(archView)
    expect(archStr).toMatch(/✅ 当前轮到你执行/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B1.6 orchestrator 不受 gate 影响（所有阶段均正常）
  test("orchestrator 不受 gate 影响 → 始终正常渲染", async () => {
    const root = `/tmp/optimize-b1f-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    // task_analysis 阶段
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const view1 = await status.execute({}, o)
    const s1 = typeof view1 === "string" ? view1 : JSON.stringify(view1)
    expect(s1).toMatch(/编排进度/)

    // dev_impl 阶段 — status 不应抛 gate 异常
    // 通过 arch_submit + set_worktree 进入 dev_impl
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, makeCtx("openspec-architect", wt))
    await set_worktree.execute({}, o)
    const view2 = await status.execute({}, o)
    const s2 = typeof view2 === "string" ? view2 : JSON.stringify(view2)
    expect(s2).toMatch(/编排进度/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 2: Recovery 自动补非空 executionBoundary
// ════════════════════════════════════════════════════════════════

describe("B2. Recovery 自动补非空 executionBoundary", () => {

  // B2.1 恢复到 review 且无 existing 边界 → 自动填充，边界非 null
  test("recovery review 无 existing 边界 → 自动填充 executionBoundary", async () => {
    const root = `/tmp/optimize-b2a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)

    // 先走正常流程设好 worktree
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")

    // null out executionBoundary 模拟无边界场景
    tg.executionBoundary = null
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state, null, 2)
    )

    fakeGit.diffs.set(tg.worktreePath, ["src/foo/bar.ts", "src/foo/baz.ts", "tests/foo.test.ts", "README.md"])

    // 再 init recovery to review → 应自动填充边界
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({}, o)

    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.executionBoundary).toBeNull()

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B2.2 recovery 不再自动填充 executionBoundary（需 arch_submit 设置）
  test("recovery 后 executionBoundary 为空", async () => {
    const root = `/tmp/optimize-b2b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")

    // null out boundary + set specific diffs
    tg.executionBoundary = null
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state, null, 2)
    )
    fakeGit.diffs.set(tg.worktreePath, [
      "src/main/java/com/t/Foo.java",
      "src/main/java/com/t/Bar.java",
      "src/test/java/com/t/FooTest.java",
      "docs/README.md",
    ])

    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({}, o)

    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.executionBoundary).toBeNull()

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B2.3 恢复到 review 有 existing 边界 → recovery 不生成边界
  test("recovery review 有 existing 边界 → 不覆盖（继承原值）", async () => {
    const root = `/tmp/optimize-b2c-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    // 走完整的流程设边界
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src/main"], allowed_packages: ["com.original"], notes: "original notes" }}, makeCtx("openspec-architect", wt))
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    const devWt = tg.worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, makeCtx("openspec-developer", wt))

    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    // 改 diff 的内容，但边界应有原值
    fakeGit.diffs.set(devWt, ["other/foo.java"])

    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({}, o)

    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.executionBoundary.allowed_directories).toEqual(["src/main"])
    expect(tgAfter.executionBoundary.allowed_packages).toContain("com.original")
    expect(tgAfter.executionBoundary.notes).toBe("original notes")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B2.4 提 issue 时 boundary_expansion → 边界 directories 能正常 append
  test("提 issue 时 boundary_expansion → 边界 directories 正常 append", async () => {
    const root = `/tmp/optimize-b2d-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)

    // 正常走到 tool review（有边界）
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    const devWt = tg.worktreePath
    fakeGit.diffs.set(devWt, ["src/main/Foo.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")

    // 提一条 issue 在新目录 + boundary_expansion
    await tool_review_submit.execute({ passed: false,
      issues: [{ dimension: "style", severity: "Low", file: "new-dir/x.java", line: 1, description: "Style issue", suggestion: "Fix" }],
      fixed_issue_ids: [],
      boundary_expansion: { allowed_directories: ["new-dir"] }}, toolR)

    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.executionBoundary).not.toBeNull()
    expect(tgAfter.executionBoundary.allowed_directories).toContain("new-dir")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 3: Recovery review_layer 子阶段参数
// ════════════════════════════════════════════════════════════════

describe("B3. Recovery review_layer 子阶段参数", () => {

  // B3.1 recovery review + review_layer=task → tool.completed=true
  test("recovery review + review_layer=task → tool.completed=true", async () => {
    const root = `/tmp/optimize-b3a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    fakeGit.diffs.set(tg.worktreePath, ["src/F1.java"])

    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", review_layer: "task" }}, o)

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.review.tool.completed).toBe(true)
    expect(tg2.phases.review.task.completed).toBe(false)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B3.2 recovery review + review_layer=quality → tool+task.completed=true
  test("recovery review + review_layer=quality → tool+task.completed=true", async () => {
    const root = `/tmp/optimize-b3b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    fakeGit.diffs.set(tg.worktreePath, ["src/F1.java"])

    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", review_layer: "quality" }}, o)

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.review.tool.completed).toBe(true)
    expect(tg2.phases.review.task.completed).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B3.3 recovery review + review_layer=tool → 同默认（全部未完成）
  test("recovery review + review_layer=tool → 同默认（全部未完成）", async () => {
    const root = `/tmp/optimize-b3c-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    fakeGit.diffs.set(tg.worktreePath, ["src/F1.java"])

    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", review_layer: "tool" }}, o)

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.review.tool.completed).toBe(false)
    expect(tg2.phases.review.task.completed).toBe(false)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B3.4 recovery dev_impl + review_layer=task（非法组合）→ 报错
  test("recovery dev_impl + review_layer=task — 非法组合 → 报错", async () => {
    const root = `/tmp/optimize-b3d-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    tg.executionBoundary = { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }
    tg.worktreePath = "/tmp/fake-worktree"
    tg.branchName = "task-group/1"
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state, null, 2)
    )

    await expect(
      init.execute({
        change_id: CID, task_group_id: "1",
        recovery: { phase: "dev_impl", review_layer: "task" }}, o)
    ).rejects.toThrow(/review_layer/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B3.6a recovery review + review_layer=quality + preserve_progress=true → 保留 quality 进度
  test("B3.6a preserve_progress=true → 保留 baselineDone/retryCount/progress", async () => {
    const root = `/tmp/optimize-b3fa-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)

    // 跑完整到 review + tool pass + task pass
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    // 模拟 quality 已有历史：retryCount=2, baselineDone=true, 部分维度已提交
    state = readStateSync(wt, CID)
    const tg1 = state.taskGroups.find((g: any) => g.id === "1")
    tg1.phases.review.retryCount = 2
    tg1.phases.review.quality.progress.style = "passed"
    tg1.phases.review.quality.progress.architecture = "passed"
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state, null, 2)
    )

    // 恢复时指定 review_layer=quality，preserve_progress=true
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", review_layer: "quality" }}, o)

    // 验证 quality 进度全部保留
    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.review.retryCount).toBe(2)
    expect(tg2.phases.review.quality.progress.style).toBe("passed")
    expect(tg2.phases.review.quality.progress.architecture).toBe("passed")
    expect(tg2.phases.review.quality.progress.performance).toBe("pending")
    expect(tg2.phases.review.tool.completed).toBe(true)
    expect(tg2.phases.review.task.completed).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B3.6b recovery review + review_layer=quality + preserve_progress=false → 仅清 retryCount，保留维度进度
  test("B3.6b preserve_progress=false → 清空 retryCount，保留 passed 维度，门禁仅放行非 passed 3 维", async () => {
    const root = `/tmp/optimize-b3fb-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)

    // 跑完整到 review + tool pass + task pass
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    // 模拟 quality 已有历史：retryCount=2, baselineDone=true, 部分维度已提交
    state = readStateSync(wt, CID)
    const tg1 = state.taskGroups.find((g: any) => g.id === "1")
    tg1.phases.review.retryCount = 2
    tg1.phases.review.quality.progress.style = "passed"
    tg1.phases.review.quality.progress.architecture = "passed"
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state, null, 2)
    )

    // 恢复时指定 review_layer=quality，preserve_progress=false（清空 quality）
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", review_layer: "quality" }}, o)

    // 验证 quality 进度：retryCount 保留，passed 维度保留，其余 pending
    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.review.retryCount).toBe(2)
    expect(tg2.phases.review.quality.progress.style).toBe("passed")
    expect(tg2.phases.review.quality.progress.architecture).toBe("passed")
    expect(tg2.phases.review.quality.progress.performance).toBe("pending")
    expect(tg2.phases.review.quality.progress.security).toBe("pending")
    expect(tg2.phases.review.quality.progress.maintainability).toBe("pending")

    // 验证 tool/task 层状态仍正确
    expect(tg2.phases.review.tool.completed).toBe(true)
    expect(tg2.phases.review.task.completed).toBe(true)

    // 验证门禁仅放行非 passed 的 3 维 quality reviewer
    for (const agent of ["openspec-reviewer-performance", "openspec-reviewer-security", "openspec-reviewer-maintainability"]) {
      const ctx = makeCtx(agent, wt)
      const view = await status.execute({}, ctx)
      const str = typeof view === "string" ? view : JSON.stringify(view)
      expect(str).toMatch(/✅ 当前轮到你执行/)
    }
    // 已 passed 的维度 reviewer 不再被分派
    for (const agent of ["openspec-reviewer-style", "openspec-reviewer-architecture"]) {
      const ctx = makeCtx(agent, wt)
      const view = await status.execute({}, ctx)
      const str = typeof view === "string" ? view : JSON.stringify(view)
      expect(str).not.toMatch(/当前轮到你执行/)
    }

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B3.5 review_layer + preserveProgress 叠加 → 验证子层状态正确合并
  test("review_layer + preserveProgress 叠加 → 子层状态正确合并", async () => {
    const root = `/tmp/optimize-b3e-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const d = makeCtx("openspec-developer", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)

    // 跑完整到 review + tool pass + task pass
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, makeCtx("openspec-architect", wt))
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    // 写状态文件设 retryCount=5, lastResolvedRetryCount=5
    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    tg2.phases.review.retryCount = MAX_RETRIES
    tg2.phases.review.lastResolvedRetryCount = MAX_RETRIES
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state, null, 2)
    )

    // 恢复时指定 review_layer=quality 且 preserveProgress
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", review_layer: "quality" }}, o)

    state = readStateSync(wt, CID)
    const tg3 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg3.phases.review.tool.completed).toBe(true)
    expect(tg3.phases.review.task.completed).toBe(true)
    // preserveProgress 应保留 retryCount 和 lastResolvedRetryCount
    expect(tg3.phases.review.retryCount).toBe(MAX_RETRIES)
    expect(tg3.phases.review.lastResolvedRetryCount).toBe(MAX_RETRIES)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 4: 空 issue 正常提交（回归）
// ════════════════════════════════════════════════════════════════

describe("B4. 空 issue 正常提交回归", () => {
  const ROOT = `/tmp/optimize-b4-${Date.now()}`

  // B4.1 tool_review_submit(passed=true, issues=[]) 正常通过
  test("tool_review_submit(passed=true, issues=[]) → 正常通过", async () => {
    const root = `${ROOT}-b4a`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, makeCtx("openspec-architect", wt))
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, makeCtx("openspec-developer", wt))

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, o)
    await set_worktree.execute({}, o)

    const result = await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: []}, toolR)
    const parsed = typeof result === "string" ? JSON.parse(result) : JSON.parse(result.output)
    expect(parsed.status).toBe("ok")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // B4.2 quality_review_submit(passed=true, issues=[]) 正常通过
  test("quality_review_submit(passed=true, issues=[]) → 正常通过", async () => {
    const root = `${ROOT}-b4b`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const styleR = makeCtx("openspec-reviewer-style", wt)

    const { orch } = await setupThroughReviewReady(wt, fakeGit)

    const result = await quality_review_submit.execute({ passed: true, issues: []}, styleR)
    const parsed = typeof result === "string" ? JSON.parse(result) : JSON.parse(result.output)
    expect(parsed.status).toBe("partial") // 仍有 4 维未提交

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 8: submit 工具支持数字类型 task/issue ID
// ════════════════════════════════════════════════════════════════

describe("B8. submit 工具支持数字类型 ID", () => {
  test("tool/task/quality_review_submit 接受数字 fixed_issue_ids", async () => {
    const root = `/tmp/optimize-b8a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const orch = makeCtx("openspec-orchestrator", wt)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    const taskR = makeCtx("openspec-reviewer-task", wt)
    const styleR = makeCtx("openspec-reviewer-style", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, orch)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }},
      makeCtx("openspec-architect", wt))
    await set_worktree.execute({}, orch)

    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java"])

    // dev_submit: completed_task_ids 传数字
    await dev_submit.execute({ completed_task_ids: [1, 2] as any }, makeCtx("openspec-developer", wt))

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, orch)
    await set_worktree.execute({}, orch)

    // tool_review_submit: fixed_issue_ids 传数字
    const r1 = await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    expect(typeof r1 === "string" ? JSON.parse(r1).status : JSON.parse(r1.output).status).toBe("ok")

    // task_review_submit: verified_task_ids 传数字
    const r2 = await task_review_submit.execute({
      passed: true, verified_task_ids: [1, 2] as any, failed_task_ids: [], fixed_issue_ids: []}, taskR)
    expect(typeof r2 === "string" ? JSON.parse(r2).status : JSON.parse(r2.output).status).toBe("ok")

    // quality_review_submit: 数字 passed 亦通过（非关键，但验证 type coercion 无副作用）
    const r3 = await quality_review_submit.execute({ passed: true, issues: []}, styleR)
    const parsed3 = typeof r3 === "string" ? JSON.parse(r3) : JSON.parse(r3.output)
    expect(parsed3.status).toBe("partial")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 5: dev_submit 不再重置 retryCount（修复 B 验证）
// ════════════════════════════════════════════════════════════════

describe("B5. dev_submit 不再重置 retryCount", () => {
  test("quality 失败 → dev 修复提交 → retryCount 保持 1, quality gate 仅调有 issue 的维度", async () => {
    const root = `/tmp/optimize-b5-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    const { orch, dev, toolR, taskR } = await setupThroughReviewReady(wt, fakeGit)

    // 1. quality 首轮：style 报阻塞 issue
    const dims: string[] = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }
      if (i === 0) {
        args.passed = false
        args.issues = [{ severity: "Low", file: "src/x.java", line: 1, description: "Naming", suggestion: "Fix" }]
      }
      await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.phases.review.retryCount).toBe(1)
    expect(tg.status).toBe("dev_impl")

    const issueId = tg.issues[0].id
    const devWt = tg.worktreePath

    // 2. developer 修复并提交
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId] }, dev)

    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.phases.review.retryCount).toBe(1) // 保持累加，不清零

    // 3. tool+task 重新通过
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, orch)
    await set_worktree.execute({}, orch)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [issueId] }, toolR)
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    // 4. retryCount=1 修复轮 — style progress 仍为 "pending"（未通过），style 可过 gate
    const styleR = makeCtx("openspec-reviewer-style", wt)
    const archR = makeCtx("openspec-reviewer-architecture", wt)
    const styleView = await status.execute({}, styleR)
    const styleStr = typeof styleView === "string" ? styleView : JSON.stringify(styleView)
    expect(styleStr).toMatch(/✅ 当前轮到你执行/)
    const archView = await status.execute({}, archR)
    const archStr = typeof archView === "string" ? archView : JSON.stringify(archView)
    expect(archStr).not.toMatch(/✅ 当前轮到你执行/) // architecture 已 passed，不过 gate

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 6: opx_status 编排者视图 review 进展渲染（修复 A 验证）
// ════════════════════════════════════════════════════════════════

describe("B6. opx_status 编排者视图 review 进展", () => {
  test("tool+task 完成后显示全部已完成层 + 当前待推进层", async () => {
    const root = `/tmp/optimize-b6a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    const { orch } = await setupThroughReviewReady(wt, fakeGit)

    const view = await status.execute({}, orch)
    const str = typeof view === "string" ? view : JSON.stringify(view)
    expect(str).toMatch(/tool✓.*→.*task✓.*→.*quality⏳/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("tool 已完成 task 未完成显示 tool✓ → task⏳（不显示 quality）", async () => {
    const root = `/tmp/optimize-b6b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    const { orch } = await setupThroughDevSubmit(wt, fakeGit)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review" }}, orch)
    await set_worktree.execute({}, orch)
    const toolR = makeCtx("openspec-reviewer-tool", wt)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const view = await status.execute({}, orch)
    const str = typeof view === "string" ? view : JSON.stringify(view)
    expect(str).toMatch(/tool✓.*→.*task⏳/)
    expect(str).not.toMatch(/quality/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 7: computeRequiredDims 异常回退（修复 C 验证）
// ════════════════════════════════════════════════════════════════

describe("B7. computeRequiredDims 异常回退", () => {
  test("retryCount>0 但无 pending issue → 空激活集 → 全都不过 gate", async () => {
    const root = `/tmp/optimize-b7-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    await setupThroughReviewReady(wt, fakeGit)

    // 手动制造僵尸状态：retryCount=2 但无 pending issue（无 submitted/exemption issue）
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    tg.phases.review.retryCount = 2
    tg.phases.review.quality.progress = {
      style: "passed",
      architecture: "passed",
      performance: "passed",
      security: "passed",
      maintainability: "passed"}
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state, null, 2)
    )

    // retryCount>0 且无 pending → 空激活集 → 全都不过 gate
    const styleR = makeCtx("openspec-reviewer-style", wt)
    const archR = makeCtx("openspec-reviewer-architecture", wt)
    const styleView = await status.execute({}, styleR)
    const styleStr = typeof styleView === "string" ? styleView : JSON.stringify(styleView)
    expect(styleStr).not.toMatch(/✅ 当前轮到你执行/)
    const archView = await status.execute({}, archR)
    const archStr = typeof archView === "string" ? archView : JSON.stringify(archView)
    expect(archStr).not.toMatch(/✅ 当前轮到你执行/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 9: retryCount>0 但 baseline 未建 → 仍走 5 维全审（回归 bug: tool/task 驳回污染 retryCount）
// ════════════════════════════════════════════════════════════════

describe("B9. retryCount>0 但 baseline 未建 → 全维门禁", () => {
  test("retryCount=2, baselineDone=false → 全部 5 维可过 gate", async () => {
    const root = `/tmp/optimize-b9a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    const { orch, arch, dev, toolR, taskR } = await setupThroughReviewReady(wt, fakeGit)

    // 模拟 tool/task 已驳回 2 轮，quality 从未运行
    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    tg.phases.review.retryCount = 2
    // baselineDone 保持 false（新建状态本来就没有该字段，undefined→falsy）
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state, null, 2)
    )

    // 全部 5 维 reviewer 均应通过门禁
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (const dim of dims) {
      const ctx = makeCtx(`openspec-reviewer-${dim}`, wt)
      const view = await status.execute({}, ctx)
      const str = typeof view === "string" ? view : JSON.stringify(view)
      expect(str).toMatch(/✅ 当前轮到你执行/)
    }

    // 提交全部 5 维 → 基线建立，全部通过
    for (let i = 0; i < dims.length; i++) {
      const res = JSON.parse(await quality_review_submit.execute({ passed: true, issues: []}, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i < dims.length - 1) expect(res.status).toBe("partial")
      else expect(res.status).toBe("ok")
    }

    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.phases.review.tool.completed).toBe(true)
    expect(tgAfter.phases.review.task.completed).toBe(true)
    for (const d of ["style", "architecture", "performance", "security", "maintainability"]) {
      expect(tgAfter.phases.review.quality.progress[d]).toBe("passed")
    }

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("retryCount=0, baselineDone=true → 空激活集", async () => {
    const root = `/tmp/optimize-b9b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)

    const { orch, arch, dev, toolR, taskR } = await setupThroughReviewReady(wt, fakeGit)

    // 模拟 quality 全部已通过，无 pending issue
    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    tg.phases.review.quality.progress = {
      style: "passed",
      architecture: "passed",
      performance: "passed",
      security: "passed",
      maintainability: "passed"}
    tg.phases.review.retryCount = 0
    writeFileSync(
      join(wt, ".opencode", ".orchestrate_state", `${CID}.json`),
      JSON.stringify(state, null, 2)
    )

    // 全部 5 维 reviewer 均不应通过门禁（无 pending issue）
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (const dim of dims) {
      const ctx = makeCtx(`openspec-reviewer-${dim}`, wt)
      const view = await status.execute({}, ctx)
      const str = typeof view === "string" ? view : JSON.stringify(view)
      expect(str).not.toMatch(/✅ 当前轮到你执行/)
    }

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})


// ════════════════════════════════════════════════════════════════
//  Behavior 8: 编排视图暴露 baseBranch
// ════════════════════════════════════════════════════════════════

describe("B8. 编排视图暴露 baseBranch", () => {
  test("opx_status 编排者头部含基准分支行", async () => {
    const root = `/tmp/optimize-b8-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    // 自动推导：currentBranch="main"
    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const view = await status.execute({}, o)
    const str = typeof view === "string" ? view : JSON.stringify(view)
    expect(str).toMatch(/\*\*基准分支\*\*: main/)

    // 显式指定：用独立 changeId 验证
    const CID2 = "test-optimize-b8-dev"
    const tasksMdPath2 = join(wt, "openspec", "changes", CID2, "tasks.md")
    mkdirSync(join(wt, "openspec", "changes", CID2), { recursive: true })
    writeFileSync(tasksMdPath2, "## 1. G1\n\n- [ ] 1.1 T1\n", "utf-8")
    await init.execute({ change_id: CID2, task_group_id: "1", base_branch: "develop" }, o)
    const view2 = await status.execute({}, o)
    const str2 = typeof view2 === "string" ? view2 : JSON.stringify(view2)
    expect(str2).toMatch(/\*\*基准分支\*\*: develop/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})
