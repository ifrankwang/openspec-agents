/**
 * change 分支模型场景测试（每 change 一条分支 + 常驻 worktree）：
 * - scope 端点：scope_start_oid 仅 item 首次绑定记录（重调不重记；已记 oid 不在分支历史才重记）、
 *   complete 在勾选提交后记录 scope_end_oid、切组后新组记新端点且旧组端点不被改写
 * - 复用校验：worktree 仅 openspec 文档脏 → 自动 commit 兜底后复用（代码文件脏拒绝见 orchestrate.guards）
 * - 升级路径：在途旧模型会话（state 携带 task-group 分支引用）调 set_worktree → change 分支不存在时
 *   从当前基准分支 tip create-or-reuse（不检出），state 重新绑定 change 分支
 * - 并发 complete：全程文件锁串行化，后到者命中阶段门禁而非并发丢状态
 *
 * 运行：bun test tests/orchestrate.change-model.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner } from "../src/core/git"
import { init, set_worktree, status, complete_task_group, agent_submit } from "../src/adapters/opencode/tools"
import {
  makeCtx, makeOrchCtx, setupWithFakeGit, teardown, initSimpleWorktree, readState,
  type FakeGitRunner,
} from "./helpers"

const CID = "change-model"
const DEV = "openspec-developer"
const REVIEWER = "openspec-reviewer"

afterAll(() => { __setGitRunner(null) })

function fresh(): { root: string; wt: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/changemodel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree: wt, fakeGit } = setupWithFakeGit(root, CID)
  return { root, wt, fakeGit }
}

function wtPathOf(wt: string): string {
  return join(wt, ".worktree", CID, "ws")
}

function taskItemOf(wt: string, groupId = "1"): any {
  return readState(wt, CID)!.workItems.find((w: any) => w.id === `task:${groupId}`)
}

/** simple 模式推到 done。 */
async function driveToDone(wt: string): Promise<void> {
  await agent_submit.execute(
    { change_id: CID, step_id: "implement", verdict: "passed", completed_task_ids: ["1", "2", "3"] },
    makeCtx(DEV, wt),
  )
  await agent_submit.execute(
    { change_id: CID, step_id: "quality_review", verdict: "passed", verified_tasks: ["1", "2", "3"] },
    makeCtx(REVIEWER, wt),
  )
}

describe("scope 端点记录", () => {

  test("首次 set_worktree 记录 scope_start；complete 在勾选提交后记录 scope_end", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.branchOids.set(`change/${CID}`, "scope-start-1")
      await initSimpleWorktree(wt, CID)
      const item = taskItemOf(wt)
      expect(item.metadata["scope_start_oid"]).toBe("scope-start-1")
      // base_ref 存 scope 端点（变更范围/diff 锚点消费同源）
      expect(item.metadata["base_ref"]).toBe("scope-start-1")

      await driveToDone(wt)
      // 勾选提交使 change 分支前进：advance 分支 tip 后收口
      fakeGit.branchOids.set(`change/${CID}`, "scope-end-1")
      fakeGit.currentBranch = "develop"
      await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(taskItemOf(wt).metadata["scope_end_oid"]).toBe("scope-end-1")
    } finally { teardown(root) }
  })

  test("重调 set_worktree 不重记（已记 oid 在分支历史内）；oid 不在历史时才重记", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.branchOids.set(`change/${CID}`, "scope-start-1")
      await initSimpleWorktree(wt, CID)
      expect(taskItemOf(wt).metadata["scope_start_oid"]).toBe("scope-start-1")

      // 分支前进（本任务组实施提交）：重调 set_worktree 时 start 已在分支历史（桩配置为祖先）→ 不重记
      fakeGit.branchOids.set(`change/${CID}`, "scope-tip-2")
      fakeGit.isAncestorPairs.set("scope-start-1 change/" + CID, true)
      await set_worktree.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(taskItemOf(wt).metadata["scope_start_oid"]).toBe("scope-start-1")

      // 分支重建场景：已记 oid 不在当前分支历史 → 允许重记为当前分支 tip
      fakeGit.isAncestorPairs.set("scope-start-1 change/" + CID, false)
      await set_worktree.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(taskItemOf(wt).metadata["scope_start_oid"]).toBe("scope-tip-2")
    } finally { teardown(root) }
  })

  test("切组后新组记录新 scope_start（含前组提交），前组端点不被改写", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.branchOids.set(`change/${CID}`, "scope-g1")
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 组 2 已激活 → 组 1 非最后组：完成不合并、不销毁
      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const raw = JSON.parse(readFileSync(statePath, "utf-8"))
      const g2 = raw.workItems.find((w: any) => w.id === "task:2")
      g2.tags["implement:openspec-developer"] = "pending"
      g2.children[0].phase = "in_progress"
      const { writeFileSync } = await import("node:fs")
      writeFileSync(statePath, JSON.stringify(raw, null, 2))
      await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(taskItemOf(wt, "1").metadata["scope_start_oid"]).toBe("scope-g1")

      // 切组：init 组 2 + set_worktree → 复用同一 worktree 与分支，新组记录新端点
      fakeGit.branchOids.set(`change/${CID}`, "scope-g2")
      await init.execute({ change_id: CID, task_group_id: "2", mode: "simple" }, makeOrchCtx(wt))
      await set_worktree.execute({ change_id: CID }, makeOrchCtx(wt))

      const g1 = taskItemOf(wt, "1")
      const g2Item = taskItemOf(wt, "2")
      expect(g1.metadata["scope_start_oid"]).toBe("scope-g1") // 旧组端点不改写
      expect(g2Item.metadata["scope_start_oid"]).toBe("scope-g2") // 新组新端点
      // 常驻 worktree：两组写相同值
      expect(g2Item.metadata["worktree_path"]).toBe(g1.metadata["worktree_path"])
      expect(g2Item.metadata["worktree_path"]).toBe(wtPathOf(wt))
      expect(g2Item.metadata["branch_name"]).toBe(`change/${CID}`)
      expect(existsSync(wtPathOf(wt))).toBe(true)
    } finally { teardown(root) }
  })
})

