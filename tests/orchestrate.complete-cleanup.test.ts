/**
 * 任务组收尾清理测试（opx_orch_complete_task_group 清理段）：
 * - 补救链物理成功：git worktree remove 失败时经文件系统兜底删除 + prune，分支正常删除，无残留警告
 * - 完全残留：目录被只读父目录锁死无法删除时，收尾不阻断（completed_at 照写），返回体给出残留警告区块
 *   与人工处理命令，metadata.cleanup_residual 落盘，且不执行 branch -D
 * - 无分支引用时仅做 worktree 侧清理：目录消失即成功，不执行 branch -D、无残留警告
 * - 收尾裸合并（worktreeless 底层命令）：成功推进双父合并提交且全程无 checkout、冲突零副作用
 *   （目标分支引用未动 + 人工合并指引文案）、已并入重试幂等（跳过合并提交直接收尾清理）
 * - 收尾合并检出检测：目标分支无人检出走 update-ref 原路径；主仓库检出且干净走真实 merge --no-ff
 *   （先 merge-tree 试算）；主仓库检出且有未提交改动、或被其它 linked worktree 检出 → blockedMessage
 *   且零 git 变更命令；试算冲突零副作用；真实 merge 失败时 merge --abort 兜底返回 conflict 形态
 *
 * 运行：bun test tests/orchestrate.complete-cleanup.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test"
import { chmodSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { __setGitRunner, mergeBranchToTarget } from "../src/core/git"
import { agent_submit, complete_task_group } from "../src/adapters/opencode/tools"
import {
  makeCtx, makeOrchCtx, setupWithFakeGit, teardown, initSimpleWorktree, readState,
  type FakeGitRunner,
} from "./helpers"

const CID = "cleanup-e2e"
const DEV = "openspec-developer"
const REVIEWER = "openspec-reviewer"

afterAll(() => { __setGitRunner(null) })

function fresh(): { root: string; wt: string; fakeGit: FakeGitRunner } {
  const root = `/tmp/cleanupe2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const { worktree: wt, fakeGit } = setupWithFakeGit(root, CID)
  return { root, wt, fakeGit }
}

function wtPathOf(wt: string): string {
  return join(wt, ".worktree", CID, "task-group-1")
}

/** 读当前 task WorkItem（落盘 JSON）。 */
function taskItemOf(wt: string): any {
  return readState(wt, CID)!.workItems.find((w: any) => w.id === "task:1")
}

