/**
 * 编排 worktree 安全测试：
 * - set_worktree 分支安全守卫（merge 失败 + 有本地提交 → 复用，无本地提交 → 清理重建）
 * - init recovery 条件清空 worktree 引用（仅 task_analysis 清空，dev_impl 保留）
 * - quality_review_submit 并发写锁（并行 reviewer 各自 issue/verdict 均保留）
 *
 * 运行：bun test
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { acquireLock, releaseLock, getLockPath, writeState } from "../src/core/state"
import type { OrchestrateState } from "../src/core/types"
import {
  init, set_worktree, arch_submit, dev_submit,
  tool_review_submit, task_review_submit, quality_review_submit
} from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-wtsafe"
afterAll(() => { __setGitRunner(null) })

function freshWt(root: string): string {
  const id = `wts-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = join(root, id, "w")
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n\n## 2. G2\n\n- [ ] 2.1 T3\n`,
    "utf-8"
  )
  return wt
}

function readStateSync(wt: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

function findTg(wt: string): any {
  return readStateSync(wt).taskGroups.find((g: any) => g.id === "1")
}

/** init → arch_submit → set_worktree → dev_submit → recovery review → tool/task 通过（review 就绪） */
async function setupThroughReviewReady(wt: string, fakeGit: FakeGitRunner): Promise<void> {
  const o = makeCtx("openspec-orchestrator", wt)
  const a = makeCtx("openspec-architect", wt)
  const d = makeCtx("openspec-developer", wt)
  const toolR = makeCtx("openspec-reviewer-tool", wt)
  const taskR = makeCtx("openspec-reviewer-task", wt)

  await init.execute({ change_id: CID, task_group_id: "1" }, o)
  await arch_submit.execute({ change_id: CID, outcome: "ready",
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } }, a)
  await set_worktree.execute({ change_id: CID }, o)
  const devWt = findTg(wt).worktreePath
  fakeGit.diffs.set(devWt, ["src/F1.java"])
  await dev_submit.execute({ change_id: CID, completed_task_ids: ["1", "2"] }, d)

  await init.execute({ change_id: CID, task_group_id: "1", recovery: { phase: "review" } }, o)
  await set_worktree.execute({ change_id: CID }, o)
  await tool_review_submit.execute({ change_id: CID, passed: true, issues: [], fixed_issue_ids: [] }, toolR)
  await task_review_submit.execute({ change_id: CID, passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
}

// ════════════════════════════════════════════════════════════════
//  Behavior 1: set_worktree 分支安全守卫
// ════════════════════════════════════════════════════════════════

describe("W1. set_worktree 分支安全守卫", () => {

  // W1.1 merge 失败 + 分支有本地提交 → 复用不删分支，baseRef/lastFilesChanged 重算
  test("已有 worktree 分叉 + revListCount>0 → 复用不删分支", async () => {
    const root = `/tmp/wts-w1a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const first = await set_worktree.execute({ change_id: CID }, o)
    expect(first).toContain("已创建 worktree")

    const existingPath = findTg(wt).worktreePath
    fakeGit.forceMergeFailure = true
    fakeGit.revListCount = 5
    fakeGit.diffs.set(existingPath, ["src/impl.java"])

    const second = await set_worktree.execute({ change_id: CID }, o)
    expect(second).toContain("复用已有 worktree")

    expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(false)

    const tg = findTg(wt)
    expect(tg.worktreePath).toBe(existingPath)
    expect(tg.branchName).toBe(`task-group/${CID}/1`)
    expect(tg.baseRef).toBe(fakeGit.baseRef)
    expect(tg.lastFilesChanged).toEqual(["src/impl.java"])

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // W1.2 merge 失败 + 分支无本地提交 → 删除重建
  test("已有 worktree 分叉 + revListCount=0 → 删除重建", async () => {
    const root = `/tmp/wts-w1b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    const first = await set_worktree.execute({ change_id: CID }, o)
    expect(first).toContain("已创建 worktree")

    const existingPath = findTg(wt).worktreePath
    fakeGit.forceMergeFailure = true
    fakeGit.revListCount = 0

    const second = await set_worktree.execute({ change_id: CID }, o)
    expect(second).toContain("已创建 worktree")

    expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(true)

    const tg = findTg(wt)
    expect(tg.worktreePath).toBe(existingPath)
    expect(tg.baseRef).toBe(fakeGit.baseRef)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 2: init recovery 条件清空 worktree 引用
// ════════════════════════════════════════════════════════════════

describe("W2. init recovery 条件清空 worktree 引用", () => {

  // W2.1 recovery 到 dev_impl → 保留原 worktree 引用
  test("recovery dev_impl → worktreePath/branchName/baseRef 保留", async () => {
    const root = `/tmp/wts-w2a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
      makeCtx("openspec-architect", wt))
    await set_worktree.execute({ change_id: CID }, o)

    const orig = findTg(wt)
    expect(orig.worktreePath).not.toBeNull()
    expect(orig.baseRef).not.toBeNull()

    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "dev_impl" } }, o)

    const tg = findTg(wt)
    expect(tg.worktreePath).toBe(orig.worktreePath)
    expect(tg.branchName).toBe(orig.branchName)
    expect(tg.baseRef).toBe(orig.baseRef)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // W2.2 recovery 到 task_analysis → 仍清空 worktree 引用
  test("recovery task_analysis → worktreePath/branchName/baseRef 清空", async () => {
    const root = `/tmp/wts-w2b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, task_group_id: "1" }, o)
    await arch_submit.execute({ change_id: CID, outcome: "ready",
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } },
      makeCtx("openspec-architect", wt))
    await set_worktree.execute({ change_id: CID }, o)

    await init.execute({
      change_id: CID, task_group_id: "1",
      recovery: { phase: "task_analysis" } }, o)

    const tg = findTg(wt)
    expect(tg.worktreePath).toBeNull()
    expect(tg.branchName).toBeNull()
    expect(tg.baseRef).toBeNull()
    expect(tg.lastFilesChanged).toEqual([])

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 3: quality_review_submit 并发写锁
// ════════════════════════════════════════════════════════════════

describe("W3. quality_review_submit 并发写锁", () => {

  // W3.1 两个 quality reviewer 并行提交 → 各自维度 verdict 和 issue 均保留
  test("两个 quality reviewer 并行提交 → verdict 与 issue 均保留", async () => {
    const root = `/tmp/wts-w3a-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupThroughReviewReady(wt, fakeGit)

    const styleCtx = makeCtx("openspec-reviewer-style", wt)
    const archCtx = makeCtx("openspec-reviewer-architecture", wt)

    const [r1, r2] = await Promise.all([
      quality_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ severity: "Low", file: "src/style.java", line: 1, description: "Style 并发 issue", suggestion: "修 style" }],
        fixed_issue_ids: [] }, styleCtx),
      quality_review_submit.execute({ change_id: CID, passed: false,
        issues: [{ severity: "Low", file: "src/arch.java", line: 1, description: "Arch 并发 issue", suggestion: "修 arch" }],
        fixed_issue_ids: [] }, archCtx),
    ])

    expect(r1).toContain("已提交")
    expect(r2).toContain("已提交")

    const tg = findTg(wt)
    expect(tg.phases.review.quality.progress.style).toBe("failed")
    expect(tg.phases.review.quality.progress.architecture).toBe("failed")
    const descs = tg.issues.map((i: any) => i.description)
    expect(descs).toContain("Style 并发 issue")
    expect(descs).toContain("Arch 并发 issue")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  // W3.2 持锁期间重复提交同一维度 → 抛错
  test("同一维度重复提交 → 抛错", async () => {
    const root = `/tmp/wts-w3b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    await setupThroughReviewReady(wt, fakeGit)

    const styleCtx = makeCtx("openspec-reviewer-style", wt)
    const first = await quality_review_submit.execute({ change_id: CID, passed: true, issues: [] }, styleCtx)
    expect(first).toContain("已提交")

    await expect(
      quality_review_submit.execute({ change_id: CID, passed: true, issues: [] }, styleCtx)
    ).rejects.toThrow(/不允许重复提交/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 4: 锁函数 acquire/release
// ════════════════════════════════════════════════════════════════

describe("W4. 锁函数 acquire/release", () => {
  test("acquire → 并发 acquire 超时 → release 后可重新 acquire", async () => {
    const lockPath = join("/tmp", `wts-lock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)

    await acquireLock(lockPath)
    await expect(acquireLock(lockPath, 200)).rejects.toThrow(/超时/)
    releaseLock(lockPath)

    await acquireLock(lockPath)
    releaseLock(lockPath)

    try { rmSync(lockPath, { recursive: true, force: true }) } catch {}
  })

  // W4.2 存活锁（age < stale 阈值）不被清理，仍按超时拒绝
  test("存活锁不被 stale 清理 → 按超时拒绝", async () => {
    const lockPath = join("/tmp", `wts-alive-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)

    await acquireLock(lockPath)
    await expect(acquireLock(lockPath, 200)).rejects.toThrow(/超时/)

    const meta = JSON.parse(readFileSync(join(lockPath, "meta.json"), "utf-8"))
    expect(meta.pid).toBe(process.pid)
    releaseLock(lockPath)

    try { rmSync(lockPath, { recursive: true, force: true }) } catch {}
  })

  // W4.3 stale 锁（age ≥ stale 阈值）被自动清理并重新获取，meta 更新为当前持有者
  test("stale 锁超时后自动清理并可重新获取", async () => {
    const lockPath = join("/tmp", `wts-stale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(
      join(lockPath, "meta.json"),
      JSON.stringify({ pid: 99999, acquiredAt: Date.now() - 60000 })
    )

    await acquireLock(lockPath, 200)

    const meta = JSON.parse(readFileSync(join(lockPath, "meta.json"), "utf-8"))
    expect(meta.pid).toBe(process.pid)
    releaseLock(lockPath)

    try { rmSync(lockPath, { recursive: true, force: true }) } catch {}
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 5: 锁路径与 state 写入目录归一化一致
// ════════════════════════════════════════════════════════════════

describe("W5. 锁路径 worktree 归一化", () => {
  test("getLockPath 对 worktree 与非 worktree 返回同一目录，且与 writeState 目标一致", async () => {
    const base = join("/tmp", `wts-lockpath-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    const mainRepo = join(base, "main")
    const worktreeDir = join(base, "worktree")
    mkdirSync(join(mainRepo, ".git", "worktrees", "wt"), { recursive: true })
    mkdirSync(worktreeDir, { recursive: true })
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${join(mainRepo, ".git", "worktrees", "wt")}`)

    const fromMain = await getLockPath(mainRepo, CID)
    const fromWorktree = await getLockPath(worktreeDir, CID)
    expect(fromWorktree).toBe(fromMain)
    expect(fromMain).toBe(join(mainRepo, ".opencode", ".orchestrate_state", `${CID}.review.lock`))

    const sampleState: OrchestrateState = {
      changeId: CID,
      isolationNamespace: "a1b2c3",
      taskGroupId: "1",
      baseBranch: "main",
      taskGroups: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeState(worktreeDir, sampleState)
    expect(existsSync(join(mainRepo, ".opencode", ".orchestrate_state", `${CID}.json`))).toBe(true)
    expect(existsSync(join(worktreeDir, ".opencode", ".orchestrate_state", `${CID}.json`))).toBe(false)

    try { rmSync(base, { recursive: true, force: true }) } catch {}
  })
})