describe("复用校验与升级路径", () => {

  test("worktree 仅 openspec 文档脏 → 自动 commit 兜底后复用", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      const wsPath = wtPathOf(wt)
      fakeGit.worktreeOpenspecDirty.add(wsPath)
      fakeGit.callLog.length = 0

      const out = await set_worktree.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(out).toContain("复用已有 worktree")
      // add + commit 落在 worktree 目录（与主仓库侧 auto-commit 对称）
      expect(fakeGit.callSites.some((s) => s.dir === wsPath && s.args[0] === "add")).toBe(true)
      expect(fakeGit.callSites.some((s) => s.dir === wsPath && s.args[0] === "commit")).toBe(true)
      // 脏状态随提交清除（FakeGit 真实行为模拟）
      expect(fakeGit.worktreeOpenspecDirty.has(wsPath)).toBe(false)
    } finally { teardown(root) }
  })

  test("升级路径：change 分支不存在（在途旧模型会话）→ set_worktree 从当前基准 tip create-or-reuse", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      // 模拟旧模型在途会话：change 分支缺失、change worktree 不存在（旧模型只有 task-group worktree）、
      // metadata 残留 task-group 引用
      fakeGit.localBranches.delete(`change/${CID}`)
      fakeGit.worktrees.delete(wtPathOf(wt))
      const { rmSync } = await import("node:fs")
      rmSync(wtPathOf(wt), { recursive: true, force: true })
      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const raw = JSON.parse(readFileSync(statePath, "utf-8"))
      const item = raw.workItems.find((w: any) => w.id === "task:1")
      item.metadata["branch_name"] = `task-group/${CID}/1`
      const { writeFileSync } = await import("node:fs")
      writeFileSync(statePath, JSON.stringify(raw, null, 2))

      const out = await set_worktree.execute({ change_id: CID }, makeOrchCtx(wt))

      // change 分支从当前基准 tip 重建（天然含已合入代码），state 重新绑定 change 模型引用
      expect(out).toContain("已创建 worktree")
      expect(fakeGit.localBranches.has(`change/${CID}`)).toBe(true)
      const rebound = taskItemOf(wt)
      expect(rebound.metadata["branch_name"]).toBe(`change/${CID}`)
      expect(rebound.metadata["worktree_path"]).toBe(wtPathOf(wt))
      expect(rebound.metadata["scope_start_oid"]).toBe(fakeGit.defaultBranchOid)
    } finally { teardown(root) }
  })

  test("终态视图分流：非最后组完成后文案不得误导为已收尾", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      const statePath = join(wt, "openspec", "states", `${CID}.json`)
      const raw = JSON.parse(readFileSync(statePath, "utf-8"))
      const g2 = raw.workItems.find((w: any) => w.id === "task:2")
      g2.tags["implement:openspec-developer"] = "pending"
      g2.children[0].phase = "in_progress"
      const { writeFileSync } = await import("node:fs")
      writeFileSync(statePath, JSON.stringify(raw, null, 2))
      await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      const out = await status.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(out).toContain("本任务组已完成，变更保留在 change 分支上")
      expect(out).not.toContain("编排已完成并收尾")
      expect(out).not.toContain("已合并回基准分支")
    } finally { teardown(root) }
  })
})

describe("并发 complete：文件锁串行化", () => {

  test("两个 complete 并发调用 → 仅一次收口成功，后到者命中阶段门禁（completed_at 已写）", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      fakeGit.currentBranch = "develop" // worktreeless 合并路径，update-ref 断言可见

      const results = await Promise.allSettled([
        complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt)),
        complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt)),
      ])

      const fulfilled = results.filter((r) => r.status === "fulfilled")
      const rejected = results.filter((r) => r.status === "rejected")
      expect(fulfilled.length).toBe(1)
      expect(rejected.length).toBe(1)
      // 后到者命中阶段门禁而非并发丢状态
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error)
      expect(((rejected[0] as PromiseRejectedResult).reason as Error).message).toMatch(/阶段顺序错误/)
      // 成功者完成收口：completed_at 写入、合并恰好一次、worktree 清理
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(fakeGit.refUpdates.length).toBe(1)
      expect(existsSync(wtPathOf(wt))).toBe(false)
    } finally { teardown(root) }
  })
})