function writeStateFile(wt: string, mutate: (item: any) => void): void {
  const statePath = join(wt, "openspec", "states", `${CID}.json`)
  const state = JSON.parse(readFileSync(statePath, "utf-8"))
  mutate(state.workItems.find((w: any) => w.id === "task:1"))
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

/** simple 模式推到 done：implement passed → quality_review passed（全任务验证）。 */
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

describe("收尾清理：git remove 失败的补救链", () => {

  test("failWorktreeRemove + 真实桩目录存在 → 兜底删除生效、prune 与删分支均执行、无残留警告", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      const path = wtPathOf(wt)
      // FakeGit 的 worktree add 已建目录；再补一个真实文件构成非空桩目录
      expect(existsSync(path)).toBe(true)
      writeFileSync(join(path, "marker.txt"), "stub")

      fakeGit.failWorktreeRemove = true
      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      // 收尾成功且带兜底补救说明，无残留警告
      expect(out).toContain("任务组已完成并合并到")
      expect(out).toContain("兜底删除")
      expect(out).not.toContain("清理残留")
      // 桩目录确实从磁盘消失，默认布局的两级空父目录一并清扫
      expect(existsSync(path)).toBe(false)
      expect(existsSync(join(wt, ".worktree", CID))).toBe(false)
      // callLog 含 prune 与 branch -D
      expect(fakeGit.callLog.some((l) => l.includes("worktree prune"))).toBe(true)
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(true)
      // completed_at 写入且无 cleanup_residual
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(taskItemOf(wt).metadata["cleanup_residual"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

describe("收尾清理：目录完全残留时不阻断收尾", () => {

  test("父目录只读使 fs 兜底删除也失败 → 残留警告区块 + cleanup_residual 落盘 + 不执行 branch -D", async () => {
    // chmod 权限语义仅 POSIX 有效
    if (process.platform === "win32") return

    const { root, wt, fakeGit } = fresh()
    const groupDir = join(wt, ".worktree", CID)
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      expect(existsSync(wtPathOf(wt))).toBe(true)
      // 锁死叶子目录的父目录，使 fs 兜底删除在最后一步 rmdir 时失败
      chmodSync(groupDir, 0o555)

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      // 收尾不被阻断：合并成功消息 + 残留警告区块 + 人工处理命令
      expect(out).toContain("任务组已完成并合并到")
      expect(out).toContain("worktree 清理残留")
      expect(out).toContain(`\`${wtPathOf(wt)}\``)
      expect(out).toContain("rm -rf")
      expect(out).toContain("git worktree prune")
      // 目录仍残留
      expect(existsSync(wtPathOf(wt))).toBe(true)

      // completed_at 已写入，残留信息落盘供人工排查
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(taskItemOf(wt).metadata["cleanup_residual"]["worktree_path"]).toBe(wtPathOf(wt))
      expect(Array.isArray(taskItemOf(wt).metadata["cleanup_residual"]["errors"])).toBe(true)
      expect(taskItemOf(wt).metadata["cleanup_residual"]["errors"].length).toBeGreaterThan(0)
      // 目录未消失 → 分支删除被跳过
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(false)
    } finally {
      try { chmodSync(groupDir, 0o755) } catch {}
      teardown(root)
    }
  })

  test("无 branch_name 时仅做 worktree 侧清理（目录消失即成功，不删分支）", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 清空分支引用：模拟仅剩 worktree 路径的收尾场景
      writeStateFile(wt, (item) => { item.metadata["branch_name"] = null })

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(out).toContain("任务组已完成并合并到")
      expect(out).toContain("兜底删除")
      expect(out).not.toContain("清理残留")
      // 分支删除不应出现（branch_name 为 null）
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(false)
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
      expect(taskItemOf(wt).metadata["cleanup_residual"]).toBeUndefined()
    } finally { teardown(root) }
  })
})

describe("收尾裸合并：worktreeless 底层命令（不触碰任何工作目录）", () => {

  test("合并成功：目标分支 tip 推进到双父合并提交，全程无 checkout 命令", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 主仓库检出非目标分支 → 目标分支无人检出，走 worktreeless 原路径
      fakeGit.currentBranch = "develop"
      fakeGit.branchOids.set("main", "target0000000000000000000000000000000001")
      fakeGit.branchOids.set(`task-group/${CID}/1`, "source000000000000000000000000000000001")

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(out).toContain("任务组已完成并合并到")
      // tip 推进到 commit-tree 生成的合并提交，CAS 旧值记录在案
      const mergeSha = fakeGit.commitShas[fakeGit.commitShas.length - 1]
      expect(fakeGit.branchOids.get("main")).toBe(mergeSha)
      expect(fakeGit.refUpdates).toEqual([
        { ref: "refs/heads/main", newOid: mergeSha, oldOid: "target0000000000000000000000000000000001" },
      ])
      // 合并提交为双父：目标分支旧 tip + 源分支 tip
      const mergeCommit = fakeGit.commitTreeCalls[fakeGit.commitTreeCalls.length - 1]
      expect(mergeCommit.parents).toEqual([
        "target0000000000000000000000000000000001",
        "source000000000000000000000000000000001",
      ])
      expect(fakeGit.mergeCommitBranches).toContain(`task-group/${CID}/1`)
      // 全程无 checkout（旧实现会先在主仓库 checkout 目标分支）
      expect(fakeGit.callSites.some((s) => s.args[0] === "checkout")).toBe(false)
    } finally { teardown(root) }
  })

  test("冲突零副作用：目标分支 tip 不动、无合并提交与 ref 推进，blocked 文案给人工合并指引", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      // 主仓库检出非目标分支 → 目标分支无人检出，merge-tree 试算冲突零副作用
      fakeGit.currentBranch = "develop"
      fakeGit.branchOids.set("main", "target0000000000000000000000000000000001")
      fakeGit.mergeTreeConflictOnNext = true

      const blocked = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(blocked).toContain("blocked")
      expect(blocked).toContain("merge_conflict")
      expect(blocked).toContain("未产生任何变更")
      expect(blocked).toContain(`git checkout main && git merge task-group/${CID}/1`)
      // 目标分支引用分毫未动：无合并提交、无 ref 推进
      expect(fakeGit.branchOids.get("main")).toBe("target0000000000000000000000000000000001")
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
      expect(fakeGit.callSites.some((s) => s.args[0] === "checkout")).toBe(false)
      // 冲突轮不写 completed_at，worktree 与分支保留
      expect(taskItemOf(wt).metadata["completed_at"]).toBeUndefined()
      expect(fakeGit.worktrees.has(wtPathOf(wt))).toBe(true)

      // dev 解决冲突并人工合并后重调：直接继续收尾
      const ok = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))
      expect(ok).toContain("任务组已完成并合并到")
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
    } finally { teardown(root) }
  })

  test("重试幂等：源分支已并入目标（is-ancestor 命中）→ 跳过合并提交，直接继续收尾清理", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      await initSimpleWorktree(wt, CID)
      await driveToDone(wt)
      fakeGit.sourceIsAncestor = true

      const out = await complete_task_group.execute({ change_id: CID }, makeOrchCtx(wt))

      expect(out).toContain("任务组已完成并合并到")
      // 未产生合并提交与 ref 推进（无空合并提交）
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
      expect(fakeGit.callLog.some((l) => l.includes("merge-tree"))).toBe(false)
      // 收尾清理照常执行
      expect(fakeGit.worktrees.has(wtPathOf(wt))).toBe(false)
      expect(fakeGit.callLog.some((l) => l.includes("branch -D"))).toBe(true)
      expect(taskItemOf(wt).metadata["completed_at"]).toBeDefined()
    } finally { teardown(root) }
  })
})

