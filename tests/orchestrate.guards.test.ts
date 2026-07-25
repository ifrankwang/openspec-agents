/**
 * 编排守卫测试：阶段校验、身份校验、重复提交校验
 *
 * 与 flow test 分离——这些测试校验工具的门禁逻辑，非完整流程场景。
 * 每项测试针对单一守卫条件，不依赖完整流程上下文。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  init,
  set_worktree,
  arch_submit,
  dev_submit,
  tool_review_submit,
  task_review_submit,
  quality_review_submit,
  __setGitRunner} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-guard"
afterAll(() => { __setGitRunner(null) })

const FORBIDDEN_ORCHESTRATION = [
  "从 tool 层", "从 task 层", "从 quality 层",
  "请分派", "请调用",
  "进入 review", "进入 quality", "进入 task", "进入 dev",
  "重新开始",
  "下一步：",
]

function expectNoOrchestration(msg: string | undefined) {
  expect(msg).toBeDefined()
  expect(typeof msg).toBe("string")
  for (const p of FORBIDDEN_ORCHESTRATION) {
    expect(msg!).not.toContain(p)
  }
  expect(msg).toContain("职责已完成，请立即结束当前会话")
}

function setupWt(root: string, wt: string): string {
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2\n`,
    "utf-8"
  )
  return wt
}

function readStateSync(wt: string, cid: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${cid}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

async function setupToReview(wt: string, fakeGit: FakeGitRunner) {
  const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
       d = makeCtx("openspec-developer", wt),
       toolR = makeCtx("openspec-reviewer-tool", wt),
       taskR = makeCtx("openspec-reviewer-task", wt)
  await init.execute({ change_id: CID, task_group_id: "1" }, o)
  await arch_submit.execute({ outcome: "ready",
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
  await set_worktree.execute({}, o)
  fakeGit.diffs.set(wt, ["src/T.java"])
  await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

  // Transition to review + tool + task
  const state = readStateSync(wt, CID)
  const tg = state.taskGroups.find((g: any) => g.id === "1")
  await init.execute({
    change_id: CID, task_group_id: "1",
    recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
  await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
  await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
}

// ── G1: set_worktree before arch_submit ──

describe("G1. set_worktree 守卫已移除", () => {
  test("init 后直接调 set_worktree → 成功", async () => {
    const root = `/tmp/guard-g1-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const result = JSON.parse(await set_worktree.execute({}, o))
    expect(result.status).toBe("ok")
    expect(result.worktree_path).toBeTruthy()
    expect(result.base_ref).toBeTruthy()

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G1.2: set_worktree 自修复 ──

describe("G1.2. set_worktree 自修复", () => {
  test("change 目录有未提交变更 → auto-commit", async () => {
    const root = `/tmp/guard-g1-2a-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    fakeGit.dirtyPaths.add(`${wt}-openspec`)
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const result = JSON.parse(await set_worktree.execute({}, o))
    expect(result.status).toBe("ok")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("已有 worktree 可 fast-forward → merge + 复用", async () => {
    const root = `/tmp/guard-g1-2b-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)

    let result = JSON.parse(await set_worktree.execute({}, o))
    expect(result.status).toBe("ok")
    expect(result.reused).toBe(false)

    result = JSON.parse(await set_worktree.execute({}, o))
    expect(result.status).toBe("ok")
    expect(result.reused).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("已有 worktree 分叉 + clean → 清理重建", async () => {
    const root = `/tmp/guard-g1-2c-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)

    let result = JSON.parse(await set_worktree.execute({}, o))
    expect(result.status).toBe("ok")
    expect(result.reused).toBe(false)

    fakeGit.mergeConflictOnNext = true
    result = JSON.parse(await set_worktree.execute({}, o))
    expect(result.status).toBe("ok")
    expect(result.reused).toBe(false)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("已有 worktree 分叉 + dirty → 抛错", async () => {
    const root = `/tmp/guard-g1-2d-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)

    const result = JSON.parse(await set_worktree.execute({}, o))
    expect(result.status).toBe("ok")

    fakeGit.mergeConflictOnNext = true
    const wtPath = join(wt, ".worktree", "task-group-1")
    fakeGit.dirtyPaths.add(wtPath)

    await expect(set_worktree.execute({}, o)).rejects.toThrow(/分叉且有未提交变更/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G1.1: dev_submit worktree 守卫 ──

describe("G1.1. dev_submit worktree 守卫", () => {
  test("跳过 set_worktree 直接 dev_submit → throws", async () => {
    const root = `/tmp/guard-g1-1-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)
    const d = makeCtx("openspec-developer", wt)
    const a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await expect(
      dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)
    ).rejects.toThrow(/worktree 或 baseRef/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G2: 身份守卫 ──

describe("G2. 身份守卫", () => {
  test("non-orchestrator 调 init → throws", async () => {
    const dev = makeCtx("openspec-developer", "/tmp")
    await expect(init.execute({ change_id: CID, task_group_id: "1" }, dev)).rejects.toThrow(
      /仅限编排者/
    )
  })

  test("architect 调 quality_review_submit → throws", async () => {
    const root = `/tmp/guard-g2-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    // Transition to review + tool + task
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    await expect(
      quality_review_submit.execute({ passed: true, issues: [] }, a)
    ).rejects.toThrow(/openspec-reviewer-style/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G3: 重复提交 ──

describe("G3. 重复提交守卫", () => {
  test("同维度 quality reviewer 重复提交 → throws", async () => {
    const root = `/tmp/guard-g3-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt),
         s = makeCtx("openspec-reviewer-style", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    // Transition to review + tool + task
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    await quality_review_submit.execute({ passed: true, issues: [] }, s)
    await expect(
      quality_review_submit.execute({ passed: true, issues: [] }, s)
    ).rejects.toThrow(/不允许重复提交/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G4: arch_submit 仅接受 outcome ──

describe("G4. arch_submit 参数守卫", () => {
  test("arch_submit(passed) → throws，拒绝旧 API", async () => {
    const root = `/tmp/guard-g4-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await expect(
      arch_submit.execute({ passed: true,
        execution_boundary: { allowed_directories: ["src"], allowed_packages: [], notes: "" }} as any, a)
    ).rejects.toThrow(/outcome/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("arch_submit(outcome, passed) → throws，拒绝新旧参数混用", async () => {
    const root = `/tmp/guard-g4-mixed-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await expect(
      arch_submit.execute({ outcome: "ready", passed: true,
        execution_boundary: { allowed_directories: ["src"], allowed_packages: [], notes: "" }} as any, a)
    ).rejects.toThrow(/passed/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G4.1: 重复 init 保持当前活跃阶段 ──

describe("G4.1. init 重入", () => {
  test("无 recovery 重复 init 保留 dev_impl，返回与持久化状态一致", async () => {
    const root = `/tmp/guard-g4-init-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: [], notes: "" }}, a)

    const result = JSON.parse(await init.execute({ change_id: CID, task_group_id: "1" }, o))
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(result.active_phase).toBe("dev_impl")
    expect(tg.status).toBe("dev_impl")
    expect(tg.phases.architect_review.completed).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G5: 非法 task id ──

describe("G5. 非法 task id 守卫", () => {
  test("task_review_submit 传不存在的 task id → throws", async () => {
    const root = `/tmp/guard-g5-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    // Transition to review + tool pass
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      task_review_submit.execute({ passed: true,
        verified_task_ids: ["99"], failed_task_ids: [],
        fixed_issue_ids: []}, taskR)
    ).rejects.toThrow(/非法 task id/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G6: task_review_submit 完整性门禁 ──

describe("G6. task_review_submit 完整性门禁", () => {
  test("已提交 task 但 verified+failed 均为空 → throws", async () => {
    const root = `/tmp/guard-g6-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    // Transition to review + tool pass
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      task_review_submit.execute({ passed: true,
        verified_task_ids: [], failed_task_ids: [],
        fixed_issue_ids: []}, taskR)
    ).rejects.toThrow(/以下 submitted task 未被/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("worktree dirty → task_review_submit throws (reviewer no longer commits api-tests)", async () => {
    const root = `/tmp/guard-g6-dirty-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    fakeGit.dirtyPaths.add(tg.worktreePath)

    await expect(
      task_review_submit.execute({ passed: true,
        verified_task_ids: ["1", "2"], failed_task_ids: [],
        fixed_issue_ids: []}, taskR)
    ).rejects.toThrow(/存在未 commit 内容/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("worktree clean → normal submit", async () => {
    const root = `/tmp/guard-g6-clean-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const result = await task_review_submit.execute({ passed: true,
      verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: []}, taskR)
    expect(result).toBeDefined()

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("validation_steps with all completed → accepted and stored in state", async () => {
    const root = `/tmp/guard-valsteps-ok-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const valSteps = [
      { step: "Task 产出验证", completed: true, evidence: "编译通过，产出文件完整" },
      { step: "服务启动验证", completed: true, evidence: "服务启动成功，健康检查通过" },
      { step: "API 测试验证", completed: true, evidence: "3 个 .http 脚本全部通过" },
      { step: "UT 测试质量审查", completed: true, evidence: "覆盖率和质量达标" },
    ]

    const result = JSON.parse(await task_review_submit.execute({
      passed: true,
      verified_task_ids: ["1", "2"],
      failed_task_ids: [],
      fixed_issue_ids: [],
      validation_steps: valSteps,
    }, taskR))
    expect(result.status).toBe("ok")

    // Verify stored in state
    const savedState = readStateSync(wt, CID)
    const savedTg = savedState.taskGroups.find((g: any) => g.id === "1")
    expect(savedTg.phases.review.task.validationSteps).toBeDefined()
    expect(savedTg.phases.review.task.validationSteps).toHaveLength(4)
    expect(savedTg.phases.review.task.validationSteps[0].step).toBe("Task 产出验证")
    expect(savedTg.phases.review.task.validationSteps[0].completed).toBe(true)
    expect(savedTg.phases.review.task.validationSteps[0].evidence).toBe("编译通过，产出文件完整")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("validation_steps with skipped step missing skip_reason → throws", async () => {
    const root = `/tmp/guard-valsteps-miss-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      task_review_submit.execute({
        passed: true,
        verified_task_ids: ["1", "2"],
        failed_task_ids: [],
        fixed_issue_ids: [],
        validation_steps: [
          { step: "Task 产出验证", completed: true },
          { step: "API 测试验证", completed: false },  // missing skip_reason
        ],
      }, taskR)
    ).rejects.toThrow(/跳过原因/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("validation_steps with skipped step and valid skip_reason → accepted", async () => {
    const root = `/tmp/guard-valsteps-skip-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const result = JSON.parse(await task_review_submit.execute({
      passed: true,
      verified_task_ids: ["1", "2"],
      failed_task_ids: [],
      fixed_issue_ids: [],
      validation_steps: [
        { step: "Task 产出验证", completed: true, evidence: "编译通过" },
        { step: "API 测试验证", completed: false, skip_reason: "本次变更为内部重构，非 API 契约变更" },
      ],
    }, taskR))
    expect(result.status).toBe("ok")

    // Verify stored in state
    const savedState = readStateSync(wt, CID)
    const savedTg = savedState.taskGroups.find((g: any) => g.id === "1")
    expect(savedTg.phases.review.task.validationSteps[1].completed).toBe(false)
    expect(savedTg.phases.review.task.validationSteps[1].skip_reason).toBe("本次变更为内部重构，非 API 契约变更")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G7: 非法 task id in failed_task_ids ──

describe("G7. 非法 task id in failed_task_ids", () => {
  test("failed_task_ids 含非法 task id → throws", async () => {
    const root = `/tmp/guard-g7-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    // Transition to review + tool pass
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      task_review_submit.execute({ passed: false,
        verified_task_ids: ["1"], failed_task_ids: [{ task_id: "999", reason: "Invalid" }],
        fixed_issue_ids: []}, taskR)
    ).rejects.toThrow(/非法 task id/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G8: tool 层未完成时 task 层不可提交 ──

describe("G8. tool 层完成守卫", () => {
  test("tool 层未完成时调用 task_review_submit → throws", async () => {
    const root = `/tmp/guard-g8-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    // Transition to review (without tool layer)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await expect(
      task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
        fixed_issue_ids: []}, taskR)
    ).rejects.toThrow(/tool 层审核未完成/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G9: dev_submit 非法参数 ──

describe("G9. dev_submit 非法参数", () => {
  test("request_exempts 含不存在的 issue id → throws", async () => {
    const root = `/tmp/guard-g9-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupToReview(wt, fakeGit)
    await quality_review_submit.execute({ passed: false,
      issues: [{ severity: "Low", file: "x.java", line: 1, description: "Style", suggestion: "Fix" }]}, sCtx)

    await expect(
      dev_submit.execute({ completed_task_ids: ["1", "2"], request_exempts: [{ issue_id: "fake-id", reason: "Test" }] }, d)
    ).rejects.toThrow(/不在.*issue 清单/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G10: 重复操作守卫 ──

describe("G10. 重复操作守卫", () => {
  test("已豁免的 issue 重复申请豁免 → throws", async () => {
    const root = `/tmp/guard-g10-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await setupToReview(wt, fakeGit)

    // Quality: all pass with Info issue (non-blocking → passed=true works)
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (i === 0) {
        args.issues = [{ severity: "Info", file: "x.java", line: 1, description: "Info issue", suggestion: "Consider" }]
      }
      await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    const base = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
    let state = JSON.parse(readFileSync(base, "utf-8"))
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id

    // dev_submit in review: request exemption
    const s1 = readStateSync(wt, CID)
    const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg1.worktreePath, branch_name: tg1.branchName, preserve_progress: true }}, o)
    await dev_submit.execute({ completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Lib" }] }, d)

    // dev_submit reset layers. Re-run tool+task with exemption.
    const s2 = readStateSync(wt, CID)
    const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg2.worktreePath, branch_name: tg2.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [],
      exempt_issue_ids: [issueId]}, toolR)
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: []}, taskR)

    // Now issue is exempted. Try duplicate exemption → throws.
    await expect(
      dev_submit.execute({ completed_task_ids: ["1", "2"], request_exempts: [{ issue_id: issueId, reason: "Again" }] }, d)
    ).rejects.toThrow(/已被豁免/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G11: quality_review_submit 维度参数验证 ──

describe("G11. quality_review_submit 参数验证", () => {
  test("非 tool 维度的 issue 缺 suggestion → throws", async () => {
    const root = `/tmp/guard-g11-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupToReview(wt, fakeGit)
    await expect(
      quality_review_submit.execute({ passed: false,
        issues: [{ severity: "Low", file: "x.java", line: 1, description: "Issue without suggestion" }]}, sCtx)
    ).rejects.toThrow(/suggestion/)
  })

  test("tool_review_submit 的 issue 缺 dimension → throws", async () => {
    const root = `/tmp/guard-g11b-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    // Transition to review (tool NOT completed)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await expect(
      tool_review_submit.execute({ passed: false,
        issues: [{ severity: "High", file: "x.java", line: 1, description: "Issue without dimension" }] as any}, toolR)
    ).rejects.toThrow(/dimension/)
  })
})

// ── G12: task 层未完成时 quality 层不可提交 ──

describe("G12. task 层完成守卫", () => {
  test("task 层未完成时调用 quality_review_submit → throws", async () => {
    const root = `/tmp/guard-g12-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      quality_review_submit.execute({ passed: true, issues: [] }, makeCtx("openspec-reviewer-style", wt))
    ).rejects.toThrow(/task 层审核未完成/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G13: tool 层重复提交守卫 ──

describe("G13. tool 层重复提交守卫", () => {
  test("tool 层完成后再次提交 → throws", async () => {
    const root = `/tmp/guard-g13-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await expect(
      tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    ).rejects.toThrow(/不允许重复提交/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G14: task 层重复提交守卫 ──

describe("G14. task 层重复提交守卫", () => {
  test("task 层完成后再次提交 → throws", async () => {
    const root = `/tmp/guard-g14-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
    // Re-submission with all tasks verified → idempotent (no throw)
    const reResult = JSON.parse(await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: []}, taskR))
    expect(reResult.status).toBe("ok")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G15: 豁免完整性门禁 ──

describe("G15. 豁免完整性门禁", () => {
  test("存在 exemption 但未传入 exempt_issue_ids 或 rejected_issue_ids → throws", async () => {
    const root = `/tmp/guard-g15-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const s1 = readStateSync(wt, CID)
    const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg1.worktreePath, branch_name: tg1.branchName, preserve_progress: true }}, o)
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (i === 0) {
        args.issues = [{ severity: "Info", file: "x.java", line: 1, description: "Style info", suggestion: "Consider" }]
      }
      await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    const s2 = readStateSync(wt, CID)
    const issueId = s2.taskGroups.find((g: any) => g.id === "1").issues[0].id

    const devWt = s2.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, [])
    await dev_submit.execute({ completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Trivial" }]}, d)

    const s3 = readStateSync(wt, CID)
    const tg3 = s3.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg3.worktreePath, branch_name: tg3.branchName, preserve_progress: true }}, o)

    // tool 层仅看到 sourcePhase="tool" 的 exemption，quality 层 issue 的 exemption 跳过
    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    // task 层仅看到 sourcePhase="task" 的 exemption，同样跳过
    await task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
    // quality（style）层必须处理自己维度的 exemption 才能提交
    await expect(
      quality_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, makeCtx("openspec-reviewer-style", wt))
    ).rejects.toThrow(/未被 fixed_issue_ids、exempt_issue_ids 或 rejected_issue_ids 覆盖/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G16: tool/task 层失败回退 dev_impl ──

describe("G16. 层失败回退 dev_impl", () => {
  test("tool 层 failed → status 变为 dev_impl，后续层级调用被拒", async () => {
    const root = `/tmp/guard-g16a-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    const toolOut = await tool_review_submit.execute({ passed: false, issues: [], fixed_issue_ids: [] }, toolR)
    const r = typeof toolOut === "string" ? toolOut : toolOut.output
    const parsed = JSON.parse(r)
    expect(parsed.status).toBe("recorded")
    expectNoOrchestration(parsed.message)

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.status).toBe("dev_impl")
    expect(tg2.phases.review.retryCount).toBe(1)

    await expect(
      task_review_submit.execute({ passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
    ).rejects.toThrow(/需在 review 阶段调用/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("task 层 failed → status 变为 dev_impl，后续层级调用被拒", async () => {
    const root = `/tmp/guard-g16b-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    // task fails — rely on state assertions for type safety
    const toolOut = await task_review_submit.execute({ passed: false,
      verified_task_ids: ["1"], failed_task_ids: [{ task_id: "2", reason: "Incomplete" }],
      fixed_issue_ids: []}, taskR)
    const jsonStr = typeof toolOut === "string" ? toolOut : toolOut.output
    const parsed = JSON.parse(jsonStr)
    expect(parsed.status).toBe("recorded")
    expectNoOrchestration(parsed.message)

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.status).toBe("dev_impl")
    expect(tg2.phases.review.retryCount).toBe(1)

    await expect(
      quality_review_submit.execute({ passed: true, issues: [] }, makeCtx("openspec-reviewer-style", wt))
    ).rejects.toThrow(/需在 review 阶段调用/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G17: rejectReason 存储 ──

describe("G17. rejectReason 存储", () => {
  test("task 驳回时 rejectReason 正确写入", async () => {
    const root = `/tmp/guard-g17-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await task_review_submit.execute({ passed: false,
      verified_task_ids: ["1"], failed_task_ids: [{ task_id: "2", reason: "Output file not found at expected path" }],
      fixed_issue_ids: []}, taskR)

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    const failedTask = tg2.tasks.find((t: any) => t.id === "2")
    expect(failedTask.status).toBe("rejected")
    expect(failedTask.rejectReason).toBe("Output file not found at expected path")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G19: task_review_submit 同步 tasks.md 复选框 ──

describe("G19. task_review_submit 同步 tasks.md 复选框", () => {
  test("verified task 所在行 [ ] → [x]", async () => {
    const root = `/tmp/guard-g19-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    // 验证提交前 worktree 中 tasks.md 为 [ ]
    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    const tasksMdPath = join(tg2.worktreePath, "openspec", "changes", CID, "tasks.md")
    const before = readFileSync(tasksMdPath, "utf-8")
    expect(before).toContain("- [ ] 1.1 T1")
    expect(before).toContain("- [ ] 1.2 T2")

    // 提交 task review（标记全部 verified）
    await task_review_submit.execute({ passed: true,
      verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: []}, taskR)

    // 验证 worktree 中 tasks.md 复选框已同步
    const after = readFileSync(tasksMdPath, "utf-8")
    expect(after).toContain("- [x] 1.1 T1")
    expect(after).toContain("- [x] 1.2 T2")
    expect(after).not.toContain("- [ ] 1.1 T1")
    expect(after).not.toContain("- [ ] 1.2 T2")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("partially failed → passed=false → no checkbox marking", async () => {
    const root = `/tmp/guard-g19-negative-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    // 提交 task review，1 verified 1 failed → passed=false
    await task_review_submit.execute({ passed: false,
      verified_task_ids: ["1"], failed_task_ids: [{ task_id: "2", reason: "not working" }],
      fixed_issue_ids: []}, taskR)

    // 验证 tasks.md 在 worktree 中未被标记
    const stateAfter = readStateSync(wt, CID)
    const tgAfter = stateAfter.taskGroups.find((g: any) => g.id === "1")
    const tasksMdPath = join(tgAfter.worktreePath, "openspec", "changes", CID, "tasks.md")
    const content = readFileSync(tasksMdPath, "utf-8")
    expect(content).toContain("- [ ] 1.1 T1")
    expect(content).toContain("- [ ] 1.2 T2")
    expect(content).not.toContain("- [x]")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G18: tool_review_submit test_results 参数 ──

describe("G18. tool_review_submit test_results 参数", () => {
  test("提交时携带 test_results 并正确写入 state", async () => {
    const root = `/tmp/guard-g18-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    const result = await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [],
      test_results: "Tests run: 42, Passed: 42, Failed: 0"}, toolR)

    const parsed = typeof result === "string" ? JSON.parse(result) : JSON.parse(result.output)
    expect(parsed.status).toBe("ok")

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.review.tool.testResults).toBe("Tests run: 42, Passed: 42, Failed: 0")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G20: passed=false 守卫放宽 + B2 task.completed 不 auto-set ──

describe("G20. passed=false 守卫放宽 + B2 task.completed 不 auto-set", () => {
  test("passed=false + empty failed_task_ids + Medium task issue → ok", async () => {
    const root = `/tmp/guard-g20a-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    const result = await task_review_submit.execute({ passed: false,
      verified_task_ids: ["1", "2"], failed_task_ids: [],
      issues: [{ severity: "Medium", file: "x.java", line: 1, description: "Task issue", suggestion: "Fix" }],
      fixed_issue_ids: []}, taskR)
    const parsed = typeof result === "string" ? JSON.parse(result) : JSON.parse(result.output)
    expect(parsed.status).toBe("recorded")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("passed=false + empty failed_task_ids + Info issue → throws", async () => {
    const root = `/tmp/guard-g20b-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      task_review_submit.execute({ passed: false,
        verified_task_ids: ["1", "2"], failed_task_ids: [],
        issues: [{ severity: "Info", file: "x.java", line: 1, description: "Task issue", suggestion: "Fix" }],
        fixed_issue_ids: []}, taskR)
    ).rejects.toThrow(/passed=false/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("dev 修复 source=task issue 后 task.completed 不被 auto-set", async () => {
    const root = `/tmp/guard-g20c-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true }}, o)

    await tool_review_submit.execute({ passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    // Task pass with Info issue (non-blocking → passed=true works)
    await task_review_submit.execute({ passed: true,
      verified_task_ids: ["1", "2"], failed_task_ids: [],
      issues: [{ severity: "Info", file: "x.java", line: 1, description: "Minor", suggestion: "Polish" }],
      fixed_issue_ids: []}, taskR)

    const s1 = readStateSync(wt, CID)
    const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
    const issueId = tg1.issues[0].id

    // dev_submit to fix the task issue
    fakeGit.diffs.set(tg1.worktreePath, ["src/T.java"])
    await dev_submit.execute({ completed_task_ids: ["1", "2"], fixed_issue_ids: [issueId] }, d)

    const s2 = readStateSync(wt, CID)
    const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.review.task.completed).toBe(false)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G21: dev_submit completed_task_ids 校验 ──

describe("G21. dev_submit completed_task_ids 校验", () => {
  const CID = "test-guard-completed"

  function setupWt(root: string, wt: string): string {
    mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
    writeFileSync(
      join(wt, "openspec", "changes", CID, "tasks.md"),
      `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2\n`,
      "utf-8"
    )
    return wt
  }

  function readStateSync(wt: string): any {
    const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, "utf-8"))
  }

  test("不传 completed_task_ids + 有 open task → 报错 open/rejected 状态", async () => {
    const root = `/tmp/guard-g21a-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    const state = readStateSync(wt)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/T.java"])

    await expect(
      dev_submit.execute({}, d)
    ).rejects.toThrow(/以下 task 处于 open\/rejected 状态/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("completed_task_ids 漏掉某 open task 时报错，消息含 task id 和 title", async () => {
    const root = `/tmp/guard-g21b-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    const state = readStateSync(wt)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/T.java"])

    await expect(
      dev_submit.execute({ completed_task_ids: ["1"] }, d)
    ).rejects.toThrow(/以下 task 处于 open\/rejected 状态且未在 completed_task_ids 中.*#2.*T2/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("所有 open task 均在 completed_task_ids 中 → 提交成功", async () => {
    const root = `/tmp/guard-g21c-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    const state = readStateSync(wt)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/T.java"])

    const result = await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)
    const parsed = JSON.parse(typeof result === "string" ? result : (result as any).output)
    expect(parsed.status).toBe("ok")
    expect(parsed.active_phase).toBe("review")

    const st = readStateSync(wt)
    const tg = st.taskGroups.find((g: any) => g.id === "1")
    expect(tg.tasks.every((t: any) => t.status === "submitted")).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("所有 task 已 verified，不传 completed_task_ids → 提交成功", async () => {
    const root = `/tmp/guard-g21d-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    const state = readStateSync(wt)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/T.java"])

    // 先提交，让所有 task 变为 submitted
    await dev_submit.execute({ completed_task_ids: ["1", "2"] }, d)

    // 直接修改状态文件，将 task 标记为 verified
    const s2 = readStateSync(wt)
    const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
    tg2.tasks[0].status = "verified"
    tg2.tasks[1].status = "verified"
    const statePath = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
    writeFileSync(statePath, JSON.stringify(s2, null, 2))

    // 再次提交，不传 completed_task_ids → 应成功（所有 task 已 verified）
    fakeGit.diffs.set(devWt, ["src/T.java"])
    const result = await dev_submit.execute({}, d)
    const parsed = JSON.parse(typeof result === "string" ? result : (result as any).output)
    expect(parsed.status).toBe("ok")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("dev_submit 传入 self_check_results → 正确写入 state", async () => {
    const root = `/tmp/guard-g21e-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" }}, a)
    await set_worktree.execute({}, o)
    const state = readStateSync(wt)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/T.java"])

    const result = await dev_submit.execute({
      completed_task_ids: ["1", "2"],
      self_check_results: "lint: pass, typecheck: pass, tests: 42/42 passed"
    }, d)
    const parsed = JSON.parse(typeof result === "string" ? result : (result as any).output)
    expect(parsed.status).toBe("ok")

    const s2 = readStateSync(wt)
    const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.devSelfCheckResults).toBe("lint: pass, typecheck: pass, tests: 42/42 passed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})
