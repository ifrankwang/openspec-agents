/**
 * 编排 worktree 安全测试（新流单轨）：
 * - set_worktree 分支安全守卫（merge 失败 + 有本地提交 → 复用，无本地提交 → 清理重建）
 * - init recovery 对 worktree 引用的行为（新流 applyRecoveryState 仅重置阶段/tags，不清 worktree 资源）
 * - agent_submit(verify_quality) 双并发写锁（并行 reviewer 各自 verdict/issue 均保留，不丢 tag）
 * - 锁函数 acquire/release 与锁路径归一化
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
  init, set_worktree, agent_submit,
} from "../src/adapters/opencode/tools"
import { FakeGitRunner, makeCtx, setupWithFakeGit, teardown, readState } from "./helpers"
import { setupToAnalyze, driveToQuality, DIMENSION_AGENTS } from "./helpers-workflow"

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

/** 读当前 task WorkItem（workItems 单轨事实源；旧 findTg 读 taskGroups 已随 M1e-1 移除）。 */
function taskItemOf(wt: string): any {
  const state = readState(wt, CID)
  return state?.workItems?.find((w: any) => w.id === "task:1")
}

// ════════════════════════════════════════════════════════════════
//  Behavior 1: set_worktree 分支安全守卫
// ════════════════════════════════════════════════════════════════