describe("收尾合并检出检测（mergeBranchToTarget 按目标分支检出状态分流）", () => {

  /** 无 git 变更动作命令（merge-tree/update-ref/commit-tree/merge 均不得出现）。 */
  function assertNoMutatingCommand(fakeGit: FakeGitRunner): void {
    for (const s of fakeGit.callSites) {
      expect(["merge-tree", "update-ref", "commit-tree", "merge"]).not.toContain(s.args[0])
    }
  }

  test("无人检出（主仓库检出非目标分支）→ worktreeless 原路径：commit-tree 双父 + update-ref CAS 推进", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.currentBranch = "develop"
      fakeGit.branchOids.set("main", "target0000000000000000000000000000000001")
      fakeGit.branchOids.set("feature", "source000000000000000000000000000000001")

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: true, conflict: false })
      const mergeSha = fakeGit.commitShas[fakeGit.commitShas.length - 1]
      expect(fakeGit.refUpdates).toEqual([
        { ref: "refs/heads/main", newOid: mergeSha, oldOid: "target0000000000000000000000000000000001" },
      ])
      expect(fakeGit.mergeCommitBranches).toContain("feature")
      expect(fakeGit.mergedBranches).toEqual([])
    } finally { teardown(root) }
  })

  test("主仓库检出且干净 → 先 merge-tree 试算再真实 merge --no-ff，不走 update-ref/commit-tree", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.branchOids.set("feature", "source000000000000000000000000000000001")

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: true, conflict: false })
      // 命令序列：merge-tree 试算先于真实 merge，真实 merge 以 --no-ff 携带源分支
      const mergeTreeIdx = fakeGit.callLog.findIndex((l) => l.includes("merge-tree"))
      const mergeIdx = fakeGit.callLog.findIndex((l) => l.startsWith("checked:merge "))
      expect(mergeTreeIdx).toBeGreaterThanOrEqual(0)
      expect(mergeIdx).toBeGreaterThan(mergeTreeIdx)
      expect(fakeGit.mergedBranches).toEqual(["feature"])
      // 真实合并路径不产生合并提交对象与分支指针 CAS 推进（由 git merge 自身推进）
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
    } finally { teardown(root) }
  })

  test("主仓库检出且有未提交改动 → blockedMessage、零 git 变更命令", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.dirtyPaths.add(wt)

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r.success).toBe(false)
      expect(r.conflict).toBe(false)
      expect(r.blockedMessage).toContain("commit 或 stash")
      expect(r.blockedMessage).toContain("`git merge feature`")
      assertNoMutatingCommand(fakeGit)
    } finally { teardown(root) }
  })

  test("其它 linked worktree 检出目标分支 → blockedMessage 带该工作树路径、零 git 变更命令", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      const userWt = "/tmp/user-owned-wt-checkout"
      fakeGit.currentBranch = "develop"
      fakeGit.worktrees.set(userWt, { branch: "main", path: userWt })

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r.success).toBe(false)
      expect(r.conflict).toBe(false)
      expect(r.blockedMessage).toContain(userWt)
      expect(r.blockedMessage).toContain("`git merge feature`")
      expect(r.blockedMessage).toContain(`\`git worktree remove ${userWt}\``)
      assertNoMutatingCommand(fakeGit)
    } finally { teardown(root) }
  })

  test("主仓库检出且干净但 merge-tree 冲突 → 零副作用返回 conflict，不执行真实 merge", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.mergeTreeConflictOnNext = true

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: false, conflict: true })
      expect(fakeGit.mergedBranches).toEqual([])
      expect(fakeGit.commitShas.length).toBe(0)
      expect(fakeGit.refUpdates.length).toBe(0)
    } finally { teardown(root) }
  })

  test("真实 merge 失败（竞态）→ merge --abort 兜底后按 conflict 形态返回", async () => {
    const { root, wt, fakeGit } = fresh()
    try {
      fakeGit.forceMergeFailure = true

      const r = await mergeBranchToTarget(wt, "feature", "main")

      expect(r).toEqual({ success: false, conflict: true })
      expect(fakeGit.callLog.some((l) => l.includes("merge --abort"))).toBe(true)
      expect(fakeGit.refUpdates.length).toBe(0)
    } finally { teardown(root) }
  })
})