describe("W1. set_worktree 分支安全守卫", () => {

  // W1.1 merge 失败 + 分支有本地提交 → 复用不删分支，baseRef 重算
  test("已有 worktree 分叉 + revListCount>0 → 复用不删分支", async () => {
    const root = `/tmp/wts-w1a-${Date.now()}`
    const { worktree: wt, fakeGit } = setupWithFakeGit(root, CID)
    try {
      const o = makeCtx("openspec-orchestrator", wt)

      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      const first = await set_worktree.execute({ change_id: CID }, o)
      expect(first).toContain("已创建 worktree")

      const existingPath = taskItemOf(wt).metadata["worktree_path"]
      fakeGit.forceMergeFailure = true
      fakeGit.revListCount = 5

      const second = await set_worktree.execute({ change_id: CID }, o)
      expect(second).toContain("复用已有 worktree")

      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(false)

      const item = taskItemOf(wt)
      expect(item.metadata["worktree_path"]).toBe(existingPath)
      expect(item.metadata["branch_name"]).toBe(`task-group/${CID}/1`)
      expect(item.metadata["base_ref"]).toBe(fakeGit.baseRef)
    } finally { teardown(root) }
  })

  // W1.2 merge 失败 + 分支无本地提交 → 删除重建
  test("已有 worktree 分叉 + revListCount=0 → 删除重建", async () => {
    const root = `/tmp/wts-w1b-${Date.now()}`
    const { worktree: wt, fakeGit } = setupWithFakeGit(root, CID)
    try {
      const o = makeCtx("openspec-orchestrator", wt)

      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      const first = await set_worktree.execute({ change_id: CID }, o)
      expect(first).toContain("已创建 worktree")

      const existingPath = taskItemOf(wt).metadata["worktree_path"]
      fakeGit.forceMergeFailure = true
      fakeGit.revListCount = 0

      const second = await set_worktree.execute({ change_id: CID }, o)
      expect(second).toContain("已创建 worktree")

      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(true)

      const item = taskItemOf(wt)
      expect(item.metadata["worktree_path"]).toBe(existingPath)
      expect(item.metadata["base_ref"]).toBe(fakeGit.baseRef)
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 2: init recovery 对 worktree 引用
// ════════════════════════════════════════════════════════════════

describe("W2. init recovery 对 worktree 引用", () => {

  // W2.1 recovery 到 dev_impl → 保留 worktree 引用
  test("recovery dev_impl → worktree_path/branch_name/base_ref 保留", async () => {
    const root = `/tmp/wts-w2a-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const o = makeCtx("openspec-orchestrator", wt)

      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await set_worktree.execute({ change_id: CID }, o)

      const orig = taskItemOf(wt)
      expect(orig.metadata["worktree_path"]).not.toBeNull()
      expect(orig.metadata["base_ref"]).not.toBeNull()

      await init.execute({
        change_id: CID, task_group_id: "1",
        recovery: { phase: "dev_impl" } }, o)

      const item = taskItemOf(wt)
      expect(item.metadata["worktree_path"]).toBe(orig.metadata["worktree_path"])
      expect(item.metadata["branch_name"]).toBe(orig.metadata["branch_name"])
      expect(item.metadata["base_ref"]).toBe(orig.metadata["base_ref"])
      // 阶段重置到 implement
      expect(item.phase).toBe("in_progress")
      expect(item.currentStep).toBe("implement")
    } finally { teardown(root) }
  })

  // W2.2 recovery 到 task_analysis → 阶段/tags 重置，worktree 引用保留
  test("recovery task_analysis → 阶段重置但 worktree 引用保留", async () => {
    const root = `/tmp/wts-w2b-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const o = makeCtx("openspec-orchestrator", wt)

      await init.execute({ change_id: CID, task_group_id: "1" }, o)
      await set_worktree.execute({ change_id: CID }, o)

      const orig = taskItemOf(wt)
      await init.execute({
        change_id: CID, task_group_id: "1",
        recovery: { phase: "task_analysis" } }, o)

      const item = taskItemOf(wt)
      // applyRecoveryState 仅重置阶段/tags/tasks，不清 worktree 资源
      expect(item.phase).toBe("todo")
      expect(item.currentStep).toBe("analyze")
      expect(item.metadata["worktree_path"]).toBe(orig.metadata["worktree_path"])
      expect(item.metadata["branch_name"]).toBe(orig.metadata["branch_name"])
      expect(item.metadata["base_ref"]).toBe(orig.metadata["base_ref"])
    } finally { teardown(root) }
  })
})

// ════════════════════════════════════════════════════════════════
//  Behavior 3: agent_submit(verify_quality) 并发写锁
// ════════════════════════════════════════════════════════════════

describe("W3. agent_submit(verify_quality) 并发写锁", () => {

  // W3.1 两个 quality reviewer 并行提交 passed → verdict 与 issue 均保留（不丢 tag）
  test("两个 quality reviewer 并行提交 → 各自 verdict 与 Info issue 均保留", async () => {
    const root = `/tmp/wts-w3a-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await driveToQuality(wt, CID)
      expect(taskItemOf(wt).currentStep).toBe("verify_quality")

      const [r1, r2] = await Promise.all([
        agent_submit.execute({
          change_id: CID, step_id: "verify_quality", verdict: "passed",
          new_children: [{ id: "7", title: "style", description: "Style 并发 issue", severity: "Info", source_phase: "quality", dimension: "style" }],
        }, ctx.dims["style"]),
        agent_submit.execute({
          change_id: CID, step_id: "verify_quality", verdict: "passed",
          new_children: [{ id: "8", title: "arch", description: "Arch 并发 issue", severity: "Info", source_phase: "quality", dimension: "architecture" }],
        }, ctx.dims["architecture"]),
      ])

      expect(r1).toContain("passed")
      expect(r2).toContain("passed")

      // 两个维度 verdict 均落盘，无丢失
      const item = taskItemOf(wt)
      expect(item.tags["verify_quality:openspec-reviewer-style"]).toBe("passed")
      expect(item.tags["verify_quality:openspec-reviewer-architecture"]).toBe("passed")
      // 两个 Info issue 均保留
      const descs = item.children.map((c: any) => c.description)
      expect(descs).toContain("Style 并发 issue")
      expect(descs).toContain("Arch 并发 issue")
    } finally { teardown(root) }
  })

  // W3.2 同一维度重复提交 verify_quality → 抛错
  test("同一维度重复提交 verify_quality → 抛错", async () => {
    const root = `/tmp/wts-w3b-${Date.now()}`
    const { worktree: wt } = setupWithFakeGit(root, CID)
    try {
      const ctx = await setupToAnalyze(wt, CID)
      await driveToQuality(wt, CID)

      const first = await agent_submit.execute(
        { change_id: CID, step_id: "verify_quality", verdict: "passed" },
        ctx.dims["style"]
      )
      expect(first).toContain("passed")

      await expect(
        agent_submit.execute({ change_id: CID, step_id: "verify_quality", verdict: "passed" }, ctx.dims["style"])
      ).rejects.toThrow(/不允许重复提交/)
    } finally { teardown(root) }
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
      workItems: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeState(worktreeDir, sampleState)
    expect(existsSync(join(mainRepo, ".opencode", ".orchestrate_state", `${CID}.json`))).toBe(true)
    expect(existsSync(join(worktreeDir, ".opencode", ".orchestrate_state", `${CID}.json`))).toBe(false)

    try { rmSync(base, { recursive: true, force: true }) } catch {}
  })
})
